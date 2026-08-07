// Regole di ordinamento/deduplicazione delle offerte e lettura/scrittura su KV.
//
// Regola: newest first, confrontando data_pubblicazione in modo robusto
// (mai fidarsi dell'ordine con cui arrivano i post da Telegram).

export const MAX_OFFERS = 10;

export function offerDateValue(offer) {
  const value = Date.parse(offer?.data_pubblicazione || "");
  return Number.isFinite(value) ? value : 0;
}

export function offerIdValue(offer) {
  const value = Number.parseInt(String(offer?.id || ""), 10);
  return Number.isFinite(value) ? value : 0;
}

export function sortOffersNewestFirst(offers) {
  return [...(Array.isArray(offers) ? offers : [])].sort((a, b) => {
    const byDate = offerDateValue(b) - offerDateValue(a);
    return byDate || (offerIdValue(b) - offerIdValue(a));
  });
}

export function uniqueOffersNewestFirst(offers) {
  const seen = new Set();
  return sortOffersNewestFirst(offers).filter(offer => {
    if (!offer?.id) return false;
    const id = String(offer.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const EMPTY = { offerte: [], ultimo_aggiornamento: null, conteggio: 0 };

export async function readOffers(env) {
  const raw = await env.OFFERS.get("latest");
  if (!raw) return { ...EMPTY };

  try {
    const data = JSON.parse(raw);
    const offerte = uniqueOffersNewestFirst(data.offerte).slice(0, MAX_OFFERS);
    return {
      offerte,
      ultimo_aggiornamento: data.ultimo_aggiornamento || null,
      conteggio: offerte.length
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeOffers(env, offers) {
  const unique = uniqueOffersNewestFirst(offers).slice(0, MAX_OFFERS);
  const data = {
    offerte: unique,
    ultimo_aggiornamento: new Date().toISOString(),
    conteggio: unique.length
  };

  await env.OFFERS.put("latest", JSON.stringify(data));
  return data;
}
