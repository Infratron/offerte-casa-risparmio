const MAX_OFFERS = 10;

const CHANNEL_USERNAME = "CasaRisparmio";
const SITE_URL = "https://infratron.github.io/offerte-casa-risparmio/";
const SITE_ORIGIN = "https://infratron.github.io";

const AMAZON_MARKETPLACE = "www.amazon.it";
const AMAZON_API = "https://creatorsapi.amazon/catalog/v1";
const AMAZON_TOKEN_URL = "https://api.amazon.co.uk/auth/o2/token";

let amazonTokenCache = {
  token: "",
  expiresAt: 0
};


/* =========================================================
   CORS / JSON
========================================================= */

function cors(origin = "") {
  return {
    "Access-Control-Allow-Origin":
      origin === SITE_ORIGIN ? origin : SITE_ORIGIN,

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Telegram-Bot-Api-Secret-Token",

    "Cache-Control":
      "no-store",

    "Vary":
      "Origin"
  };
}


function json(data, status = 200, origin = "") {
  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...cors(origin)
      }
    }
  );
}


/* =========================================================
   HTML / TEXT HELPERS
========================================================= */

function decode(value = "") {
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


function stripHtml(value = "") {
  return decode(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/* =========================================================
   TITLE
========================================================= */

function cleanTitle(text = "") {
  const lines = String(text)
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  for (const raw of lines) {

    const line = raw
      .replace(
        /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu,
        ""
      )
      .replace(
        /^[\s*•:–—-]+|[\s*•:–—-]+$/g,
        ""
      )
      .trim();

    if (line.length < 3) {
      continue;
    }

    if (
      /^[A-ZÀ-Ý\s0-9%€!?.:–—-]{3,45}$/.test(line)
    ) {
      continue;
    }

    return line.slice(0, 140);
  }

  return (
    lines[0]?.slice(0, 140) ||
    "Nuova offerta"
  );
}


/* =========================================================
   PRICES
========================================================= */

function prices(text = "") {

  const values = [
    ...String(text).matchAll(
      /(\d{1,4}(?:[.,]\d{2})?)\s*€/g
    )
  ]

    .map(m =>
      Number(
        m[1].replace(",", ".")
      )
    )

    .filter(Number.isFinite);


  const unique = [
    ...new Set(values)
  ].sort(
    (a, b) => a - b
  );


  const percentage =
    String(text).match(
      /(\d{1,3})\s*%/
    );


  const format = value =>
    value == null
      ? ""
      : value
          .toFixed(2)
          .replace(".", ",") +
        " €";


  return {

    prezzo_scontato:
      format(unique[0]),

    prezzo_originale:
      format(
        unique.length > 1
          ? unique.at(-1)
          : null
      ),

    sconto_percentuale:
      percentage
        ? `${percentage[1]}%`
        : ""
  };
}


/* =========================================================
   AMAZON URL
========================================================= */

function isAmazonUrl(url = "") {
  return /(?:amazon\.[a-z.]+|amzn\.[a-z.]+)/i.test(
    String(url)
  );
}


function cleanUrl(url = "") {
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


/*
 * Cerca un link Amazon nel testo.
 */
function amazonUrl(
  text = "",
  entities = []
) {

  /*
   * Prima cerchiamo nei text_link di Telegram.
   */
  for (const entity of entities || []) {

    if (
      entity?.type === "text_link" &&
      isAmazonUrl(entity.url || "")
    ) {
      return cleanUrl(entity.url);
    }
  }


  /*
   * Poi cerchiamo URL scritti direttamente
   * nel testo.
   */
  const urls =
    String(text).match(
      /https?:\/\/[^\s<>]+/gi
    ) || [];


  const found =
    urls.find(
      url => isAmazonUrl(url)
    );


  return found
    ? cleanUrl(found)
    : "";
}


/*
 * Cerca un link Amazon nei pulsanti inline
 * del messaggio Telegram.
 */
function amazonUrlFromKeyboard(
  replyMarkup
) {

  const rows =
    replyMarkup?.inline_keyboard || [];


  for (const row of rows) {

    for (const button of row || []) {

      const url =
        button?.url || "";


      if (
        url &&
        isAmazonUrl(url)
      ) {
        return cleanUrl(url);
      }
    }
  }


  return "";
}


/*
 * Funzione completa per Telegram:
 *
 * 1. testo
 * 2. entity text_link
 * 3. pulsante inline
 */
function amazonUrlFromMessage(
  message
) {

  const text =
    message?.text ||
    message?.caption ||
    "";


  const entities =
    message?.entities ||
    message?.caption_entities ||
    [];


  const fromText =
    amazonUrl(
      text,
      entities
    );


  if (fromText) {
    return fromText;
  }


  const fromKeyboard =
    amazonUrlFromKeyboard(
      message?.reply_markup
    );


  if (fromKeyboard) {
    return fromKeyboard;
  }


  return "";
}


/* =========================================================
   ASIN
========================================================= */

function asinFromUrl(url = "") {

  const match =
    String(url).match(
      /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/)([A-Z0-9]{10})(?:[/?#]|$)/i
    );


  return match
    ? match[1].toUpperCase()
    : "";
}


/* =========================================================
   TELEGRAM POST URL
========================================================= */

function telegramPost(message) {

  return (
    `https://t.me/${CHANNEL_USERNAME}/` +
    `${message.message_id}`
  );
}


/* =========================================================
   TELEGRAM MESSAGE -> OFFER
========================================================= */

function fromMessage(message) {

  const text =
    message.text ||
    message.caption ||
    "";


  /*
   * IMPORTANTISSIMO:
   * il link Amazon può essere nel pulsante
   * sotto il testo del post.
   */
  const amazonLink =
    amazonUrlFromMessage(
      message
    );


  if (!amazonLink) {
    return null;
  }


  const parsedPrices =
    prices(text);


  const photo =
    Array.isArray(message.photo) &&
    message.photo.length
      ? message.photo.at(-1)
      : null;


  return {

    id:
      String(message.message_id),

    asin:
      asinFromUrl(
        amazonLink
      ),

    titolo:
      cleanTitle(text),

    immagine_file_id:
      photo?.file_id || "",

    immagine_url:
      "",

    link_affiliato:
      amazonLink,

    link_telegram_post:
      telegramPost(message),

    preco_originale:
      "",

    prezzo_originale:
      parsedPrices.prezzo_originale,

    prezzo_scontato:
      parsedPrices.prezzo_scontato,

    sconto_percentuale:
      parsedPrices.sconto_percentuale,

    data_pubblicazione:
      message.date
        ? new Date(
            message.date * 1000
          ).toISOString()
        : new Date().toISOString()
  };
}


/* =========================================================
   KV
========================================================= */

async function readOffers(env) {

  const raw =
    await env.OFFERS.get(
      "latest"
    );


  if (!raw) {

    return {
      offerte: [],
      ultimo_aggiornamento: null,
      conteggio: 0
    };
  }


  try {

    return JSON.parse(raw);

  } catch {

    return {
      offerte: [],
      ultimo_aggiornamento: null,
      conteggio: 0
    };
  }
}


async function writeOffers(
  env,
  offers
) {

  const unique = [];
  const seen = new Set();


  const sorted =
    [...offers].sort(
      (a, b) =>
        new Date(
          b.data_pubblicazione || 0
        ) -
        new Date(
          a.data_pubblicazione || 0
        )
    );


  for (const offer of sorted) {

    if (
      !offer?.id ||
      seen.has(offer.id)
    ) {
      continue;
    }


    seen.add(offer.id);
    unique.push(offer);


    if (
      unique.length >=
      MAX_OFFERS
    ) {
      break;
    }
  }


  const data = {

    offerte:
      unique,

    ultimo_aggiornamento:
      new Date().toISOString(),

    conteggio:
      unique.length
  };


  await env.OFFERS.put(
    "latest",
    JSON.stringify(data)
  );


  return data;
}


/* =========================================================
   TELEGRAM API
========================================================= */

async function telegram(
  env,
  method,
  body = null
) {

  const response =
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {

        method:
          body
            ? "POST"
            : "GET",

        headers:
          body
            ? {
                "Content-Type":
                  "application/json"
              }
            : undefined,

        body:
          body
            ? JSON.stringify(body)
            : undefined
      }
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data.ok
  ) {

    throw new Error(
      data.description ||
      `Telegram ${method} error`
    );
  }


  return data.result;
}


/* =========================================================
   AMAZON CREATORS API
========================================================= */

async function creatorsToken(env) {

  if (
    !env.AMAZON_CREATORS_CLIENT_ID ||
    !env.AMAZON_CREATORS_CLIENT_SECRET
  ) {
    return "";
  }


  if (
    amazonTokenCache.token &&
    Date.now() <
      amazonTokenCache.expiresAt
  ) {
    return amazonTokenCache.token;
  }


  const response =
    await fetch(
      AMAZON_TOKEN_URL,
      {

        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            grant_type:
              "client_credentials",

            client_id:
              env.AMAZON_CREATORS_CLIENT_ID,

            client_secret:
              env.AMAZON_CREATORS_CLIENT_SECRET,

            scope:
              "creatorsapi::default"
          })
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();


    throw new Error(
      `Amazon token ${response.status}: ${errorText}`
    );
  }


  const data =
    await response.json();


  amazonTokenCache = {

    token:
      data.access_token,

    expiresAt:
      Date.now() +
      Math.max(
        60,
        (data.expires_in || 3600) - 120
      ) *
        1000
  };


  return data.access_token;
}


async function creatorsGetItem(
  env,
  asin
) {

  if (
    !asin ||
    !env.AMAZON_PARTNER_TAG
  ) {
    return null;
  }


  const token =
    await creatorsToken(env);


  if (!token) {
    return null;
  }


  const payload = {

    itemIds:
      [asin],

    itemIdType:
      "ASIN",

    marketplace:
      AMAZON_MARKETPLACE,

    partnerTag:
      env.AMAZON_PARTNER_TAG,

    resources: [

      "images.primary.large",

      "images.primary.medium",

      "itemInfo.title",

      "offersV2.listings.availability",

      "offersV2.listings.condition",

      "offersV2.listings.dealDetails",

      "offersV2.listings.merchantInfo",

      "offersV2.listings.price",

      "offersV2.listings.savings",

      "offersV2.listings.isBuyBoxWinner"
    ]
  };


  const response =
    await fetch(
      `${AMAZON_API}/getItems`,
      {

        method: "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${token}`,

          "x-marketplace":
            AMAZON_MARKETPLACE
        },

        body:
          JSON.stringify(payload)
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();


    console.error(
      "Creators API error:",
      response.status,
      errorText
    );


    return null;
  }


  const data =
    await response.json();


  return (
    data?.itemsResult?.items?.[0] ||
    null
  );
}


/* =========================================================
   AMAZON ENRICHMENT
========================================================= */

function enrichFromAmazon(
  offer,
  item
) {

  if (!item) {
    return offer;
  }


  const listings =
    item.offersV2?.listings ||
    [];


  const listing =
    listings.find(
      item =>
        item.isBuyBoxWinner
    ) ||
    listings[0];


  const price =
    listing?.price?.money;


  const saving =
    listing?.savings?.percentage;


  const savingBasis =
    listing?.price?.savingBasis?.money;


  const enriched = {

    ...offer,

    asin:
      item.asin ||
      offer.asin,

    titolo:
      item.itemInfo?.title?.displayValue ||
      offer.titolo,

    immagine_url:
      item.images?.primary?.large?.url ||
      item.images?.primary?.medium?.url ||
      offer.immagine_url ||
      "",

    link_affiliato:
      item.detailPageURL ||
      offer.link_affiliato,

    merchant:
      listing?.merchantInfo?.name ||
      offer.merchant ||
      "",

    condition:
      listing?.condition?.value ||
      offer.condition ||
      "",

    availability:
      listing?.availability?.type ||
      offer.availability ||
      ""
  };


  if (
    price?.amount != null
  ) {

    enriched.prezzo_scontato =
      `${Number(price.amount)
        .toFixed(2)
        .replace(".", ",")} €`;
  }


  if (
    saving != null
  ) {

    enriched.sconto_percentuale =
      `-${Math.round(
        Number(saving)
      )}%`;
  }


  if (
    savingBasis?.amount != null
  ) {

    enriched.prezzo_originale =
      `${Number(
        savingBasis.amount
      )
        .toFixed(2)
        .replace(".", ",")} €`;
  }


  return enriched;
}


async function enrich(
  env,
  offer
) {

  try {

    if (!offer.asin) {
      return offer;
    }


    const item =
      await creatorsGetItem(
        env,
        offer.asin
      );


    return enrichFromAmazon(
      offer,
      item
    );

  } catch (error) {

    console.error(
      "Amazon enrichment:",
      error
    );


    return offer;
  }
}


/* =========================================================
   ONESIGNAL
========================================================= */

async function notify(
  env,
  offer
) {

  if (
    !env.ONESIGNAL_APP_ID ||
    !env.ONESIGNAL_REST_API_KEY
  ) {
    return;
  }


  const title =
    offer.titolo ||
    "Nuova offerta";


  const discount =
    offer.sconto_percentuale
      ? ` · ${offer.sconto_percentuale}`
      : "";


  const response =
    await fetch(
      "https://api.onesignal.com/notifications",
      {

        method: "POST",

        headers: {

          Authorization:
            `Key ${env.ONESIGNAL_REST_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            app_id:
              env.ONESIGNAL_APP_ID,

            included_segments:
              ["Subscribed Users"],

            headings: {
              it:
                "🔥 Nuova offerta su Casa & Risparmio"
            },

            contents: {
              it:
                `${title}${discount}`
                  .slice(0, 120)
            },

            url:
              offer.link_affiliato ||
              offer.link_telegram_post ||
              SITE_URL,

            chrome_web_icon:
              `${SITE_URL}icon-192.png`
          })
      }
    );


  if (!response.ok) {

    console.error(
      "OneSignal error:",
      response.status,
      await response.text()
    );
  }
}


/* =========================================================
   SETUP KEY
========================================================= */

function authorisedSetup(
  url,
  env
) {

  return (
    env.SETUP_KEY &&
    url.searchParams.get(
      "key"
    ) ===
      env.SETUP_KEY
  );
}


/* =========================================================
   TELEGRAM PUBLIC CHANNEL SEED
 *
 * IMPORTANTE:
 *
 * Qui NON utilizziamo il webhook.
 *
 * Questa funzione legge lo storico del canale
 * direttamente da:
 *
 * https://t.me/s/CasaRisparmio
 *
 * e cerca il link Amazon anche nei pulsanti
 * inline sotto ogni post.
========================================================= */

async function seed(env) {

  const response =
    await fetch(
      `https://t.me/s/${CHANNEL_USERNAME}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0"
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      `Telegram ${response.status}`
    );
  }


  const html =
    await response.text();


  const blocks =
    html
      .split(
        '<div class="tgme_widget_message'
      )
      .slice(1)
      .reverse();


  const offers = [];
  const seen = new Set();


  for (
    const block of blocks
  ) {

    /*
     * ID del post.
     */
    const post =
      block.match(
        /data-post="([^"]+)"/i
      )?.[1] || "";


    const id =
      post
        .split("/")
        .at(-1);


    if (
      !id ||
      seen.has(id)
    ) {
      continue;
    }


    /*
     * =====================================================
     * TESTO DEL POST
     *
     * Supportiamo più varianti HTML di Telegram.
     * =====================================================
     */

    let textHtml =
      block.match(
        /<div[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
      )?.[1] || "";


    /*
     * Fallback nel caso Telegram modifichi il markup.
     */
    if (!textHtml) {

      textHtml =
        block.match(
          /<div[^>]*class="[^"]*message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i
        )?.[1] || "";
    }


    const text =
      stripHtml(
        textHtml
      );


    /*
     * =====================================================
     * LINK AMAZON
     *
     * PRIMA:
     * testo / href normale
     *
     * POI:
     * pulsanti inline sotto il post.
     * =====================================================
     */

    let link =
      amazonUrl(
        text
      );


    /*
     * Cerca TUTTI gli href presenti nel post.
     *
     * Questo è il punto fondamentale della correzione.
     */
    const hrefs = [];


    const hrefRegex =
      /href\s*=\s*["']([^"']+)["']/gi;


    let hrefMatch;


    while (
      (hrefMatch =
        hrefRegex.exec(block)) !== null
    ) {

      const href =
        cleanUrl(
          hrefMatch[1]
        );


      if (
        href &&
        !hrefs.includes(href)
      ) {

        hrefs.push(href);
      }
    }


    /*
     * Se il link non era nel testo,
     * cerchiamo tra tutti gli href del post.
     */
    if (!link) {

      link =
        hrefs.find(
          href =>
            isAmazonUrl(href)
        ) || "";
    }


    /*
     * Se ancora non c'è Amazon,
     * questo post non è un'offerta.
     */
    if (!link) {
      continue;
    }


    /*
     * =====================================================
     * IMMAGINE
     * =====================================================
     */

    const photo =
      block.match(
        /background-image:url\(['"]?([^'"\)]+)['"]?\)/i
      )?.[1] || "";


    /*
     * =====================================================
     * DATA
     * =====================================================
     */

    const date =
      block.match(
        /<time[^>]+datetime="([^"]+)"/i
      )?.[1] || "";


    /*
     * =====================================================
     * PREZZI
     * =====================================================
     */

    const parsedPrices =
      prices(text);


    /*
     * =====================================================
     * CREA OFFERTA
     * =====================================================
     */

    let offer = {

      id:
        String(id),

      titolo:
        cleanTitle(text),

      immagine_url:
        decode(photo),

      immagine_file_id:
        "",

      link_affiliato:
        link,

      link_telegram_post:
        `https://t.me/${post}`,

      asin:
        asinFromUrl(link),

      prezzo_originale:
        parsedPrices.prezzo_originale,

      prezzo_scontato:
        parsedPrices.prezzo_scontato,

      sconto_percentuale:
        parsedPrices.sconto_percentuale,

      data_pubblicazione:
        date
    };


    /*
     * Recupera titolo, immagine, prezzo ecc.
     * da Amazon quando possibile.
     */
    offer =
      await enrich(
        env,
        offer
      );


    offers.push(
      offer
    );


    seen.add(id);


    if (
      offers.length >=
      MAX_OFFERS
    ) {
      break;
    }
  }


  return writeOffers(
    env,
    offers
  );
}


/* =========================================================
   WORKER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    const origin =
      request.headers.get(
        "Origin"
      ) ||
      "";


    /* =====================================================
       OPTIONS
    ===================================================== */

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers:
            cors(origin)
        }
      );
    }


    /* =====================================================
       TELEGRAM WEBHOOK
    ===================================================== */

    if (
      url.pathname ===
        "/telegram" &&
      request.method ===
        "POST"
    ) {

      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get(
          "X-Telegram-Bot-Api-Secret-Token"
        ) !==
          env.TELEGRAM_WEBHOOK_SECRET
      ) {

        return new Response(
          "",
          {
            status: 401
          }
        );
      }


      try {

        const update =
          await request.json();


        const message =
          update.channel_post ||
          update.edited_channel_post ||
          null;


        if (!message) {

          return new Response(
            "ok"
          );
        }


        if (
          message.chat?.username &&
          message.chat.username
            .toLowerCase() !==
            CHANNEL_USERNAME.toLowerCase()
        ) {

          return new Response(
            "ok"
          );
        }


        let offer =
          fromMessage(
            message
          );


        /*
         * Se il post non contiene
         * un link Amazon né nel testo
         * né nei pulsanti, ignoriamo.
         */
        if (!offer) {

          return new Response(
            "ok"
          );
        }


        offer =
          await enrich(
            env,
            offer
          );


        const current =
          await readOffers(
            env
          );


        const old =
          (
            current.offerte ||
            []
          ).find(
            item =>
              item.id ===
              offer.id
          );


        const next =
          old

            ? (
                current.offerte ||
                []
              ).map(
                item =>
                  item.id ===
                  offer.id
                    ? {
                        ...item,
                        ...offer
                      }
                    : item
              )

            : [
                offer,
                ...(
                  current.offerte ||
                  []
                )
              ];


        await writeOffers(
          env,
          next
        );


        /*
         * Notifica solamente le nuove offerte.
         */
        if (!old) {

          await notify(
            env,
            offer
          );
        }


        return new Response(
          "ok"
        );


      } catch (error) {

        console.error(
          "Telegram webhook error:",
          error
        );


        /*
         * Telegram deve ricevere 200,
         * altrimenti può ritentare
         * l'aggiornamento.
         */
        return new Response(
          "ok"
        );
      }
    }


    /* =====================================================
       LIVE OFFERS
    ===================================================== */

    if (
      url.pathname ===
        "/offers" &&
      request.method ===
        "GET"
    ) {

      try {

        return json(
          await readOffers(
            env
          ),
          200,
          origin
        );

      } catch {

        return json(
          {
            offerte: [],
            ultimo_aggiornamento:
              null,
            conteggio: 0
          },
          200,
          origin
        );
      }
    }


    /* =====================================================
       TELEGRAM IMAGE PROXY
    ===================================================== */

    if (
      url.pathname ===
        "/image" &&
      request.method ===
        "GET"
    ) {

      const fileId =
        url.searchParams.get(
          "file_id"
        );


      if (
        !fileId ||
        !env.TELEGRAM_BOT_TOKEN
      ) {

        return new Response(
          "",
          {
            status: 404
          }
        );
      }


      try {

        const file =
          await telegram(
            env,
            "getFile",
            {
              file_id:
                fileId
            }
          );


        const image =
          await fetch(
            `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
          );


        return new Response(
          image.body,
          {

            status:
              image.status,

            headers: {

              "Content-Type":
                image.headers.get(
                  "Content-Type"
                ) ||
                "image/jpeg",

              "Cache-Control":
                "public,max-age=600"
            }
          }
        );


      } catch {

        return new Response(
          "",
          {
            status: 404
          }
        );
      }
    }


    /* =====================================================
       SETUP / SEED / STATUS
    ===================================================== */

    if (
      [
        "/setup",
        "/seed",
        "/status"
      ].includes(
        url.pathname
      ) &&
      request.method ===
        "GET"
    ) {

      if (
        !authorisedSetup(
          url,
          env
        )
      ) {

        return new Response(
          "",
          {
            status: 403
          }
        );
      }


      try {

        /*
         * -------------------------------------------------
         * SETUP WEBHOOK
         * -------------------------------------------------
         */

        if (
          url.pathname ===
          "/setup"
        ) {

          const result =
            await telegram(
              env,
              "setWebhook",
              {

                url:
                  `${url.origin}/telegram`,

                secret_token:
                  env.TELEGRAM_WEBHOOK_SECRET,

                allowed_updates: [
                  "channel_post",
                  "edited_channel_post"
                ],

                drop_pending_updates:
                  false
              }
            );


          return json(
            {
              ok: true,
              webhook:
                result
            },
            200,
            origin
          );
        }


        /*
         * -------------------------------------------------
         * SEED STORICO CANALE
         * -------------------------------------------------
         */

        if (
          url.pathname ===
          "/seed"
        ) {

          return json(
            await seed(
              env
            ),
            200,
            origin
          );
        }


        /*
         * -------------------------------------------------
         * STATUS WEBHOOK
         * -------------------------------------------------
         */

        return json(
          await telegram(
            env,
            "getWebhookInfo"
          ),
          200,
          origin
        );


      } catch (error) {

        return json(
          {
            ok: false,
            error:
              error.message
          },
          500,
          origin
        );
      }
    }


    /* =====================================================
       NOT FOUND
    ===================================================== */

    return new Response(
      "",
      {
        status: 404
      }
    );
  }
};
