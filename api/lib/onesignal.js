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
      included_segments: ["Subscribed Users"],
      headings: { it: "🔥 Nuova offerta su Casa & Risparmio" },
      contents: { it: `${title}${discount}`.slice(0, 120) },
      url: offer.link_affiliato || offer.link_telegram_post || SITE_URL,
      chrome_web_icon: `${SITE_URL}icon-192.png`
    })
  });

  const body = await response.text();

  if (!response.ok) {
    console.error("OneSignal error:", response.status, body);
  } else {
    console.log("OneSignal: notifica inviata per", title, "->", body);
  }
}
