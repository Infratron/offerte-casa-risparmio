// Lettura/scrittura degli articoli generati dall'AI, sullo stesso KV
// namespace già usato per le offerte ("OFFERS"), ma sotto chiavi diverse
// così da non toccare in alcun modo i dati delle offerte:
//
//   "articles:list"    -> articoli PUBBLICATI, visibili sul sito (GET /articles)
//   "articles:pending" -> bozze in attesa di approvazione/scarto da Telegram
//
// Stessa filosofia di offers.js: un solo blob JSON per chiave, riscritto
// per intero ad ogni modifica. Ai volumi di questa funzione (poche bozze
// alla volta, pochi articoli pubblicati) è più che sufficiente e mantiene
// il codice semplice.

export const MAX_ARTICLES = 30;

const EMPTY_LIST = { articoli: [], ultimo_aggiornamento: null, conteggio: 0 };

export async function readArticles(env) {
  const raw = await env.OFFERS.get("articles:list");
  if (!raw) return { ...EMPTY_LIST };

  try {
    const data = JSON.parse(raw);
    const articoli = Array.isArray(data.articoli) ? data.articoli.slice(0, MAX_ARTICLES) : [];
    return {
      articoli,
      ultimo_aggiornamento: data.ultimo_aggiornamento || null,
      conteggio: articoli.length
    };
  } catch {
    return { ...EMPTY_LIST };
  }
}

export async function publishArticle(env, article) {
  const current = await readArticles(env);
  const next = [article, ...current.articoli.filter(a => a.id !== article.id)].slice(0, MAX_ARTICLES);
  const data = {
    articoli: next,
    ultimo_aggiornamento: new Date().toISOString(),
    conteggio: next.length
  };

  await env.OFFERS.put("articles:list", JSON.stringify(data));
  return data;
}

export async function readPendingDrafts(env) {
  const raw = await env.OFFERS.get("articles:pending");
  if (!raw) return {};

  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function savePendingDraft(env, draft) {
  const drafts = await readPendingDrafts(env);
  drafts[draft.id] = draft;
  await env.OFFERS.put("articles:pending", JSON.stringify(drafts));
  return draft;
}

// Legge E rimuove una bozza in un solo passaggio: usata sia per "Pubblica"
// che per "Scarta", così un doppio tap sullo stesso bottone (o due bottoni
// premuti in rapida successione) non può processare la stessa bozza due volte.
export async function takePendingDraft(env, id) {
  const drafts = await readPendingDrafts(env);
  const draft = drafts[id] || null;

  if (draft) {
    delete drafts[id];
    await env.OFFERS.put("articles:pending", JSON.stringify(drafts));
  }

  return draft;
}
