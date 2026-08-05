"""
update_deal.py
----------------
Estrae le ultime offerte reali pubblicate sul canale Telegram pubblico
"Casa & Risparmio" e le sincronizza in latest_deal.json, letto da index.html.

Girato via GitHub Actions (cron + workflow_dispatch).
"""

import json
import re
import sys
import time
import datetime
import requests
from bs4 import BeautifulSoup

import os

URL_CANALE = "https://t.me/s/CasaRisparmio"
NOME_CANALE = "CasaRisparmio"
OUTPUT_JSON = "latest_deal.json"
NUMERO_OFFERTE = 4  # quante offerte recenti mostrare in home
URL_SITO = "https://infratron.github.io/offerte-casa-risparmio/"

# Notifiche push (OneSignal, piano gratuito). Le credenziali NON vanno mai
# scritte qui: si impostano come secret della GitHub Action
# (Settings > Secrets and variables > Actions) e arrivano come variabili
# d'ambiente. Se mancano, l'invio delle notifiche viene semplicemente
# saltato: il resto dello script funziona comunque.
ONESIGNAL_APP_ID = "75ba7be8-51e2-446c-b6c3-742effa95386"
ONESIGNAL_REST_API_KEY = os.environ.get("ONESIGNAL_REST_API_KEY", "")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

TIMEOUT_SECONDI = 15
TENTATIVI_MAX = 3
ATTESA_TRA_TENTATIVI = 4  # secondi, cresce ad ogni retry

# Caratteri emoji comuni nei post: li rimuoviamo dal testo mostrato in home
# perche' il rendering varia da dispositivo a dispositivo (spesso diventano
# icone generiche o quadratini), risultando poco professionale.
EMOJI_PATTERN = re.compile(
    "["
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0001F1E6-\U0001F1FF"
    "\u2190-\u21FF"
    "\u2B00-\u2BFF"
    "\uFE0F"
    "]+",
    flags=re.UNICODE,
)


def scarica_pagina_canale():
    """Scarica l'HTML della pagina web pubblica del canale, con retry."""
    ultimo_errore = None
    for tentativo in range(1, TENTATIVI_MAX + 1):
        try:
            risposta = requests.get(URL_CANALE, headers=HEADERS, timeout=TIMEOUT_SECONDI)
            risposta.raise_for_status()
            return risposta.text
        except requests.exceptions.RequestException as e:
            ultimo_errore = e
            print(f"[Tentativo {tentativo}/{TENTATIVI_MAX}] Errore di connessione: {e}")
            if tentativo < TENTATIVI_MAX:
                time.sleep(ATTESA_TRA_TENTATIVI * tentativo)
    print(f"Impossibile raggiungere il canale dopo {TENTATIVI_MAX} tentativi: {ultimo_errore}")
    return None


def rimuovi_emoji(testo):
    return EMOJI_PATTERN.sub("", testo).strip()


def riga_e_tutta_maiuscola(riga):
    lettere = [c for c in riga if c.isalpha()]
    return bool(lettere) and all(c.isupper() for c in lettere)


def estrai_etichetta_e_titolo(testo_completo):
    """
    In molti post la prima riga e' un'etichetta promozionale in maiuscolo
    ("MINIMO STORICO", "OFFERTA LAMPO"...) e il nome vero del prodotto arriva
    dopo. Separiamo i due concetti: l'etichetta diventa un badge, il titolo
    e' la prima riga leggibile che NON e' tutta maiuscola.
    """
    etichetta = ""
    titolo = ""

    for riga_raw in testo_completo.split("\n"):
        riga = rimuovi_emoji(riga_raw)
        riga = re.sub(r"^[\s\-\*•:]+|[\s\-\*•:]+$", "", riga)

        contenuto_alfanumerico = re.sub(r"[^\w]", "", riga, flags=re.UNICODE)
        if len(contenuto_alfanumerico) < 3:
            continue

        if riga_e_tutta_maiuscola(riga) and len(riga) <= 40:
            if not etichetta:
                etichetta = riga.title()
            continue

        titolo = riga[:100]
        break

    if not titolo:
        titolo = etichetta if etichetta else "Offerta del giorno"

    return etichetta, titolo


def estrai_prezzi(testo_completo):
    """
    Estrae prezzo originale, prezzo scontato e percentuale di sconto.
    IMPORTANTE: non assumiamo un ordine fisso nel testo (l'immagine del post
    e la didascalia non seguono sempre la stessa sequenza). Il prezzo piu'
    basso trovato e' sempre quello scontato, il piu' alto quello originale.
    """
    prezzo_originale = ""
    prezzo_scontato = ""
    sconto_percentuale = ""

    match_percentuale = re.search(r"(\d{1,3})\s*%", testo_completo)
    if match_percentuale:
        sconto_percentuale = f"{match_percentuale.group(1)}%"

    prezzi_grezzi = re.findall(r"(\d{1,4}[.,]\d{2})\s*€", testo_completo)

    prezzi_per_valore = {}
    for prezzo_testo in prezzi_grezzi:
        valore = float(prezzo_testo.replace(",", "."))
        if valore not in prezzi_per_valore:
            prezzi_per_valore[valore] = f"{prezzo_testo} €"

    valori_ordinati = sorted(prezzi_per_valore.keys())
    if len(valori_ordinati) >= 2:
        prezzo_scontato = prezzi_per_valore[valori_ordinati[0]]
        prezzo_originale = prezzi_per_valore[valori_ordinati[-1]]
    elif len(valori_ordinati) == 1:
        prezzo_scontato = prezzi_per_valore[valori_ordinati[0]]

    return prezzo_originale, prezzo_scontato, sconto_percentuale


def estrai_link_post(messaggio):
    """Ricostruisce il link diretto al post Telegram."""
    data_post = messaggio.get("data-post")  # es: "CasaRisparmio/1234"
    if data_post:
        return f"https://t.me/s/{data_post}"
    return f"https://t.me/s/{NOME_CANALE}"


def estrai_data_pubblicazione(messaggio):
    """Legge la data/ora reale del post dal tag <time>, se presente."""
    tag_time = messaggio.find("time")
    if tag_time and tag_time.get("datetime"):
        return tag_time["datetime"]
    return ""


def analizza_messaggio(messaggio):
    testo_div = messaggio.find("div", class_="tgme_widget_message_text")
    testo_completo = testo_div.get_text(separator="\n").strip() if testo_div else ""

    immagine_url = ""
    foto_wrap = messaggio.find("a", class_="tgme_widget_message_photo_wrap")
    if foto_wrap:
        style = foto_wrap.get("style", "")
        match = re.search(r"background-image:url\('(.*?)'\)", style)
        if match:
            immagine_url = match.group(1)

    link_affiliato = ""
    link_tag = messaggio.find("a", href=re.compile(r"amzn\.to|amazon\.it"))
    if link_tag:
        link_affiliato = link_tag.get("href", "")

    return {
        "testo_completo": testo_completo,
        "immagine_url": immagine_url,
        "link_affiliato": link_affiliato,
        "link_telegram_post": estrai_link_post(messaggio),
        "data_pubblicazione": estrai_data_pubblicazione(messaggio),
    }


def e_unofferta_valida(dati_messaggio):
    """Un post entra in home se ha testo + link Amazon.
    L'immagine e' preferibile, ma non bloccante: se manca, la card usa un fallback
    visivo invece di sparire dalla home."""
    return bool(
        dati_messaggio["testo_completo"]
        and dati_messaggio["link_affiliato"]
    )


def costruisci_offerta(dati_messaggio):
    etichetta, titolo = estrai_etichetta_e_titolo(dati_messaggio["testo_completo"])
    prezzo_originale, prezzo_scontato, sconto_percentuale = estrai_prezzi(
        dati_messaggio["testo_completo"]
    )
    return {
        "etichetta": etichetta,
        "titolo": titolo,
        "immagine_url": dati_messaggio["immagine_url"] or "",
        "link_affiliato": dati_messaggio["link_affiliato"],
        "link_telegram_post": dati_messaggio["link_telegram_post"],
        "prezzo_originale": prezzo_originale,
        "prezzo_scontato": prezzo_scontato,
        "sconto_percentuale": sconto_percentuale,
        "data_pubblicazione": dati_messaggio["data_pubblicazione"],
    }


def estrai_ultime_offerte(numero_offerte=NUMERO_OFFERTE):
    html = scarica_pagina_canale()
    if html is None:
        return None

    soup = BeautifulSoup(html, "html.parser")
    messaggi = soup.find_all("div", class_="tgme_widget_message")

    if not messaggi:
        print("Nessun messaggio trovato nel canale (la pagina potrebbe aver cambiato struttura).")
        return None

    offerte = []
    for messaggio in reversed(messaggi):
        dati = analizza_messaggio(messaggio)
        if e_unofferta_valida(dati):
            offerte.append(costruisci_offerta(dati))
        if len(offerte) >= numero_offerte:
            break

    if not offerte:
        print(
            "Nessuna offerta valida trovata negli ultimi "
            f"{len(messaggi)} messaggi (serve testo + immagine + link Amazon)."
        )
        return None

    return offerte


def leggi_link_offerte_precedenti():
    """Legge il JSON gia' pubblicato per capire quali offerte sono gia' note.
    Usato solo per non notificare due volte lo stesso prodotto."""
    try:
        with open(OUTPUT_JSON, "r", encoding="utf-8") as f:
            dati_precedenti = json.load(f)
        return {
            o.get("link_telegram_post", "")
            for o in dati_precedenti.get("offerte", [])
            if o.get("link_telegram_post")
        }
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def invia_notifica_push(offerte_nuove):
    """Invia una notifica push (OneSignal) per le offerte non ancora
    pubblicate in precedenza. Non fa nulla se le credenziali non sono
    configurate, cosi' lo script resta utilizzabile anche senza notifiche."""
    if not ONESIGNAL_APP_ID or not ONESIGNAL_REST_API_KEY:
        print("Notifiche push non configurate (variabili ONESIGNAL_* assenti): salto l'invio.")
        return
    if not offerte_nuove:
        return

    prima_offerta = offerte_nuove[0]
    if len(offerte_nuove) == 1:
        titolo_notifica = "Nuova offerta pubblicata"
        corpo_notifica = prima_offerta["titolo"]
        if prima_offerta.get("sconto_percentuale"):
            corpo_notifica += f" — sconto {prima_offerta['sconto_percentuale']}"
    else:
        titolo_notifica = f"{len(offerte_nuove)} nuove offerte pubblicate"
        corpo_notifica = ", ".join(o["titolo"] for o in offerte_nuove[:3])

    corpo_richiesta = {
        "app_id": ONESIGNAL_APP_ID,
        "included_segments": ["Subscribed Users"],
        "headings": {"it": titolo_notifica},
        "contents": {"it": corpo_notifica},
        "url": URL_SITO,
        "chrome_web_icon": f"{URL_SITO.rstrip('/')}/icon-192.png",
    }

    try:
        risposta = requests.post(
            "https://api.onesignal.com/notifications",
            headers={
                "Authorization": f"Key {ONESIGNAL_REST_API_KEY}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json=corpo_richiesta,
            timeout=TIMEOUT_SECONDI,
        )
        if risposta.status_code >= 400:
            print(f"Invio notifica fallito ({risposta.status_code}): {risposta.text}")
        else:
            print(f"Notifica push inviata per {len(offerte_nuove)} offerta/e.")
    except requests.exceptions.RequestException as e:
        print(f"Errore durante l'invio della notifica push: {e}")


def aggiorna_file_json():
    link_gia_noti = leggi_link_offerte_precedenti()

    offerte = estrai_ultime_offerte()

    if not offerte:
        print("Impossibile aggiornare il JSON: nessuna offerta valida. Il file esistente non viene toccato.")
        return False

    offerte_nuove = [
        o for o in offerte
        if o.get("link_telegram_post") and o["link_telegram_post"] not in link_gia_noti
    ]

    dati_output = {
        "offerte": offerte,
        "ultimo_aggiornamento": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(dati_output, f, ensure_ascii=False, indent=4)

    titoli = ", ".join(o["titolo"] for o in offerte)
    print(f"Sito aggiornato con {len(offerte)} offerte: {titoli}")

    if link_gia_noti:  # niente notifiche al primissimo run (eviterebbe uno spam iniziale)
        invia_notifica_push(offerte_nuove)

    return True


if __name__ == "__main__":
    successo = aggiorna_file_json()
    sys.exit(0 if successo else 1)
