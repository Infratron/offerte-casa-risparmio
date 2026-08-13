// Invio push notification OneSignal per le nuove offerte.

import { SITE_URL } from "./http.js";

export async function notify(env, offer) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    console.log("OneSignal: notifica saltata, ONESIGNAL_APP_ID/ONESIGNAL_REST_API_KEY non configurate");
    return;
  }

  const title = offer.titolo || "Nuova offerta";
  const discount = offer.sconto_percentuale ? ` · ${offer.sconto_percentuale}` : "";

  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      target_channel: "push",
      app_id: env.ONESIGNAL_APP_ID,
      // "Subscribed Users" risultava vuoto/non funzionante in questa app
      // OneSignal (verificato con un invio di test dalla dashboard).
      // "Total Subscriptions" include tutte le sottoscrizioni, ma OneSignal
      // salta correttamente quelle disiscritte, quindi resta sicuro da usare.
      included_segments: ["Total Subscriptions"],
      headings: {
        en: "🔥 New deal on Casa & Risparmio",
        it: "🔥 Nuova offerta su Casa & Risparmio"
      },
      contents: {
        en: `${title}${discount}`.slice(0, 120),
        it: `${title}${discount}`.slice(0, 120)
      },
      url: offer.link_affiliato || offer.link_telegram_post || SITE_URL,
      chrome_web_icon: `${SITE_URL}icon-192.png`,
      ...(offer.immagine_url ? { chrome_web_image: offer.immagine_url, big_picture: offer.immagine_url } : {})
    })
  });

  const body = await response.text();

  if (!response.ok) {
    console.error("OneSignal error:", response.status, body);
  } else {
    console.log("OneSignal: notifica inviata per", title, "->", body);
  }
}

/**
 * Variante di notify() per i nuovi articoli pubblicati (testo/heading
 * diversi). Tenuta separata invece di generalizzare notify(): le due cose
 * hanno campi leggermente diversi (un articolo non ha sconto_percentuale)
 * ed è più chiaro leggere due funzioni brevi che una con tanti "if".
 */
export async function notifyArticle(env, article) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    console.log("OneSignal: notifica articolo saltata, credenziali non configurate");
    return;
  }

  const title = article.titolo || "Nuovo articolo";

  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      target_channel: "push",
      app_id: env.ONESIGNAL_APP_ID,
      included_segments: ["Total Subscriptions"],
      headings: {
        en: "📝 New article on Casa & Risparmio",
        it: "📝 Nuovo articolo su Casa & Risparmio"
      },
      contents: {
        en: title.slice(0, 120),
        it: title.slice(0, 120)
      },
      url: `${SITE_URL}#articoli-section`,
      chrome_web_icon: `${SITE_URL}icon-192.png`,
      ...(article.immagine_url ? { chrome_web_image: article.immagine_url, big_picture: article.immagine_url } : {})
    })
  });

  const body = await response.text();

  if (!response.ok) {
    console.error("OneSignal error (articolo):", response.status, body);
  } else {
    console.log("OneSignal: notifica articolo inviata per", title, "->", body);
  }
}
