// Casa & Risparmio — Cloudflare Worker
//
// Punto d'ingresso: si occupa solo di routing. La logica vive in api/lib/*:
//   lib/http.js         CORS / risposte JSON
//   lib/text.js          parsing testo (titoli, prezzi, HTML)
//   lib/amazon-url.js    riconoscimento link/ASIN Amazon
//   lib/offers.js        ordinamento/dedup offerte + lettura/scrittura KV
//   lib/telegram.js      Bot API, messaggio -> offerta, seed storico canale
//   lib/amazon-api.js    Amazon Creators API (GetItems/GetVariations/SearchItems)
//   lib/onesignal.js     push notification
//   lib/gemini.js         generazione articolo (Gemini API)
//   lib/articles.js       lettura/scrittura articoli (pubblicati + bozze) su KV

import { cors, json } from "./lib/http.js";
import { readOffers, writeOffers } from "./lib/offers.js";
import { CHANNEL_USERNAME, fromMessage, seed, sendMessage, syncNewOffers, telegram, telegramArticlesBot } from "./lib/telegram.js";
import {
  creatorsGetItemDetailed,
  creatorsGetVariations,
  creatorsSearchSimilar,
  enrich,
  productDataForArticle
} from "./lib/amazon-api.js";
import { asinFromUrl, extractAmazonLinks, resolveAmazonLink } from "./lib/amazon-url.js";
import { notify, notifyArticle } from "./lib/onesignal.js";
import { generateArticle } from "./lib/gemini.js";
import { publishArticle, readArticles, savePendingDraft, takePendingDraft } from "./lib/articles.js";

function authorisedSetup(url, env) {
  return env.SETUP_KEY && url.searchParams.get("key") === env.SETUP_KEY;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Prepara UNA bozza di articolo a partire da un singolo link Amazon e la
 * invia in chat come anteprima con i bottoni "Pubblica"/"Scarta". Non
 * lancia mai: ogni errore diventa un messaggio Telegram leggibile, così un
 * link Amazon quando 5 link diversi in un solo messaggio, gli altri 4
 * continuano ad essere processati anche se uno fallisce.
 */
async function draftArticleFromLink(env, chatId, link) {
  try {
    let asin = asinFromUrl(link);
    let resolved = link;

    if (!asin) {
      resolved = await resolveAmazonLink(link);
      asin = asinFromUrl(resolved);
    }

    if (!asin) {
      await sendMessage(env, chatId, `⚠️ Non trovo l'ASIN in questo link:\n${link}`);
      return;
    }

    const item = await creatorsGetItemDetailed(env, asin);
    if (!item) {
      await sendMessage(
        env,
        chatId,
        `⚠️ Amazon Creators API non ha restituito dati per <code>${asin}</code>. Controlla le credenziali Amazon nel Worker o riprova tra poco.`
      );
      return;
    }

    const product = productDataForArticle(item, { asin, link_affiliato: resolved });
    const draft = await generateArticle(env, product);

    const id = crypto.randomUUID().slice(0, 8);
    const record = {
      id,
      asin,
      titolo: draft.titolo,
      estratto: draft.estratto,
      corpo_html: draft.corpo_html,
      immagine_url: product.immagine_url || "",
      link_affiliato: product.link_affiliato || resolved
    };

    await savePendingDraft(env, record);

    const preview =
      `<b>${escapeHtml(record.titolo)}</b>\n\n${escapeHtml(record.estratto)}\n\n` +
      `<i>Bozza pronta (${record.corpo_html.replace(/<[^>]+>/g, "").length} caratteri nel corpo). Approva per pubblicarla sul sito.</i>`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Pubblica", callback_data: `art_pub:${id}` },
          { text: "❌ Scarta", callback_data: `art_del:${id}` }
        ]
      ]
    };

    if (record.immagine_url) {
      await telegramArticlesBot(env, "sendPhoto", {
        chat_id: chatId,
        photo: record.immagine_url,
        caption: preview,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      }).catch(() =>
        // Se l'immagine non è raggiungibile da Telegram, mandiamo comunque
        // il testo: meglio una bozza senza foto che nessuna bozza.
        telegramArticlesBot(env, "sendMessage", {
          chat_id: chatId,
          text: preview,
          parse_mode: "HTML",
          reply_markup: replyMarkup
        })
      );
    } else {
      await telegramArticlesBot(env, "sendMessage", {
        chat_id: chatId,
        text: preview,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      });
    }
  } catch (error) {
    console.error("Bozza articolo error:", error);
    await sendMessage(env, chatId, `⚠️ Errore nella generazione dell'articolo per ${link}:\n${error.message}`);
  }
}

/**
 * Gestisce i messaggi privati inviati al bot (non i post del canale).
 * Solo l'ID Telegram configurato in ADMIN_TELEGRAM_ID può generare
 * articoli; chiunque altro (o l'admin stesso, prima di aver impostato la
 * variabile) riceve semplicemente il proprio ID, comodo per la prima
 * configurazione.
 */
const HELP_TEXT = [
  "<b>Casa & Risparmio — bot articoli</b>",
  "",
  "Mandami uno o più link Amazon (anche amzn.to, anche più di uno nello stesso messaggio): per ciascuno preparo una bozza di articolo con titolo, estratto e testo, basata sui dati veri del prodotto.",
  "",
  "Sotto ogni bozza trovi due bottoni:",
  "✅ <b>Pubblica</b> — l'articolo va online sul sito e parte la notifica push",
  "❌ <b>Scarta</b> — la bozza viene cancellata, nessun effetto sul sito",
  "",
  "Comandi:",
  "/start oppure /help — rivede questo messaggio"
].join("\n");

async function handleAdminMessage(message, env) {
  const chatId = message.chat.id;
  const adminId = env.ADMIN_TELEGRAM_ID ? String(env.ADMIN_TELEGRAM_ID) : "";

  if (!adminId || String(chatId) !== adminId) {
    await sendMessage(
      env,
      chatId,
      `Il tuo ID Telegram è <code>${chatId}</code>.\nImpostalo come variabile <b>ADMIN_TELEGRAM_ID</b> nel Worker per poter generare articoli da qui.`
    );
    return;
  }

  const text = (message.text || message.caption || "").trim();

  if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) {
    await sendMessage(env, chatId, HELP_TEXT);
    return;
  }

  const links = extractAmazonLinks(text);

  if (!links.length) {
    await sendMessage(
      env,
      chatId,
      "Non trovo link Amazon in questo messaggio. Mandami uno o più link (anche amzn.to) oppure scrivi /help per vedere come funziono."
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    `Ricevuto${links.length > 1 ? "i" : ""} ${links.length} link. Preparo ${links.length === 1 ? "la bozza" : "le bozze"}, un attimo...`
  );

  // In sequenza (non in parallelo): sia Amazon che Gemini hanno limiti di
  // frequenza, e con pochi link al minuto va benissimo così.
  for (const link of links) {
    // "sta scrivendo..." mentre generiamo la bozza: senza questo, per
    // qualche secondo (chiamata Amazon + chiamata Gemini) la chat resta
    // silenziosa e può sembrare bloccata. Non è critico se fallisce.
    await telegramArticlesBot(env, "sendChatAction", { chat_id: chatId, action: "upload_photo" }).catch(() => {});
    await draftArticleFromLink(env, chatId, link);
  }
}

/**
 * Gestisce il tap su "Pubblica"/"Scarta" sotto l'anteprima di una bozza.
 * takePendingDraft() legge E rimuove la bozza in un solo passaggio, quindi
 * un secondo tap sullo stesso messaggio trova semplicemente "bozza non
 * trovata" invece di pubblicare/notificare due volte.
 */
async function handleAdminCallback(callbackQuery, env) {
  const adminId = env.ADMIN_TELEGRAM_ID ? String(env.ADMIN_TELEGRAM_ID) : "";
  const fromId = String(callbackQuery.from?.id || "");

  if (!adminId || fromId !== adminId) {
    await telegramArticlesBot(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Non autorizzato." });
    return;
  }

  const [action, id] = String(callbackQuery.data || "").split(":");
  const draft = await takePendingDraft(env, id);

  if (!draft) {
    await telegramArticlesBot(env, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: "Bozza non trovata (forse già gestita)."
    });
    return;
  }

  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;

  // editMessageCaption funziona solo se il messaggio originale aveva una
  // foto (sendPhoto), editMessageText solo se era testo semplice
  // (sendMessage): non sappiamo qui quale dei due sia stato usato, quindi
  // proviamo il primo e ripieghiamo sul secondo.
  async function closeMessage(label) {
    if (!chatId || !messageId) return;
    await telegramArticlesBot(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
    await telegramArticlesBot(env, "editMessageCaption", { chat_id: chatId, message_id: messageId, caption: label }).catch(() =>
      telegramArticlesBot(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: label }).catch(() => {})
    );
  }

  if (action === "art_pub") {
    const article = {
      id: draft.id,
      asin: draft.asin,
      titolo: draft.titolo,
      estratto: draft.estratto,
      corpo_html: draft.corpo_html,
      immagine_url: draft.immagine_url,
      link_affiliato: draft.link_affiliato,
      data_pubblicazione: new Date().toISOString()
    };

    await publishArticle(env, article);
    await notifyArticle(env, article);
    await telegramArticlesBot(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Pubblicato ✅" });
    await closeMessage(`✅ Pubblicato: ${draft.titolo}`);
    return;
  }

  if (action === "art_del") {
    await telegramArticlesBot(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Scartato" });
    await closeMessage(`❌ Scartato: ${draft.titolo}`);
    return;
  }

  // Azione sconosciuta: rimettiamo la bozza dov'era, per non perderla.
  await savePendingDraft(env, draft);
  await telegramArticlesBot(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "Azione non riconosciuta." });
}

/**
 * Webhook del bot ARTICOLI (chat privata con l'admin): messaggi con i link
 * da trasformare in bozze, e i tap sui bottoni Pubblica/Scarta. Endpoint e
 * secret separati dal webhook del canale perché è un bot Telegram diverso,
 * con un suo token (ARTICLES_BOT_TOKEN) e un suo webhook secret
 * (ARTICLES_WEBHOOK_SECRET) — due bot Telegram non possono condividere lo
 * stesso webhook.
 */
async function handleArticlesWebhook(request, env) {
  if (
    !env.ARTICLES_WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.ARTICLES_WEBHOOK_SECRET
  ) {
    return new Response("", { status: 401 });
  }

  try {
    const update = await request.json();

    if (update.callback_query) {
      await handleAdminCallback(update.callback_query, env);
    } else if (update.message && update.message.chat?.type === "private") {
      await handleAdminMessage(update.message, env);
    }

    return new Response("ok");
  } catch (error) {
    console.error("Articles webhook error:", error);
    return new Response("ok");
  }
}

async function handleTelegramWebhook(request, env, origin) {
  if (
    !env.TELEGRAM_WEBHOOK_SECRET ||
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("", { status: 401 });
  }

  try {
    const update = await request.json();

    const message = update.channel_post || update.edited_channel_post || null;

    if (!message) return new Response("ok");

    if (
      message.chat?.username &&
      message.chat.username.toLowerCase() !== CHANNEL_USERNAME.toLowerCase()
    ) {
      console.log("Webhook ignorato: canale non corrispondente ->", message.chat.username);
      return new Response("ok");
    }

    let offer = fromMessage(message);

    if (!offer) {
      console.log("Webhook ignorato: nessun link Amazon riconosciuto", {
        message_id: message.message_id,
        data: message.date ? new Date(message.date * 1000).toISOString() : null,
        ha_text: Boolean(message.text),
        ha_caption: Boolean(message.caption),
        anteprima_testo: (message.text || message.caption || "").slice(0, 120),
        entities: (message.entities || message.caption_entities || []).map(e => e.type),
        ha_tastiera: Boolean(message.reply_markup?.inline_keyboard?.length),
        bottoni: (message.reply_markup?.inline_keyboard || []).flat().map(b => b.url),
        ha_foto: Boolean(message.photo),
        media_group_id: message.media_group_id || null
      });
      return new Response("ok");
    }

    offer = await enrich(env, offer);

    const current = await readOffers(env);
    const old = (current.offerte || []).find(item => item.id === offer.id);

    const next = old
      ? (current.offerte || []).map(item => (item.id === offer.id ? { ...item, ...offer } : item))
      : [offer, ...(current.offerte || [])];

    await writeOffers(env, next);

    console.log("Webhook OK:", old ? "aggiornata" : "scritta", "offerta id=" + offer.id, offer.titolo);

    if (!old) await notify(env, offer);

    return new Response("ok");
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return new Response("ok");
  }
}

// Contenuto ufficiale OneSignal per un service worker self-hosted (v16).
// Tenuto qui SOLO come ponte di compatibilità: i dispositivi che si erano
// già iscritti quando il worker OneSignal era separato da sw.js continuano
// a controllare periodicamente questo URL per eventuali aggiornamenti. Se
// smettesse di rispondere (404), il browser considera il service worker
// "rimosso" e ne annulla la registrazione, perdendo la sottoscrizione push
// in modo silenzioso. Le nuove visite del sito, invece, registrano
// direttamente sw.js (che importa già l'SDK OneSignal) e questo file non
// verrà più usato per loro: nulla lo cancella da solo, va tenuto.
const ONESIGNAL_SW_CONTENT =
  'importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");\n';

function handleOneSignalWorker() {
  return new Response(ONESIGNAL_SW_CONTENT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "public, max-age=86400"
    }
  });
}

async function handleImageProxy(url, env) {
  const fileId = url.searchParams.get("file_id");
  if (!fileId || !env.TELEGRAM_BOT_TOKEN) return new Response("", { status: 404 });

  try {
    const file = await telegram(env, "getFile", { file_id: fileId });
    const image = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
    );

    return new Response(image.body, {
      status: image.status,
      headers: {
        "Content-Type": image.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public,max-age=600"
      }
    });
  } catch {
    return new Response("", { status: 404 });
  }
}

/**
 * Scheda prodotto: varianti (GetVariations) + prodotti correlati
 * (SearchItems per marca/titolo), eseguiti in parallelo. Pensato per essere
 * chiamato solo quando l'utente apre il dettaglio di un'offerta, non per
 * tutte le card della home.
 */
async function handleProduct(url, env, origin) {
  const asin = (url.searchParams.get("asin") || "").trim();
  if (!asin) return json({ varianti: [], correlati: [] }, 200, origin);

  const brand = (url.searchParams.get("brand") || "").trim();
  const title = (url.searchParams.get("title") || "").trim();

  const [varianti, correlati] = await Promise.all([
    creatorsGetVariations(env, asin),
    creatorsSearchSimilar(env, { asin, brand, title })
  ]);

  return json({ varianti, correlati }, 200, origin);
}

async function handleSetupRoutes(url, env, origin) {
  if (!authorisedSetup(url, env)) return new Response("", { status: 403 });

  try {
    if (url.pathname === "/setup") {
      // Due bot Telegram distinti = due chiamate setWebhook distinte, una
      // per token. Il bot ARTICOLI è opzionale: se ARTICLES_BOT_TOKEN non è
      // ancora configurato saltiamo la sua registrazione invece di far
      // fallire tutto /setup (così il bot del canale continua a funzionare
      // anche prima di aver attivato la funzione articoli).
      const channelWebhook = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["channel_post", "edited_channel_post"],
        drop_pending_updates: false
      });

      let articlesWebhook = null;
      if (env.ARTICLES_BOT_TOKEN && env.ARTICLES_WEBHOOK_SECRET) {
        articlesWebhook = await telegramArticlesBot(env, "setWebhook", {
          url: `${url.origin}/telegram-articles`,
          secret_token: env.ARTICLES_WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false
        });

        // Menu "/" visibile in chat: comodo, non indispensabile, per questo
        // non blocchiamo /setup se fallisce.
        await telegramArticlesBot(env, "setMyCommands", {
          commands: [
            { command: "start", description: "Come funziona questo bot" },
            { command: "help", description: "Come funziona questo bot" }
          ]
        }).catch(() => {});
      }

      return json({ ok: true, webhook: channelWebhook, webhook_articoli: articlesWebhook }, 200, origin);
    }

    if (url.pathname === "/seed") {
      return json(await seed(env, enrich), 200, origin);
    }

    if (url.pathname === "/sync") {
      const result = await syncNewOffers(env, enrich, notify);
      return json(result, 200, origin);
    }

    // /status: identità del bot + stato del webhook Telegram + freschezza
    // dei dati in KV. Utile per capire se un'offerta mancante è un
    // problema di webhook, di permessi del bot sul canale, o di dati non
    // ancora arrivati.
    const [botInfo, webhookInfo, storedOffers, articlesBotInfo, articlesWebhookInfo] = await Promise.all([
      telegram(env, "getMe").catch(() => null),
      telegram(env, "getWebhookInfo"),
      readOffers(env),
      env.ARTICLES_BOT_TOKEN ? telegramArticlesBot(env, "getMe").catch(() => null) : null,
      env.ARTICLES_BOT_TOKEN ? telegramArticlesBot(env, "getWebhookInfo").catch(() => null) : null
    ]);

    return json(
      {
        bot: botInfo
          ? { username: botInfo.username, id: botInfo.id, nome: botInfo.first_name }
          : null,
        webhook: webhookInfo,
        bot_articoli: articlesBotInfo
          ? { username: articlesBotInfo.username, id: articlesBotInfo.id, nome: articlesBotInfo.first_name }
          : null,
        webhook_articoli: articlesWebhookInfo,
        kv: {
          conteggio: storedOffers.conteggio,
          ultimo_aggiornamento: storedOffers.ultimo_aggiornamento,
          offerta_piu_recente: storedOffers.offerte?.[0]
            ? {
                id: storedOffers.offerte[0].id,
                titolo: storedOffers.offerte[0].titolo,
                data_pubblicazione: storedOffers.offerte[0].data_pubblicazione
              }
            : null
        }
      },
      200,
      origin
    );
  } catch (error) {
    return json({ ok: false, error: error.message }, 500, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegramWebhook(request, env, origin);
    }

    if (url.pathname === "/telegram-articles" && request.method === "POST") {
      return handleArticlesWebhook(request, env);
    }

    if (url.pathname === "/offers" && request.method === "GET") {
      try {
        return json(await readOffers(env), 200, origin);
      } catch {
        return json({ offerte: [], ultimo_aggiornamento: null, conteggio: 0 }, 200, origin);
      }
    }

    if (url.pathname === "/articles" && request.method === "GET") {
      try {
        return json(await readArticles(env), 200, origin);
      } catch {
        return json({ articoli: [], ultimo_aggiornamento: null, conteggio: 0 }, 200, origin);
      }
    }

    if (url.pathname === "/product" && request.method === "GET") {
      return handleProduct(url, env, origin);
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/push/onesignal/OneSignalSDKWorker.js" ||
        url.pathname === "/push/onesignal/OneSignalSDKUpdaterWorker.js")
    ) {
      return handleOneSignalWorker();
    }

    if (url.pathname === "/image" && request.method === "GET") {
      return handleImageProxy(url, env);
    }

    if (["/setup", "/seed", "/status", "/sync"].includes(url.pathname) && request.method === "GET") {
      return handleSetupRoutes(url, env, origin);
    }

    return new Response("", { status: 404 });
  },

  /**
   * Cron Trigger: rilegge periodicamente la pagina pubblica del canale e
   * scrive solo le offerte davvero nuove. È il meccanismo che sostituisce
   * il webhook come fonte primaria, perché il bot pubblica i post per
   * conto proprio (dalla chat privata) e Telegram non genera un
   * aggiornamento webhook per i messaggi che un bot invia da solo.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncNewOffers(env, enrich, notify).catch(error =>
        console.error("Cron sync error:", error)
      )
    );
  }
};
