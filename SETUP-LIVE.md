# Casa & Risparmio — Vetrina professionale + Creators API

## Cosa è cambiato

La home è stata rifatta seguendo il nuovo concept: logo reale Casa & Risparmio, hero premium, carousel responsive delle ultime offerte, icone SVG pulite, social, notifiche e CTA più commerciali.

I social sono già incorporati:
- Telegram: https://t.me/CasaRisparmio
- Facebook: https://www.facebook.com/CasaRisparmioOfferte/
- Pinterest: https://it.pinterest.com/CasaRisparmio/

Non devi modificare questi link.

## Creators API: ora lavora dietro le quinte

Quando Telegram riceve un post con un link Amazon, il Worker:
1. riconosce l'ASIN;
2. interroga Amazon Creators API;
3. aggiorna titolo, immagine, prezzo, risparmio, venditore, condizione e disponibilità quando disponibili;
4. mantiene l'ultima offerta nella vetrina;
5. invia la notifica OneSignal.

Le credenziali Amazon NON vanno nel codice pubblico.

Nel Cloudflare Worker configura:
- `AMAZON_CREATORS_CLIENT_ID`
- `AMAZON_CREATORS_CLIENT_SECRET`
- `AMAZON_PARTNER_TAG`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `ONESIGNAL_APP_ID`
- `ONESIGNAL_REST_API_KEY`
- `SETUP_KEY`

Per Amazon Italia il Worker usa `www.amazon.it` e il token OAuth europeo.

## GitHub

Carica il contenuto della cartella principale dello ZIP nel repository.

Non servono:
- ricerca Amazon;
- filtri Amazon nella home;
- catalogo Amazon statico;
- GitHub Actions ogni 30 minuti;
- `amazon_creators.py`.

## Cloudflare

Crea una KV namespace e sostituisci `INSERISCI_KV_NAMESPACE_ID` in `api/wrangler.jsonc`.

Pubblica `api/worker.js` come Cloudflare Worker.

Dopo aver ottenuto l'URL del Worker, modifica solo:
`config.js`
e imposta:
`LIVE_API_BASE: "https://NOME-WORKER.workers.dev"`

Poi:
1. `/setup?key=LA-TUA-SETUP_KEY`
2. `/seed?key=LA-TUA-SETUP_KEY`
3. `/status?key=LA-TUA-SETUP_KEY`

Il bot Telegram deve essere amministratore di `@CasaRisparmio`.

## Nota sulle notifiche

OneSignal invia la notifica dal Worker quando arriva una nuova offerta; l'utente deve avere precedentemente accettato le notifiche dal browser.
