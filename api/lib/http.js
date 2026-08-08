// Helper per risposte HTTP: header CORS e wrapper JSON.

// Dominio canonico del sito (usato nei link delle notifiche push).
export const SITE_URL = "https://casarisparmio.info/";

// Origini da cui accettare richieste /offers, /product, ecc. Tenere anche
// il vecchio dominio workers.dev è innocuo e utile per continuare a testare
// da lì; se cambi ancora dominio in futuro, aggiungi la nuova voce qui
// invece di sostituire.
const ALLOWED_ORIGINS = [
  "https://casarisparmio.info",
  "https://www.casarisparmio.info",
  "https://offerte-casa-risparmio.bluestacksappnana.workers.dev"
];

export function cors(origin = "") {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
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
