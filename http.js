// Helper per risposte HTTP: header CORS e wrapper JSON.

export const SITE_URL = "https://offerte-casa-risparmio.bluestacksappnana.workers.dev/";
export const SITE_ORIGIN = "https://offerte-casa-risparmio.bluestacksappnana.workers.dev";
// Quando acquisti un dominio personalizzato, aggiorna questi due valori
// con il nuovo dominio: da qui dipendono i permessi CORS e i link nelle
// notifiche push.

export function cors(origin = "") {
  return {
    "Access-Control-Allow-Origin": origin === SITE_ORIGIN ? origin : SITE_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Bot-Api-Secret-Token",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
}

export function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors(origin)
    }
  });
}
