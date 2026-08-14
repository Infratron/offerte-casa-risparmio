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

// Ultimo motivo per cui creatorsRequest() ha restituito null: token mancante,
// risposta HTTP non ok, errori nel payload... Serve solo a dare un messaggio
// utile nel flusso articoli (vedi draftArticleFromLink in worker.js), che
// altrimenti mostrerebbe sempre lo stesso "non ha restituito dati" generico
// senza dire perché. Non tocca in alcun modo il flusso offerte, che resta
// silenzioso di proposito (enrich() deve poter fallire senza rumore).
let lastCreatorsError = "";

export function getLastCreatorsError() {
  return lastCreatorsError;
}

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
  lastCreatorsError = "";

  if (!env.AMAZON_PARTNER_TAG) {
    lastCreatorsError = "AMAZON_PARTNER_TAG non configurato";
    return null;
  }

  let token;
  try {
    token = await creatorsToken(env);
  } catch (error) {
    // Prima questo errore (token OAuth) non veniva intercettato qui: saliva
    // fino a draftArticleFromLink() con un messaggio diverso ("Errore nella
    // generazione dell'articolo..."). Ora passa dalla stessa strada di tutti
    // gli altri fallimenti Amazon, un solo messaggio coerente.
    lastCreatorsError = `token: ${error.message}`;
    return null;
  }

  if (!token) {
    lastCreatorsError = "AMAZON_CREATORS_CLIENT_ID o AMAZON_CREATORS_CLIENT_SECRET non configurati";
    return null;
  }

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
    const body = await response.text();
    lastCreatorsError = `${operation} ${response.status}: ${body.slice(0, 300)}`;
    console.error(`Creators API ${operation} error:`, response.status, body);
    return null;
  }

  const data = await response.json();

  if (Array.isArray(data?.errors) && data.errors.length) {
    lastCreatorsError = `${operation}: ${JSON.stringify(data.errors).slice(0, 300)}`;
    console.error(`Creators API ${operation} item errors:`, JSON.stringify(data.errors));
  }

  return data;
}

/**
 * Bypassa TUTTA la logica di creatorsRequest (nessun null silenzioso, nessun
 * try/catch che nasconde l'errore): fa la telefonata ad Amazon e restituisce
 * status HTTP + corpo grezzo così come arrivano. Pensata solo per il
 * comando /debug del bot articoli, per vedere con i nostri occhi cosa
 * risponde davvero Amazon invece di continuare a dedurlo da lontano.
 */
export async function creatorsDebugRaw(env, asin) {
  const report = {
    clientIdPresent: Boolean(env.AMAZON_CREATORS_CLIENT_ID),
    clientSecretPresent: Boolean(env.AMAZON_CREATORS_CLIENT_SECRET),
    partnerTag: env.AMAZON_PARTNER_TAG || "",
    tokenOk: false,
    tokenError: "",
    httpStatus: null,
    bodyText: ""
  };

  let token = "";
  try {
    token = await creatorsToken(env);
    report.tokenOk = Boolean(token);
  } catch (error) {
    report.tokenError = error.message;
    return report;
  }

  if (!token || !env.AMAZON_PARTNER_TAG) return report;

  const getItemsResponse = await fetch(`${AMAZON_API}/getItems`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-marketplace": AMAZON_MARKETPLACE
    },
    body: JSON.stringify({
      marketplace: AMAZON_MARKETPLACE,
      partnerTag: env.AMAZON_PARTNER_TAG,
      itemIds: [asin],
      itemIdType: "ASIN",
      resources: ["itemInfo.title"]
    })
  });

  report.httpStatus = getItemsResponse.status;
  report.bodyText = await getItemsResponse.text();

  // Operazione diversa (ricerca per parola chiave invece che per ASIN
  // preciso), stessa idea: se l'errore è identico anche qui, il blocco è
  // sull'intero account e non su questa singola chiamata/ASIN.
  const searchResponse = await fetch(`${AMAZON_API}/searchItems`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-marketplace": AMAZON_MARKETPLACE
    },
    body: JSON.stringify({
      marketplace: AMAZON_MARKETPLACE,
      partnerTag: env.AMAZON_PARTNER_TAG,
      keywords: "aspirapolvere",
      resources: ["itemInfo.title"]
    })
  });

  report.searchHttpStatus = searchResponse.status;
  report.searchBodyText = await searchResponse.text();

  return report;
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
      offer.immagine_url ||
      item.images?.primary?.large?.url ||
      item.images?.primary?.medium?.url ||
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

/**
 * Variante di creatorsGetItem pensata per il flusso "articolo generato
 * dall'AI": richiede in più "itemInfo.features" (i bullet point che il
 * produttore dichiara sulla scheda Amazon), il materiale più utile perché
 * Gemini possa scrivere un testo su "come funziona" senza inventare nulla.
 * Tenuta separata da creatorsGetItem per non appesantire l'arricchimento
 * delle offerte del canale, che non ne ha bisogno.
 */
export async function creatorsGetItemDetailed(env, asin) {
  if (!asin) return null;

  const data = await creatorsRequest(env, "getItems", {
    itemIds: [asin],
    itemIdType: "ASIN",
    resources: [
      "images.primary.large",
      "itemInfo.title",
      "itemInfo.byLineInfo",
      "itemInfo.features",
      "offersV2.listings.availability",
      "offersV2.listings.condition",
      "offersV2.listings.dealDetails",
      "offersV2.listings.merchantInfo",
      "offersV2.listings.price",
      "offersV2.listings.isBuyBoxWinner"
    ]
  });

  const items = data?.itemsResult?.items || data?.itemResults?.items || [];

  if (!items.length && data) {
    // Richiesta andata a buon fine (200 OK, nessun errore HTTP) ma senza
    // nessun prodotto restituito: caso diverso da quelli sopra (token/rete/
    // permessi), quindi finora non veniva segnalato. Mostriamo le chiavi
    // vere della risposta: se non sono "itemsResult"/"itemResults" come ci
    // aspettiamo, è la prova che questa API usa un nome diverso per questo
    // account/operazione, e sappiamo subito cosa correggere nel parsing.
    lastCreatorsError = `getItems: risposta 200 OK ma senza item per ${asin}. Chiavi risposta: ${Object.keys(data).join(", ") || "(nessuna)"} — dump: ${JSON.stringify(data).slice(0, 500)}`;
  }

  return items[0] || null;
}

/**
 * Appiattisce un item Amazon nei soli campi che servono al prompt di
 * Gemini (vedi gemini.js). "fallback" copre i casi in cui l'API non ha
 * restituito nulla di utile (es. credenziali assenti in sviluppo): meglio
 * un articolo con pochi dati (asin, link) che nessun articolo.
 */
export function productDataForArticle(item, fallback = {}) {
  if (!item) return { asin: fallback.asin || "", link_affiliato: fallback.link_affiliato || "", caratteristiche: [] };

  const listing = pickListing(item);
  const price = listing?.price?.money;
  const saving = listing?.price?.savings?.percentage;
  const savingBasis = listing?.price?.savingBasis?.money;

  return {
    asin: item.asin || fallback.asin || "",
    titolo: item.itemInfo?.title?.displayValue || "",
    brand: item.itemInfo?.byLineInfo?.brand?.displayValue || "",
    immagine_url: item.images?.primary?.large?.url || "",
    link_affiliato: item.detailPageURL || fallback.link_affiliato || "",
    merchant: listing?.merchantInfo?.name || "",
    condition: listing?.condition?.value || "",
    prezzo_scontato: price?.amount != null ? money(price.amount) : "",
    prezzo_originale: savingBasis?.amount != null ? money(savingBasis.amount) : "",
    sconto_percentuale: saving != null ? `-${Math.round(Number(saving))}%` : "",
    // Come per "itemsResult"/"itemResults" più sopra, la Amazon Creators API
    // non è coerente sul nome esatto di questa chiave tra una pagina di
    // documentazione e l'altra: proviamo entrambe le varianti plausibili.
    caratteristiche: (
      item.itemInfo?.features?.displayValues ||
      item.itemInfo?.featureBullets?.displayValues ||
      []
    ).slice(0, 8)
  };
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
