/*
 * sw.js — Service Worker di Casa & Risparmio
 * -------------------------------------------
 * Strategie:
 * - App shell (index.html, css inline, icone): cache-first, cosi' l'app
 *   si apre istantaneamente anche offline.
 * - latest_deal.json: network-first con fallback alla cache, cosi'
 *   l'utente vede sempre le offerte piu' fresche possibili quando e'
 *   online, ma non resta a schermo vuoto se e' offline.
 */

const CACHE_VERSION = 'cr-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomi) =>
      Promise.all(
        nomi
          .filter((nome) => nome !== CACHE_VERSION)
          .map((nome) => caches.delete(nome))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Dati delle offerte: sempre provare la rete prima (dati freschi),
  // in caso di errore si torna all'ultima versione salvata in cache.
  if (url.pathname.endsWith('latest_deal.json')) {
    event.respondWith(
      fetch(event.request)
        .then((risposta) => {
          const clone = risposta.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          return risposta;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Resto dell'app: cache-first con aggiornamento in background.
  event.respondWith(
    caches.match(event.request).then((cacheata) => {
      const fetchPromise = fetch(event.request)
        .then((risposta) => {
          if (risposta && risposta.status === 200) {
            const clone = risposta.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return risposta;
        })
        .catch(() => cacheata);
      return cacheata || fetchPromise;
    })
  );
});

// Notifiche push in arrivo da OneSignal vengono gestite dal suo stesso
// worker (OneSignalSDKWorker.js, importato a parte); questo worker gestisce
// solo l'app shell e i dati.
