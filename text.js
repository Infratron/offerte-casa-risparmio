// Helper di parsing testo: decodifica HTML, pulizia titoli, estrazione prezzi
// dal testo grezzo dei post Telegram.

export function decode(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .trim();
}

export function stripHtml(value = "") {
  return decode(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanTitle(text = "") {
  const lines = String(text)
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  for (const raw of lines) {
    const line = raw
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, "")
      .replace(/^[\s*•:–—-]+|[\s*•:–—-]+$/g, "")
      .trim();

    if (line.length < 3) continue;
    // Salta righe che sono probabilmente badge/etichette tutte maiuscole
    // ("SCONTO -40%", "OFFERTA LAMPO"...) invece del titolo prodotto vero.
    if (/^[A-ZÀ-Ý\s0-9%€!?.:–—-]{3,45}$/.test(line)) continue;

    return line.slice(0, 140);
  }

  return lines[0]?.slice(0, 140) || "Nuova offerta";
}

export function prices(text = "") {
  const values = [...String(text).matchAll(/(\d{1,4}(?:[.,]\d{2})?)\s*€/g)]
    .map(m => Number(m[1].replace(",", ".")))
    .filter(Number.isFinite);

  const unique = [...new Set(values)].sort((a, b) => a - b);
  const percentage = String(text).match(/(\d{1,3})\s*%/);

  const format = value =>
    value == null ? "" : value.toFixed(2).replace(".", ",") + " €";

  return {
    prezzo_scontato: format(unique[0]),
    prezzo_originale: format(unique.length > 1 ? unique.at(-1) : null),
    sconto_percentuale: percentage ? `${percentage[1]}%` : ""
  };
}
