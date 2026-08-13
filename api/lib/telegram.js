// Integrazione Telegram: chiamate al Bot API, conversione messaggio -> offerta,
// e "seed" iniziale che rilegge lo storico pubblico del canale.

import { cleanTitle, prices, stripHtml, decode } from "./text.js";
import { amazonUrl, amazonUrlFromMessage, asinFromUrl, cleanUrl, isAmazonUrl } from "./amazon-url.js";
import { MAX_OFFERS, readOffers, uniqueOffersNewestFirst, writeOffers } from "./offers.js";

export const CHANNEL_USERNAME = "CasaRisparmio";

export async function telegram(env, method, body = null) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} error`);
  }

  return data.result;
}

export function telegramPost(message) {
  return `https://t.me/${CHANNEL_USERNAME}/${message.message_id}`;
}

/**
 * Scorciatoia per i messaggi di testo semplici (usata dal flusso admin in
 * chat privata: onboarding, conferme, errori). Per i messaggi con
 * anteprima/pulsanti (le bozze di articolo) il worker chiama comunque
 * telegram(env, "sendPhoto"/"sendMessage", {...}) direttamente, perché la
 * forma cambia da caso a caso.
 */
export function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

export function fromMessage(message) {
  const text = message.text || message.caption || "";
  const amazonLink = amazonUrlFromMessage(message);
  if (!amazonLink) return null;

  const parsedPrices = prices(text);
  const photo =
    Array.isArray(message.photo) && message.photo.length ? message.photo.at(-1) : null;

  return {
    id: String(message.message_id),
    asin: asinFromUrl(amazonLink),
    titolo: cleanTitle(text),
    immagine_file_id: photo?.file_id || "",
    immagine_url: "",
    link_affiliato: amazonLink,
    link_telegram_post: telegramPost(message),
    prezzo_originale: parsedPrices.prezzo_originale,
    prezzo_scontato: parsedPrices.prezzo_scontato,
    sconto_percentuale: parsedPrices.sconto_percentuale,
    data_pubblicazione: message.date
      ? new Date(message.date * 1000).toISOString()
      : new Date().toISOString()
  };
}

/**
 * Rilegge lo storico pubblico del canale (https://t.me/s/<canale>) e
 * restituisce i candidati (senza arricchimento Amazon, senza scrivere su KV).
 *
 * Non usa `split('<div class="tgme_widget_message')` perché il markup HTML
 * di Telegram può cambiare: cerca invece ogni `data-post` e prende il
 * blocco compreso tra quel post e il successivo, poi cerca i link Amazon
 * negli href del blocco.
 *
 * Non si fida dell'ordine con cui Telegram restituisce il markup: raccoglie
 * i candidati, li ordina per data (e in caso di parità per message_id), e
 * solo dopo sceglie i più recenti.
 */
export async function fetchChannelCandidates(env) {
  const response = await fetch(`https://t.me/s/${CHANNEL_USERNAME}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Telegram ${response.status}`);
  }

  const html = await response.text();
  const postRegex = /data-post\s*=\s*["']([^"']+)["']/gi;
  const posts = [];
  let match;

  while ((match = postRegex.exec(html)) !== null) {
    posts.push({ post: match[1], index: match.index });
  }

  const uniquePosts = [];
  const seenPosts = new Set();

  for (const item of posts) {
    if (!item.post || seenPosts.has(item.post)) continue;
    seenPosts.add(item.post);
    uniquePosts.push(item);
  }

  const candidates = [];

  for (let i = 0; i < uniquePosts.length; i++) {
    const current = uniquePosts[i];
    const next = uniquePosts[i + 1];
    const post = current.post;
    const id = post.split("/").at(-1);
    if (!id) continue;

    const start = current.index;
    const end = next ? next.index : html.length;
    const block = html.slice(start, end);

    let textHtml =
      block.match(
        /<div[^>]*class=["'][^"']*tgme_widget_message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
      )?.[1] || "";

    if (!textHtml) {
      textHtml =
        block.match(
          /<div[^>]*class=["'][^"']*message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
        )?.[1] || "";
    }

    const text = stripHtml(textHtml);

    const hrefs = [];
    const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
    let hrefMatch;

    while ((hrefMatch = hrefRegex.exec(block)) !== null) {
      const href = cleanUrl(hrefMatch[1]);
      if (href && !hrefs.includes(href)) hrefs.push(href);
    }

    let link = amazonUrl(text);
    if (!link) link = hrefs.find(href => isAmazonUrl(href)) || "";
    if (!link) continue;

    let photo =
      block.match(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/i)?.[1] || "";
    photo = decode(photo);

    const date = block.match(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    const parsedPrices = prices(text);

    candidates.push({
      id: String(id),
      titolo: cleanTitle(text),
      immagine_url: photo,
      immagine_file_id: "",
      link_affiliato: link,
      link_telegram_post: `https://t.me/${post}`,
      asin: asinFromUrl(link),
      prezzo_originale: parsedPrices.prezzo_originale,
      prezzo_scontato: parsedPrices.prezzo_scontato,
      sconto_percentuale: parsedPrices.sconto_percentuale,
      data_pubblicazione: date || ""
    });
  }

  return uniqueOffersNewestFirst(candidates).slice(0, MAX_OFFERS);
}

/**
 * Usata dalla rotta manuale /seed: rilegge tutto e ri-arricchisce ogni
 * offerta da Amazon. Va bene per un click occasionale, non per un cron
 * frequente (richiamerebbe Amazon per le stesse 10 offerte ad ogni giro).
 */
export async function seed(env, enrich) {
  const candidates = await fetchChannelCandidates(env);
  const enriched = [];

  for (const candidate of candidates) {
    enriched.push(await enrich(env, candidate));
  }

  return writeOffers(env, enriched);
}

/**
 * Usata dal Cron Trigger: confronta i candidati con quello che c'è già in
 * KV e arricchisce/notifica SOLO le offerte davvero nuove. Questo è il
 * meccanismo pensato per sostituire il webhook nel caso reale di questo
 * canale: il bot pubblica i post per conto proprio (via chat privata), e
 * Telegram non genera un aggiornamento webhook per i messaggi che un bot
 * invia da solo — quindi il webhook da solo non può mai vedere questi
 * post. Il polling periodico della pagina pubblica del canale, invece,
 * funziona sempre, indipendentemente da chi/cosa ha pubblicato.
 */
export async function syncNewOffers(env, enrich, notify) {
  const candidates = await fetchChannelCandidates(env);
  const current = await readOffers(env);
  const knownIds = new Set((current.offerte || []).map(o => String(o.id)));

  const fresh = candidates.filter(c => !knownIds.has(String(c.id)));
  if (!fresh.length) return { nuove: 0, conteggio: current.conteggio };

  const enriched = [];
  for (const candidate of fresh) {
    enriched.push(await enrich(env, candidate));
  }

  const next = [...enriched, ...(current.offerte || [])];
  const result = await writeOffers(env, next);

  for (const offer of enriched) {
    await notify(env, offer);
  }

  return { nuove: enriched.length, conteggio: result.conteggio };
}
