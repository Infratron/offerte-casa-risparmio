"""
update_deal.py
----------------
Estrae l'ultimo post pubblicato sul canale Telegram pubblico "Casa & Risparmio"
e sincronizza i dati in latest_deal.json, che viene poi letto da index.html.

Pensato per girare via GitHub Actions (cron + workflow_dispatch), quindi:
- niente input interattivo
- errori gestiti senza far crashare la action (exit code controllato)
- retry di base sulla richiesta HTTP, perché t.me a volte risponde 429/5xx
"""

import json
import re
import sys
import time
import datetime
import requests
from bs4 import BeautifulSoup

URL_CANALE = "https://t.me/s/CasaRisparmio"
NOME_CANALE = "CasaRisparmio"
OUTPUT_JSON = "latest_deal.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

TIMEOUT_SECONDI = 15
TENTATIVI_MAX = 3
ATTESA_TRA_TENTATIVI = 4  # secondi, cresce ad ogni retry


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


def pulisci_titolo(testo_completo):
    """
    Ricava un titolo leggibile dalla prima riga utile del post,
    scartando righe vuote o composte solo da emoji/simboli.
    """
    for riga in testo_completo.split("\n"):
        riga_pulita = riga.strip()
        # Scarta righe vuote o troppo corte per essere un titolo reale
        if len(re.sub(r"[^\w]", "", riga_pulita, flags=re.UNICODE)) < 3:
            continue
        return riga_pulita[:90].strip()
    return "Nuova offerta"


def estrai_prezzi(testo_completo):
    """
    Cerca nel testo del post: prezzo originale, prezzo scontato e percentuale
    di sconto. I formati dei post Telegram non sono garantiti, quindi ogni
    campo è opzionale: se non lo troviamo restituiamo stringa vuota invece
    di far fallire tutto lo scraping.
    """
    prezzo_originale = ""
    prezzo_scontato = ""
    sconto_percentuale = ""

    # Percentuale di sconto, es. "-44%" oppure "sconto del 44%"
    match_percentuale = re.search(r"(\d{1,3})\s*%", testo_completo)
    if match_percentuale:
        sconto_percentuale = f"{match_percentuale.group(1)}%"

    # Tutti i prezzi in formato italiano, es. "49,99 €" o "49,99€"
    prezzi_trovati = re.findall(r"(\d{1,4}[.,]\d{2})\s*€", testo_completo)
    if len(prezzi_trovati) >= 2:
        # Convenzione tipica nei post: prezzo pieno barrato per primo, poi il prezzo scontato
        prezzo_originale = f"{prezzi_trovati[0]} €"
        prezzo_scontato = f"{prezzi_trovati[1]} €"
    elif len(prezzi_trovati) == 1:
        prezzo_scontato = f"{prezzi_trovati[0]} €"

    return prezzo_originale, prezzo_scontato, sconto_percentuale


def estrai_link_post(messaggio):
    """Ricostruisce il link diretto al post Telegram, utile come CTA extra."""
    data_post = messaggio.get("data-post")  # es: "CasaRisparmio/1234"
    if data_post:
        return f"https://t.me/s/{data_post}"
    return f"https://t.me/s/{NOME_CANALE}"


def analizza_messaggio(messaggio):
    """
    Estrae tutti i campi di interesse da un singolo messaggio Telegram.
    Restituisce un dizionario, anche se alcuni campi sono vuoti: la decisione
    se il post e' "una vera offerta" spetta a chi chiama questa funzione.
    """
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
    }


def e_unofferta_valida(dati_messaggio):
    """
    Un post viene pubblicato in home solo se e' davvero un'offerta:
    testo, link affiliato Amazon E immagine. Cosi' evitiamo di mostrare
    in home messaggi di servizio, forward o post senza link.
    """
    return bool(
        dati_messaggio["testo_completo"]
        and dati_messaggio["link_affiliato"]
        and dati_messaggio["immagine_url"]
    )


def estrai_ultima_offerta():
    html = scarica_pagina_canale()
    if html is None:
        return None

    soup = BeautifulSoup(html, "html.parser")
    messaggi = soup.find_all("div", class_="tgme_widget_message")

    if not messaggi:
        print("Nessun messaggio trovato nel canale (la pagina potrebbe aver cambiato struttura).")
        return None

    # Scorri dal piu' recente al piu' vecchio e prendi il PRIMO che e' davvero
    # un'offerta (foto + link Amazon), non semplicemente l'ultimo messaggio
    # pubblicato, che potrebbe essere un post di servizio senza link.
    offerta_valida = None
    for messaggio in reversed(messaggi):
        dati = analizza_messaggio(messaggio)
        if e_unofferta_valida(dati):
            offerta_valida = dati
            break

    if offerta_valida is None:
        print(
            "Nessuna offerta valida trovata negli ultimi "
            f"{len(messaggi)} messaggi (serve testo + immagine + link Amazon)."
        )
        return None

    prezzo_originale, prezzo_scontato, sconto_percentuale = estrai_prezzi(
        offerta_valida["testo_completo"]
    )

    return {
        "titolo": pulisci_titolo(offerta_valida["testo_completo"]),
        "testo_completo": offerta_valida["testo_completo"],
        "immagine_url": offerta_valida["immagine_url"],
        "link_affiliato": offerta_valida["link_affiliato"],
        "link_telegram_post": offerta_valida["link_telegram_post"],
        "prezzo_originale": prezzo_originale,
        "prezzo_scontato": prezzo_scontato,
        "sconto_percentuale": sconto_percentuale,
        "ultimo_aggiornamento": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def aggiorna_file_json():
    dati = estrai_ultima_offerta()

    if not dati:
        print("Impossibile aggiornare il JSON: dati mancanti. Il file esistente non viene toccato.")
        return False

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(dati, f, ensure_ascii=False, indent=4)

    print(f"Sito aggiornato! Offerta '{dati['titolo']}' sincronizzata con Telegram.")
    return True


if __name__ == "__main__":
    successo = aggiorna_file_json()
    # Exit code non-zero se lo scraping fallisce, cosi la GitHub Action
    # segnala chiaramente l'errore invece di fare un commit "silenzioso" vuoto.
    sys.exit(0 if successo else 1)
