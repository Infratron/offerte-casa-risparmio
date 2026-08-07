// Riconoscimento ed estrazione di link/ASIN Amazon da testo, entities e
// keyboard dei messaggi Telegram.

import { decode } from "./text.js";

export function isAmazonUrl(url = "") {
  return /(?:amazon\.[a-z.]+|amzn\.[a-z.]+)/i.test(String(url));
}

export function cleanUrl(url = "") {
  return decode(
    String(url)
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/\\\//g, "/")
      .trim()
  )
    .replace(/^["']|["']$/g, "")
    .replace(/[),.;]+$/, "");
}

export function amazonUrl(text = "", entities = []) {
  for (const entity of entities || []) {
    if (entity?.type === "text_link" && isAmazonUrl(entity.url || "")) {
      return cleanUrl(entity.url);
    }
  }

  const urls = String(text).match(/https?:\/\/[^\s<>]+/gi) || [];
  const found = urls.find(url => isAmazonUrl(url));
  return found ? cleanUrl(found) : "";
}

export function amazonUrlFromKeyboard(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard || [];

  for (const row of rows) {
    for (const button of row || []) {
      const url = button?.url || "";
      if (url && isAmazonUrl(url)) return cleanUrl(url);
    }
  }

  return "";
}

export function amazonUrlFromMessage(message) {
  const text = message?.text || message?.caption || "";
  const entities = message?.entities || message?.caption_entities || [];

  const fromText = amazonUrl(text, entities);
  if (fromText) return fromText;

  const fromKeyboard = amazonUrlFromKeyboard(message?.reply_markup);
  if (fromKeyboard) return fromKeyboard;

  return "";
}

export function asinFromUrl(url = "") {
  const match = String(url).match(
    /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/)([A-Z0-9]{10})(?:[/?#]|$)/i
  );
  return match ? match[1].toUpperCase() : "";
}
