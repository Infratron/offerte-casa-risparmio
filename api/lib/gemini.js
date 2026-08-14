// Integrazione Gemini API per la generazione automatica di articoli prodotto.
//
// Riferimento ufficiale: https://ai.google.dev/gemini-api/docs/generate-content
// Ricerca Google (grounding): https://ai.google.dev/gemini-api/docs/generate-content/google-search
//
// STORIA DELLA SCELTA DI DESIGN (utile se la si rilegge tra qualche mese):
// in origine Gemini scriveva SOLO sulla base dei dati recuperati dalla Amazon
// Creators API, mai da ricerche proprie — zero rischio di invenzioni. Da
// quando l'account Amazon è bloccato da Amazon stessa (errore
// AssociateNotEligible, fuori dal nostro controllo), quella fonte non è più
// affidabile al 100%: ora Gemini usa la Ricerca Google (tool "google_search")
// per capire di che prodotto si tratta, MA il prezzo/sconto viene scritto
// SOLO se arriva da una fonte già verificata (Amazon, se torna disponibile,
// o le note scritte a mano dall'admin in chat) — mai da quello che trova
// cercando, che potrebbe essere vecchio o riferito a un'altra variante.
//
// Vincolo tecnico importante: l'API Gemini NON permette di combinare un
// search tool (google_search) con l'output JSON strutturato
// (responseSchema) nella stessa richiesta. Per questo l'output non è più
// JSON ma testo con marcatori (###TITOLO### ecc.), parsato qui sotto.

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// gemini-3.6-flash: unico modello Flash "pieno" corrente con grounding
// nativo alla ricerca Google, più economico della 3.5 Flash. Sovrascrivibile
// con la variabile GEMINI_MODEL nel Worker, senza toccare il codice.
const DEFAULT_MODEL = "gemini-3.6-flash";

// Whitelist di tag consentiti nell'HTML restituito da Gemini: difesa in
// profondità, visto che il corpo_html finisce poi con innerHTML sul sito
// pubblico. Tolto qualunque tag/attributo fuori whitelist (script, style,
// eventi on*, link, immagini...), anche se il prompt li vieta già. Il blocco
// "Fonti" viene aggiunto DOPO questa pulizia (vedi generateArticle), perché
// i link lì dentro li costruiamo noi in codice dai dati di grounding veri,
// non li scrive Gemini come testo libero.
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

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Estrae un indizio leggibile sul nome prodotto dallo slug dell'URL Amazon
 * (es. ".../Sekey-Tenda-a-Rullo-Oscurante/dp/B0XXXXX" -> "Sekey Tenda a
 * Rullo Oscurante"). Serve da ancora per la ricerca quando non abbiamo
 * né dati Amazon né note scritte a mano — meglio di niente, ma sempre
 * trattato come indizio, mai come fatto certo.
 */
function hintFromUrl(url = "") {
  try {
    const path = new URL(url).pathname;
    const slug = path.split("/").find(part => part.length > 8 && /-/.test(part) && !/^dp$/i.test(part));
    if (!slug) return "";
    return decodeURIComponent(slug).replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  } catch {
    return "";
  }
}

function buildPrompt({ link, adminNotes, amazon }) {
  const hint = hintFromUrl(link);

  const datiAmazon = amazon
    ? [
        amazon.titolo ? `Titolo: ${amazon.titolo}` : "",
        amazon.brand ? `Marca: ${amazon.brand}` : "",
        amazon.prezzo_scontato ? `Prezzo attuale: ${amazon.prezzo_scontato}` : "",
        amazon.prezzo_originale ? `Prezzo originale: ${amazon.prezzo_originale}` : "",
        amazon.sconto_percentuale ? `Sconto: ${amazon.sconto_percentuale}` : "",
        Array.isArray(amazon.caratteristiche) && amazon.caratteristiche.length
          ? `Caratteristiche dichiarate: ${amazon.caratteristiche.join("; ")}`
          : ""
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return [
    "Sei il copywriter del sito italiano Casa & Risparmio, che segnala offerte Amazon a un pubblico che cerca occasioni concrete su casa, cucina ed elettrodomestici.",
    "Scrivi un articolo prodotto in italiano: tono entusiasta e persuasivo, che valorizzi i veri punti di forza e inviti concretamente all'acquisto — ma resta sempre onesto, mai ingannevole.",
    "",
    "Informazioni disponibili su questo prodotto:",
    `- Link: ${link}`,
    hint ? `- Indizio sul nome (dallo slug del link, da verificare con la ricerca): ${hint}` : "",
    adminNotes ? `- Note scritte a mano dalla redazione (fonte affidabile, prioritaria su tutto): ${adminNotes}` : "",
    datiAmazon ? `- Dati Amazon verificati:\n${datiAmazon}` : "",
    "",
    "Usa lo strumento di ricerca Google per identificare con certezza il prodotto e capire come funziona, a cosa serve, quali sono i suoi punti di forza tipici.",
    "",
    "REGOLE FERREE, da rispettare sempre:",
    "1. Scrivi un prezzo o una percentuale di sconto SOLO se compaiono nelle note della redazione o nei dati Amazon qui sopra. Se non ci sono, non inventare MAI un numero: parla genericamente di \"offerta su Amazon\" senza cifre.",
    "2. Non inventare specifiche tecniche precise (misure, potenza, capacità, materiali...) che non trovi confermate dalla ricerca o dalle informazioni fornite. In caso di dubbio, resta più generico piuttosto che rischiare un dato falso.",
    "3. Niente affermazioni non verificabili tipo \"il migliore in assoluto\" o dati statistici inventati.",
    "",
    "Rispondi ESATTAMENTE in questo formato, senza nulla prima o dopo:",
    "",
    "###TITOLO###",
    "(una riga, titolo editoriale accattivante, diverso dal nome prodotto grezzo, max 90 caratteri)",
    "###ESTRATTO###",
    "(1-2 frasi che invogliano a leggere, max 200 caratteri)",
    "###CORPO###",
    "(250-450 parole, HTML semplice: solo tag <p> <h3> <ul> <li> <strong> <em>, spiega cos'è il prodotto, come funziona, per chi è adatto, chiude con un invito naturale all'acquisto)",
    "###FINE###"
  ]
    .filter(Boolean)
    .join("\n");
}

function parseDelimited(text) {
  const titolo = text.match(/###TITOLO###\s*([\s\S]*?)\s*###ESTRATTO###/)?.[1]?.trim() || "";
  const estratto = text.match(/###ESTRATTO###\s*([\s\S]*?)\s*###CORPO###/)?.[1]?.trim() || "";
  const corpo = text.match(/###CORPO###\s*([\s\S]*?)\s*(###FINE###|$)/)?.[1]?.trim() || "";
  return { titolo, estratto, corpo_html: corpo };
}

/**
 * Costruisce il blocco "Fonti consultate" dai grounding chunks veri
 * restituiti da Gemini — non è testo scritto da Gemini, sono i link che la
 * Ricerca Google ha effettivamente usato. Aggiunto DOPO sanitizeArticleHtml,
 * quindi i tag <a> qui non passano dalla whitelist (li costruiamo noi da
 * dati fidati). Oltre a essere onesto verso i lettori, i termini di Google
 * per il grounding richiedono di mostrare l'attribuzione delle fonti.
 */
function buildSourcesHtml(groundingChunks = []) {
  const links = groundingChunks
    .map(chunk => chunk?.web)
    .filter(web => web?.uri)
    .slice(0, 5);

  if (!links.length) return "";

  const items = links
    .map(
      web =>
        `<li><a href="${escapeHtml(web.uri)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(web.title || web.uri)}</a></li>`
    )
    .join("");

  return `<p><em>Fonti consultate:</em></p><ul>${items}</ul>`;
}

export async function generateArticle(env, { link, adminNotes = "", amazon = null }) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY non configurata nel Worker");

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const prompt = buildPrompt({ link, adminNotes, amazon });

  const response = await fetch(`${GEMINI_API}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.8 }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("");

  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new Error(`Gemini: risposta vuota${blockReason ? ` (motivo: ${blockReason})` : ""}`);
  }

  const parsed = parseDelimited(text);
  if (!parsed.titolo || !parsed.corpo_html) {
    throw new Error(`Gemini: risposta non nel formato atteso -> ${text.slice(0, 300)}`);
  }

  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const corpoSanitizzato = sanitizeArticleHtml(parsed.corpo_html);
  const fontiHtml = buildSourcesHtml(groundingChunks);

  return {
    titolo: parsed.titolo.trim().slice(0, 140),
    estratto: parsed.estratto.trim().slice(0, 240),
    corpo_html: corpoSanitizzato + fontiHtml
  };
}
