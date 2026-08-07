// Integrazione Amazon Creators API.
//
// Riferimento ufficiale: https://affiliate-program.amazon.com/creatorsapi/docs
//
// Nota sulle chiavi di risposta: la documentazione Amazon non è coerente con
// se stessa tra pagine diverse (es. GetItems usa "itemResults" in una pagina
// e "itemsResult" in un'altra). Per robustezza leggiamo sempre entrambe le
// varianti invece di scommettere su una sola.

const AMAZON_MARKETPLACE = "www.amazon.it";
const AMAZON_API = "https://creatorsapi.amazon/catalog/v1";
const AMAZON_TOKEN_URL = "https://api.amazon.co.uk/auth/o2/token";

let amazonTokenCache = { token: "", expiresAt: 0 };

async function creatorsToken(env) {
  if (!env.AMAZON_CREATORS_CLIENT_ID || !env.AMAZON_CREATORS_CLIENT_SECRET) {
    return "";
  }

  if (amazonTokenCache.token && Date.now() < amazonTokenCache.expiresAt) {
    return amazonTokenCache.token;
  }

  const response = await fetch(AMAZON_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.AMAZON_CREATORS_CLIENT_ID,
      client_secret: env.AMAZON_CREATORS_CLIENT_SECRET,
      scope: "creatorsapi::default"
    })
  });

  if (!response.ok) {
    throw new Error(`Amazon token ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();

  amazonTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000
  };

  return data.access_token;
}

async function creatorsRequest(env, operation, payload) {
  if (!env.AMAZON_PARTNER_TAG) return null;

  const token = await creatorsToken(env);
  if (!token) return null;

  const response = await fetch(`${AMAZON_API}/${operation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-marketplace": AMAZON_MARKETPLACE
    },
    body: JSON.stringify({
      marketplace: AMAZON_MARKETPLACE,
      partnerTag: env.AMAZON_PARTNER_TAG,
      ...payload
    })
  });

  if (!response.ok) {
    console.error(`Creators API ${operation} error:`, response.status, await response.text());
    return null;
  }

  const data = await response.json();

  if (Array.isArray(data?.errors) && data.errors.length) {
    console.error(`Creators API ${operation} item errors:`, JSON.stringify(data.errors));
  }

  return data;
}

export async function creatorsGetItem(env, asin) {
  if (!asin) return null;

  const data = await creatorsRequest(env, "getItems", {
    itemIds: [asin],
    itemIdType: "ASIN",
    resources: [
      "images.primary.large",
      "images.primary.medium",
      "itemInfo.title",
      "itemInfo.byLineInfo",
      "offersV2.listings.availability",
      "offersV2.listings.condition",
      "offersV2.listings.dealDetails",
      "offersV2.listings.merchantInfo",
      "offersV2.listings.price",
      "offersV2.listings.isBuyBoxWinner"
    ]
  });

  const items = data?.itemsResult?.items || data?.itemResults?.items || [];
  return items[0] || null;
}

function pickListing(item) {
  const listings = item.offersV2?.listings || [];
  return listings.find(listing => listing.isBuyBoxWinner) || listings[0];
}

function money(value) {
  return value == null ? "" : `${Number(value).toFixed(2).replace(".", ",")} €`;
}

export function enrichFromAmazon(offer, item) {
  if (!item) return offer;

  const listing = pickListing(item);
  const price = listing?.price?.money;

  // Secondo la documentazione OffersV2, "savings" vive dentro
  // listing.price.savings, non direttamente su listing.
  const saving = listing?.price?.savings?.percentage;
  const savingBasis = listing?.price?.savingBasis?.money;
  const brand = item.itemInfo?.byLineInfo?.brand?.displayValue;
  const dealBadge = listing?.dealDetails?.badge;

  const enriched = {
    ...offer,
    asin: item.asin || offer.asin,
    titolo: item.itemInfo?.title?.displayValue || offer.titolo,
    immagine_url:
      item.images?.primary?.large?.url ||
      item.images?.primary?.medium?.url ||
      offer.immagine_url ||
      "",
    link_affiliato: item.detailPageURL || offer.link_affiliato,
    brand: brand || offer.brand || "",
    merchant: listing?.merchantInfo?.name || offer.merchant || "",
    condition: listing?.condition?.value || offer.condition || "",
    availability: listing?.availability?.type || offer.availability || "",
    deal_badge: dealBadge || offer.deal_badge || ""
  };

  if (price?.amount != null) enriched.prezzo_scontato = money(price.amount);
  if (saving != null) enriched.sconto_percentuale = `-${Math.round(Number(saving))}%`;
  if (savingBasis?.amount != null) enriched.prezzo_originale = money(savingBasis.amount);

  return enriched;
}

export async function enrich(env, offer) {
  try {
    if (!offer.asin) return offer;
    const item = await creatorsGetItem(env, offer.asin);
    return enrichFromAmazon(offer, item);
  } catch (error) {
    console.error("Amazon enrichment:", error);
    return offer;
  }
}

function simplifyItem(item) {
  if (!item?.asin) return null;

  const listing = pickListing(item);

  return {
    asin: item.asin,
    url: item.detailPageURL || "",
    titolo: item.itemInfo?.title?.displayValue || "",
    immagine_url:
      item.images?.primary?.medium?.url || item.images?.primary?.large?.url || "",
    prezzo: listing?.price?.money ? money(listing.price.money.amount) : "",
    attributi: (item.variationAttributes || []).map(attr => ({
      nome: attr.name || "",
      valore: attr.value || ""
    }))
  };
}

/**
 * Varianti dello stesso prodotto (taglia/colore) tramite GetVariations.
 * Molti prodotti (es. elettrodomestici) non hanno varianti: in quel caso
 * l'API restituisce semplicemente una lista vuota, gestita a monte.
 */
export async function creatorsGetVariations(env, asin, { count = 6 } = {}) {
  if (!asin) return [];

  try {
    const data = await creatorsRequest(env, "getVariations", {
      asin,
      variationCount: Math.min(Math.max(count, 1), 10),
      variationPage: 1,
      resources: [
        "itemInfo.title",
        "images.primary.medium",
        "offersV2.listings.price"
      ]
    });

    const items =
      data?.variationsResult?.items || data?.variationResult?.items || [];

    return items
      .map(simplifyItem)
      .filter(item => item && item.asin !== asin);
  } catch (error) {
    console.error("Amazon getVariations:", error);
    return [];
  }
}

/**
 * Prodotti correlati/simili tramite SearchItems, usando marca + parole
 * chiave del titolo. Richiede almeno uno tra brand/keywords: se mancano
 * entrambi non chiama l'API e restituisce semplicemente [].
 */
export async function creatorsSearchSimilar(env, { asin, brand, title, count = 6 } = {}) {
  const keywords = String(title || "").split(/\s+/).slice(0, 6).join(" ").trim();

  if (!brand && !keywords) return [];

  try {
    const payload = {
      itemCount: Math.min(Math.max(count, 1), 10),
      resources: ["images.primary.medium", "itemInfo.title", "offersV2.listings.price"]
    };

    if (brand) payload.brand = brand;
    if (keywords) payload.keywords = keywords;

    const data = await creatorsRequest(env, "searchItems", payload);
    const items = data?.searchResult?.items || [];

    return items
      .map(simplifyItem)
      .filter(item => item && item.asin !== asin);
  } catch (error) {
    console.error("Amazon searchItems:", error);
    return [];
  }
}
