// Integrazione Gemini API per la generazione automatica di articoli prodotto.
//
// Riferimento ufficiale: https://ai.google.dev/api/generate-content
//
// Scelta di design importante: a Gemini NON viene chiesto di "visitare" il
// link Amazon da solo. Il Worker recupera prima i dati veri del prodotto
// tramite la Amazon Creators API (stessa integrazione già usata per le
// offerte) e li passa a Gemini come fatti dati. Risultato: niente dati
// inventati, niente dipendenza dal fatto che Amazon blocchi o meno la
// navigazione automatica, e un output prevedibile in formato JSON.

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// Modello di default: veloce ed economico, adatto a testi brevi come questi.
// Sovrascrivibile con la variabile GEMINI_MODEL nel Worker, senza toccare
// il codice, se in futuro preferisci un modello diverso.
const DEFAULT_MODEL = "gemini-2.5-flash";

const ARTICLE_SCHEMA = {
  type: "OBJECT",
  properties: {
    titolo: {
      type: "STRING",
      description:
        "Titolo editoriale accattivante per l'articolo, diverso dal titolo prodotto grezzo. Massimo 90 caratteri."
    },
    estratto: {
      type: "STRING",
      description: "Sommario di 1-2 frasi che invoglia a leggere l'articolo. Massimo 200 caratteri."
    },
    corpo_html: {
      type: "STRING",
      description:
        "Corpo dell'articolo in italiano, 250-450 parole, in HTML semplice usando SOLO questi tag: <p>, <h3>, <ul>, <li>, <strong>, <em>. Deve spiegare cos'è il prodotto e come funziona/i suoi punti di forza (basandosi solo sui dati forniti), per chi è adatto, e chiudere con un invito naturale a scoprirlo/acquistarlo. Non inventare caratteristiche, numeri o specifiche che non sono presenti nei dati forniti."
    }
  },
  required: ["titolo", "estratto", "corpo_html"]
};

// Whitelist di tag consentiti nell'HTML restituito da Gemini: difesa in
// profondità, visto che il corpo_html finisce poi con innerHTML sul sito
// pubblico. Tolto qualunque tag/attributo fuori whitelist (script, style,
// eventi on*, link, immagini...), anche se il prompt li vieta già.
const ALLOWED_TAGS = new Set(["p", "h3", "ul", "ol", "li", "strong", "em", "br", "b", "i"]);

export function sanitizeArticleHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")
    .replace(/<\/?([a-z0-9]+)[^>]*>/gi, (match, tag) => {
      const lower = String(tag).toLowerCase();
      if (!ALLOWED_TAGS.has(lower)) return "";
      return match.startsWith("</") ? `</${lower}>` : `<${lower}>`;
    });
}

function buildPrompt(product) {
  const righe = [
    `Titolo prodotto: ${product.titolo || "n/d"}`,
    product.brand ? `Marca: ${product.brand}` : "",
    product.prezzo_scontato ? `Prezzo attuale: ${product.prezzo_scontato}` : "",
    product.prezzo_originale ? `Prezzo originale: ${product.prezzo_originale}` : "",
    product.sconto_percentuale ? `Sconto: ${product.sconto_percentuale}` : "",
    product.condition ? `Condizione: ${product.condition}` : "",
    product.merchant ? `Venditore: ${product.merchant}` : "",
    Array.isArray(product.caratteristiche) && product.caratteristiche.length
      ? `Caratteristiche dichiarate dal produttore:\n- ${product.caratteristiche.join("\n- ")}`
      : ""
  ].filter(Boolean);

  return [
    "Sei il copywriter del sito italiano Casa & Risparmio, che segnala offerte Amazon a un pubblico che cerca occasioni concrete su casa, cucina ed elettrodomestici.",
    "Scrivi un articolo prodotto in italiano, tono amichevole ma concreto, senza clickbait esagerato, basandoti SOLO sui dati forniti qui sotto. Se un dato non è presente, non inventarlo e non menzionarlo.",
    "Ricorda che il pubblico legge per decidere se vale la pena acquistare: sii onesto, utile, e chiudi con una call-to-action naturale (non aggressiva) verso il link.",
    "",
    "Dati del prodotto:",
    righe.join("\n"),
    "",
    "Rispondi seguendo esattamente lo schema JSON richiesto, senza testo fuori dal JSON."
  ].join("\n");
}

export async function generateArticle(env, product) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY non configurata nel Worker");

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const prompt = buildPrompt(product);

  const response = await fetch(`${GEMINI_API}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: ARTICLE_SCHEMA
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(`Gemini: risposta vuota${blockReason ? ` (motivo: ${blockReason})` : ""}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini: risposta non in JSON valido");
  }

  return {
    titolo: String(parsed.titolo || "").trim().slice(0, 140),
    estratto: String(parsed.estratto || "").trim().slice(0, 240),
    corpo_html: sanitizeArticleHtml(parsed.corpo_html || "")
  };
}
