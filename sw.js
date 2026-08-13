// SDK OneSignal importato qui (e non in un service worker separato) per
// evitare che due worker diversi si contendano lo stesso scope "/": se il
// browser lascia attivo questo worker invece di quello OneSignal, i push
// arrivano comunque ma senza handler restano senza notifica visibile, e
// Chrome mostra il fallback generico "Questo sito si è aggiornato in
// background". Con l'SDK unito qui dentro c'è una sola registrazione,
// un solo scope, e il push viene sempre gestito correttamente.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const CACHE = "casa-risparmio-v7";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json", "./favicon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // I dati live non devono mai essere serviti da una cache vecchia.
  if (url.pathname.endsWith("latest_deal.json") || url.pathname.endsWith("/offers")) return;

  // Per HTML/CSS/JS del sito facciamo network-first: dopo un nuovo deploy
  // la home non resta bloccata sulla versione precedente cache-first.
  if (url.origin === location.origin &&
      (event.request.mode === "navigate" ||
       url.pathname.endsWith("index.html") ||
       url.pathname.endsWith("config.js") ||
       url.pathname.endsWith("style.css") ||
       url.pathname.endsWith("app.js"))) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && url.origin === location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
