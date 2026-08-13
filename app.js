// Casa & Risparmio — logica frontend.
//
// Sezioni:
//   1. Config / helper di base
//   2. Ordinamento offerte (difesa lato client, oltre a quella del Worker)
//   3. Rendering card offerte
//   4. Scheda prodotto (modale): varianti + prodotti correlati
//   5. Notifiche push (OneSignal)
//   6. Bootstrap / wiring pagina

(() => {
  const cfg = window.CASA_RISPARMIO_CONFIG || {};
  const api = String(cfg.LIVE_API_BASE || "").replace(/\/$/, "");
  const tg = cfg.TELEGRAM_URL || "https://t.me/CasaRisparmio";
  const social = cfg.SOCIAL || {};

  const $ = id => document.getElementById(id);

  const esc = v => {
    const d = document.createElement("div");
    d.textContent = v ?? "";
    return d.innerHTML;
  };

  /* =========================================================
     2. ORDINAMENTO OFFERTE
     Difesa finale lato client: anche se una risposta vecchia/legacy
     arrivasse non ordinata, la home mostra sempre il più recente a sinistra.
  ========================================================= */

  function dateValue(v) {
    const t = Date.parse(v || "");
    return Number.isFinite(t) ? t : 0;
  }

  function offerIdValue(o) {
    const n = Number.parseInt(String(o?.id || ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function normalizeOffers(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();

    return list
      .filter(o => o && o.id)
      .filter(o => {
        const id = String(o.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => {
        const byDate = dateValue(b.data_pubblicazione) - dateValue(a.data_pubblicazione);
        return byDate || (offerIdValue(b) - offerIdValue(a));
      })
      .slice(0, 10);
  }

  /* =========================================================
     3. RENDERING CARD OFFERTE
  ========================================================= */

  function imageFor(o) {
    if (o.immagine_url) return o.immagine_url;
    if (o.immagine_file_id && api) return `${api}/image?file_id=${encodeURIComponent(o.immagine_file_id)}`;
    return "";
  }

  function timeLabel(v) {
    const d = new Date(v || 0);
    if (Number.isNaN(d.getTime())) return "";
    return (
      d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" }) +
      " · " +
      d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    );
  }

  function availabilityLabel(type) {
    const map = {
      IN_STOCK_SCARCE: { label: "Ultimi pezzi", cls: "tag-amber" },
      OUT_OF_STOCK: { label: "Non disponibile", cls: "tag-grey" },
      UNAVAILABLE: { label: "Non disponibile", cls: "tag-grey" },
      PREORDER: { label: "Preordinabile", cls: "tag-blue" },
      AVAILABLE_DATE: { label: "Disponibile a breve", cls: "tag-blue" }
    };
    return map[type] || null;
  }

  const placeholderIcon =
    `<span class="deal-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="#94a0ad" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-5 3.5 4 2.5-3 4 4"/></svg></span>`;

  // Le offerte correnti restano in memoria (per asin/id) così la scheda
  // prodotto può aprirsi istantaneamente senza rifare fetch di ciò che
  // già abbiamo.
  let currentOffers = [];

  function card(o, index) {
    const img = imageFor(o);
    const discount = String(o.sconto_percentuale || "").replace(/^-/, "");
    const price = o.prezzo_scontato || "";
    const old = o.prezzo_originale || "";
    const title = o.titolo || "Occasione da scoprire";
    const meta = [o.brand, o.merchant, o.condition].filter(Boolean).join(" · ");
    const avail = availabilityLabel(o.availability);

    return `<article class="deal" data-offer-id="${esc(o.id)}">
      <div class="deal-media">
        <button class="deal-media-btn" data-open="${esc(o.id)}" aria-label="Dettagli offerta: ${esc(title)}">
          ${img ? `<img loading="${index < 4 ? "eager" : "lazy"}" src="${esc(img)}" alt="${esc(title)}">` : placeholderIcon}
        </button>
        ${discount ? `<span class="deal-badge">-${esc(discount)}${discount.includes("%") ? "" : "%"}</span>` : ""}
        ${index === 0 ? `<span class="deal-new">PIÙ RECENTE</span>` : ""}
      </div>
      <div class="deal-body">
        <button class="deal-title" data-open="${esc(o.id)}">${esc(title)}</button>
        ${price ? `<div class="deal-price">${esc(price)}${old ? ` <span class="deal-old">${esc(old)}</span>` : ""}</div>` : ""}
        ${meta || avail || o.deal_badge ? `<div class="deal-tags">
          ${meta ? `<span class="deal-meta">${esc(meta)}</span>` : ""}
          ${avail ? `<span class="deal-chip ${avail.cls}">${esc(avail.label)}</span>` : ""}
          ${o.deal_badge ? `<span class="deal-chip tag-blue">${esc(o.deal_badge)}</span>` : ""}
        </div>` : ""}
        ${o.data_pubblicazione ? `<div class="deal-time"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Pubblicata ${esc(timeLabel(o.data_pubblicazione))}</div>` : ""}
        <a class="btn amazon-btn" href="${esc(o.link_affiliato || "#")}" target="_blank" rel="noopener noreferrer nofollow sponsored">
          <span class="amazon-logo">a</span> Apri su Amazon <span>›</span>
        </a>
      </div>
    </article>`;
  }

  function updateLastUpdated(v) {
    const el = $("last-updated");
    if (!el) return;
    const d = new Date(v || 0);
    if (!v || Number.isNaN(d.getTime())) { el.textContent = ""; return; }
    el.textContent = ` · Aggiornato alle ${d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`;
  }

  let signature = "";

  function render(data) {
    const list = normalizeOffers(data?.offerte);
    currentOffers = list;
    updateLastUpdated(data?.ultimo_aggiornamento);

    const el = $("offers");
    if (!list.length) {
      el.innerHTML = '<div class="empty">Le nuove occasioni stanno arrivando. Torna presto.</div>';
      return;
    }

    const sig = list.map(o => `${o.id}:${o.data_pubblicazione || ""}`).join("|");
    if (sig === signature) return;
    signature = sig;
    el.innerHTML = list.map(card).join("");
  }

  async function load() {
    try {
      if (api) {
        const r = await fetch(`${api}/offers?ts=${Date.now()}`, { cache: "no-store" });
        if (r.ok) { render(await r.json()); return; }
      }
      const r = await fetch(`./latest_deal.json?ts=${Date.now()}`, { cache: "no-store" });
      if (r.ok) render(await r.json());
    } catch (e) {
      // Fallback silenzioso: la home resta utilizzabile anche durante un refresh API.
    }
  }

  /* =========================================================
     3b. ARTICOLI (bozze generate da Gemini, approvate su Telegram)
     Stessa logica difensiva delle offerte: la sezione resta
     nascosta (attributo "hidden" nell'HTML) finché non arriva
     almeno un articolo pubblicato.
  ========================================================= */

  let currentArticles = [];

  function articleCard(a) {
    const img = a.immagine_url || "";
    return `<article class="article-card">
      <button class="article-media" data-open-article="${esc(a.id)}" aria-label="Leggi l'articolo: ${esc(a.titolo)}">
        ${img ? `<img loading="lazy" src="${esc(img)}" alt="${esc(a.titolo)}">` : placeholderIcon}
      </button>
      <div class="article-body">
        <button class="article-title" data-open-article="${esc(a.id)}">${esc(a.titolo)}</button>
        ${a.estratto ? `<p class="article-excerpt">${esc(a.estratto)}</p>` : ""}
        <button class="btn btn-yellow article-read" data-open-article="${esc(a.id)}">Leggi l'articolo <span>›</span></button>
      </div>
    </article>`;
  }

  function renderArticles(list) {
    currentArticles = Array.isArray(list) ? list : [];
    const section = $("articoli-section");
    const el = $("articles");
    if (!section || !el) return;

    if (!currentArticles.length) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    el.innerHTML = currentArticles.map(articleCard).join("");
  }

  async function loadArticles() {
    if (!api) return;
    try {
      const r = await fetch(`${api}/articles?ts=${Date.now()}`, { cache: "no-store" });
      if (r.ok) renderArticles((await r.json())?.articoli);
    } catch (e) {
      // Fallback silenzioso, come per le offerte: la home resta usabile.
    }
  }

  function articleModalHtml(a) {
    const img = a.immagine_url || "";
    return `
      <div class="article-modal-main">
        ${img ? `<div class="article-modal-image"><img src="${esc(img)}" alt="${esc(a.titolo || "")}"></div>` : ""}
        <p class="modal-title">${esc(a.titolo || "")}</p>
        <div class="article-modal-body">${a.corpo_html || ""}</div>
        <div class="affiliate-disclosure">Link di affiliazione Amazon: se acquisti da qui, Casa &amp; Risparmio può ricevere una commissione, senza costi aggiuntivi per te.</div>
        ${a.link_affiliato ? `<a class="btn amazon-btn" style="margin-top:14px" href="${esc(a.link_affiliato)}" target="_blank" rel="noopener noreferrer nofollow sponsored"><span class="amazon-logo">a</span> Apri su Amazon <span>›</span></a>` : ""}
      </div>`;
  }

  function openArticle(article) {
    const overlay = $("product-modal");
    const body = $("modal-body");
    if (!overlay || !body) return;

    lastFocused = document.activeElement;
    body.innerHTML = articleModalHtml(article);
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    $("modal-close")?.focus();
  }

  function wireArticles() {
    $("articles")?.addEventListener("click", event => {
      const trigger = event.target.closest("[data-open-article]");
      if (!trigger) return;
      const article = currentArticles.find(a => String(a.id) === trigger.dataset.openArticle);
      if (article) openArticle(article);
    });
  }

  /* =========================================================
     4. SCHEDA PRODOTTO (modale): varianti + correlati
  ========================================================= */

  function productMainHtml(o) {
    const img = imageFor(o);
    const meta = [o.brand, o.merchant, o.condition].filter(Boolean).join(" · ");

    return `
      <div class="modal-media">${img ? `<img src="${esc(img)}" alt="${esc(o.titolo || "")}">` : placeholderIcon}</div>
      <div>
        <p class="modal-title">${esc(o.titolo || "Occasione da scoprire")}</p>
        ${meta ? `<div class="modal-meta">${esc(meta)}</div>` : ""}
        <div class="modal-price">${esc(o.prezzo_scontato || "")}${o.prezzo_originale ? ` <span class="deal-old">${esc(o.prezzo_originale)}</span>` : ""}</div>
        <a class="btn amazon-btn" style="margin-top:14px" href="${esc(o.link_affiliato || "#")}" target="_blank" rel="noopener noreferrer nofollow sponsored">
          <span class="amazon-logo">a</span> Apri su Amazon <span>›</span>
        </a>
      </div>`;
  }

  function variantCard(v) {
    const label = (v.attributi || []).map(a => a.valore).filter(Boolean).join(", ") || "Variante";
    return `<a class="variant-card" href="${esc(v.url || "#")}" target="_blank" rel="noopener noreferrer nofollow sponsored">
      ${v.immagine_url ? `<img src="${esc(v.immagine_url)}" alt="${esc(label)}">` : ""}
      <span>${esc(label)}</span>
    </a>`;
  }

  function relatedCard(p) {
    return `<a class="related-card" href="${esc(p.url || "#")}" target="_blank" rel="noopener noreferrer nofollow sponsored">
      ${p.immagine_url ? `<img src="${esc(p.immagine_url)}" alt="${esc(p.titolo || "")}">` : ""}
      <strong>${esc(p.titolo || "")}</strong>
      ${p.prezzo ? `<em>${esc(p.prezzo)}</em>` : ""}
    </a>`;
  }

  function extraSectionHtml(id, title, items, renderItem) {
    if (!items || !items.length) return "";
    return `<div class="modal-section">
      <h3>${esc(title)}</h3>
      <div class="modal-scroll">${items.map(renderItem).join("")}</div>
    </div>`;
  }

  let lastFocused = null;

  function openProduct(offer) {
    const overlay = $("product-modal");
    const body = $("modal-body");
    if (!overlay || !body) return;

    lastFocused = document.activeElement;

    body.innerHTML = `<div class="modal-main">${productMainHtml(offer)}</div>
      <div class="modal-loading" id="modal-extra">Carico varianti e prodotti correlati…</div>`;

    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    $("modal-close")?.focus();

    if (!api || !offer.asin) {
      const extra = $("modal-extra");
      if (extra) extra.remove();
      return;
    }

    const params = new URLSearchParams({
      asin: offer.asin,
      brand: offer.brand || "",
      title: offer.titolo || ""
    });

    fetch(`${api}/product?${params.toString()}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : { varianti: [], correlati: [] }))
      .then(data => {
        const extra = $("modal-extra");
        if (!extra) return;

        const html =
          extraSectionHtml("varianti", "Varianti disponibili", data.varianti, variantCard) +
          extraSectionHtml("correlati", "Prodotti simili", data.correlati, relatedCard);

        if (html) extra.outerHTML = html;
        else extra.remove();
      })
      .catch(() => {
        const extra = $("modal-extra");
        if (extra) extra.remove();
      });
  }

  function closeProduct() {
    const overlay = $("product-modal");
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    lastFocused?.focus?.();
  }

  function wireProductModal() {
    $("offers")?.addEventListener("click", event => {
      const trigger = event.target.closest("[data-open]");
      if (!trigger) return;
      const offer = currentOffers.find(o => String(o.id) === trigger.dataset.open);
      if (offer) openProduct(offer);
    });

    $("modal-close")?.addEventListener("click", closeProduct);

    $("product-modal")?.addEventListener("click", event => {
      if (event.target.id === "product-modal") closeProduct();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !$("product-modal")?.hidden) closeProduct();
    });
  }

  /* =========================================================
     5. NOTIFICHE PUSH (OneSignal)
     Il bottone riflette lo stato reale della sottoscrizione
     (optedIn) e resta sincronizzato anche se cambia altrove
     (altra tab, cambio di permesso nel browser, ecc.) grazie
     all'evento "change" di PushSubscription.
  ========================================================= */

  function setNotifyUI(optedIn) {
    document.querySelectorAll(".js-notify").forEach(btn => {
      const label = btn.querySelector(".notify-label");
      if (label) label.textContent = optedIn ? "Disattiva notifiche" : "Attiva notifiche";
      btn.setAttribute("aria-pressed", optedIn ? "true" : "false");
      btn.classList.toggle("is-active", !!optedIn);
    });
  }

  function initNotifyUI() {
    if (!window.OneSignalDeferred) return;
    OneSignalDeferred.push(function (OneSignal) {
      setNotifyUI(OneSignal.User.PushSubscription.optedIn);
      OneSignal.User.PushSubscription.addEventListener("change", event => {
        setNotifyUI(event.current.optedIn);
      });
    });
  }

  // Il toggle non si fida solo dell'evento "change" di PushSubscription per
  // aggiornare l'interfaccia (in alcuni browser/tempistiche non scatta in
  // modo affidabile dopo optOut/optIn, ed è per questo che il pulsante
  // "Disattiva notifiche" a volte sembrava non fare nulla): dopo ogni
  // azione rileggiamo subito lo stato reale e aggiorniamo l'UI a mano.
  // "notifyBusy" evita doppi click mentre la chiamata è in corso.
  let notifyBusy = false;

  function toggleNotifications() {
    if (!window.OneSignalDeferred || notifyBusy) return;
    notifyBusy = true;

    OneSignalDeferred.push(async O => {
      try {
        if (O.User.PushSubscription.optedIn) {
          await O.User.PushSubscription.optOut();
        } else if (O.Notifications.permission) {
          // Permesso del browser già concesso in passato: riattiviamo
          // subito, senza rimostrare il prompt.
          await O.User.PushSubscription.optIn();
        } else {
          await O.Slidedown.promptPush();
        }
      } catch (error) {
        console.error("OneSignal notify toggle error:", error);
      } finally {
        // Rilettura esplicita: non basta l'evento "change", che in alcuni
        // browser non arriva subito (o non arriva affatto) dopo optOut().
        setNotifyUI(O.User.PushSubscription.optedIn);
        notifyBusy = false;
      }
    });
  }

  /* =========================================================
     6. BOOTSTRAP
  ========================================================= */

  function wireNav() {
    $("prev")?.addEventListener("click", () => $("offers").scrollBy({ left: -430, behavior: "smooth" }));
    $("next")?.addEventListener("click", () => $("offers").scrollBy({ left: 430, behavior: "smooth" }));

    ["hero-tg", "all-tg", "tg-mini", "tg-card"].forEach(id => { const e = $(id); if (e) e.href = tg; });
    ["fb-mini", "fb-card"].forEach(id => { const e = $(id); if (e && social.facebook) e.href = social.facebook; });
    ["pin-mini", "pin-card"].forEach(id => { const e = $(id); if (e && social.pinterest) e.href = social.pinterest; });

    $("notify-btn")?.addEventListener("click", toggleNotifications);
    $("notify-main")?.addEventListener("click", toggleNotifications);
  }

  /* =========================================================
     7. COOKIE — banner e preferenze
     Consenso salvato in localStorage sul dispositivo dell'utente,
     nessun cookie/servizio di terze parti viene caricato per
     mostrare questo banner.
  ========================================================= */

  const COOKIE_KEY = "cr_cookie_consent";

  function readConsent() {
    try {
      const raw = localStorage.getItem(COOKIE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveConsent(partial) {
    try { localStorage.setItem(COOKIE_KEY, JSON.stringify({ necessary: true, ...partial, ts: Date.now() })); }
    catch (e) {}
  }

  function applyConsentToToggles(consent) {
    const push = $("cookie-toggle-push");
    const marketing = $("cookie-toggle-marketing");
    if (push) push.checked = consent?.push !== false;
    if (marketing) marketing.checked = consent?.marketing !== false;
  }

  function openCookiePrefs() {
    applyConsentToToggles(readConsent() || { push: true, marketing: true });
    $("cookie-modal")?.removeAttribute("hidden");
  }

  function closeCookiePrefs() { $("cookie-modal")?.setAttribute("hidden", ""); }

  function wireCookies() {
    if (!readConsent()) $("cookie-banner")?.removeAttribute("hidden");

    $("cookie-accept-all")?.addEventListener("click", () => {
      saveConsent({ push: true, marketing: true });
      $("cookie-banner")?.setAttribute("hidden", "");
    });

    $("cookie-reject")?.addEventListener("click", () => {
      saveConsent({ push: false, marketing: false });
      $("cookie-banner")?.setAttribute("hidden", "");
    });

    ["cookie-open-prefs", "cookie-prefs-link"].forEach(id => {
      $(id)?.addEventListener("click", event => { event.preventDefault(); openCookiePrefs(); });
    });

    $("cookie-modal-close")?.addEventListener("click", closeCookiePrefs);
    $("cookie-modal")?.addEventListener("click", event => {
      if (event.target.id === "cookie-modal") closeCookiePrefs();
    });

    $("cookie-modal-reject")?.addEventListener("click", () => {
      saveConsent({ push: false, marketing: false });
      $("cookie-banner")?.setAttribute("hidden", "");
      closeCookiePrefs();
    });

    $("cookie-save-prefs")?.addEventListener("click", () => {
      saveConsent({
        push: !!$("cookie-toggle-push")?.checked,
        marketing: !!$("cookie-toggle-marketing")?.checked
      });
      $("cookie-banner")?.setAttribute("hidden", "");
      closeCookiePrefs();
    });
  }

  wireNav();
  wireProductModal();
  wireArticles();
  wireCookies();
  initNotifyUI();

  load();
  setInterval(load, 10000);

  loadArticles();
  setInterval(loadArticles, 60000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
