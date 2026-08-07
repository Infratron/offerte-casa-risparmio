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

import { cors, json } from "./lib/http.js";
import { readOffers, writeOffers } from "./lib/offers.js";
import { CHANNEL_USERNAME, fromMessage, seed, telegram } from "./lib/telegram.js";
import { creatorsGetVariations, creatorsSearchSimilar, enrich } from "./lib/amazon-api.js";
import { notify } from "./lib/onesignal.js";

function authorisedSetup(url, env) {
  return env.SETUP_KEY && url.searchParams.get("key") === env.SETUP_KEY;
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
      console.log(
        "Webhook ignorato: nessun link Amazon riconosciuto nel post",
        message.message_id,
        "del",
        message.date ? new Date(message.date * 1000).toISOString() : "(data mancante)"
      );
      return new Response("ok");
    }

    offer = await enrich(env, offer);

    const current = await readOffers(env);
    const old = (current.offerte || []).find(item => item.id === offer.id);

    const next = old
      ? (current.offerte || []).map(item => (item.id === offer.id ? { ...item, ...offer } : item))
      : [offer, ...(current.offerte || [])];

    await writeOffers(env, next);

    if (!old) await notify(env, offer);

    return new Response("ok");
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return new Response("ok");
  }
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
      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["channel_post", "edited_channel_post"],
        drop_pending_updates: false
      });

      return json({ ok: true, webhook: result }, 200, origin);
    }

    if (url.pathname === "/seed") {
      return json(await seed(env, enrich), 200, origin);
    }

    // /status: stato del webhook Telegram + freschezza dei dati in KV,
    // utile per capire se un'offerta mancante è un problema di webhook o
    // di dati non ancora arrivati.
    const webhookInfo = await telegram(env, "getWebhookInfo");
    const storedOffers = await readOffers(env);

    return json(
      {
        webhook: webhookInfo,
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

    if (url.pathname === "/offers" && request.method === "GET") {
      try {
        return json(await readOffers(env), 200, origin);
      } catch {
        return json({ offerte: [], ultimo_aggiornamento: null, conteggio: 0 }, 200, origin);
      }
    }

    if (url.pathname === "/product" && request.method === "GET") {
      return handleProduct(url, env, origin);
    }

    if (url.pathname === "/image" && request.method === "GET") {
      return handleImageProxy(url, env);
    }

    if (["/setup", "/seed", "/status"].includes(url.pathname) && request.method === "GET") {
      return handleSetupRoutes(url, env, origin);
    }

    return new Response("", { status: 404 });
  }
};
