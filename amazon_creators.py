"""
amazon_creators.py
-------------------
Interroga la Amazon Creators API (la nuova API che ha sostituito la
Product Advertising API v5, ritirata da Amazon il 15 maggio 2026) per
costruire un catalogo di offerte reali, gia' divise per categoria, che
il tool di ricerca del sito usa per filtrare per parola chiave e sconto
minimo senza dover interrogare Amazon in tempo reale dal browser
(le credenziali non possono mai stare lato client).

Va eseguito periodicamente da GitHub Actions, nello stesso workflow
(o in uno separato) di update_deal.py.

Credenziali richieste, SOLO come variabili d'ambiente / secret di
GitHub Actions, mai scritte nel codice:
- AMAZON_CREATORS_CLIENT_ID       (es. amzn1.application-oa2-client....)
- AMAZON_CREATORS_CLIENT_SECRET   (es. amzn1.oa2-cs.v1....)

Facoltative:
- AMAZON_PARTNER_TAG        (default: infra0ac-21)
- AMAZON_MARKETPLACE        (default: www.amazon.it)
- AMAZON_CREDENTIAL_VERSION (default: 3.2, l'area EU mostrata su
  Associati Central > Creators API al momento della creazione della
  credenziale)

Se le credenziali non sono presenti, lo script non fa nulla e non
blocca il resto della pipeline (update_deal.py continua a funzionare
anche senza questo modulo).

Nota tecnica: la Creators API e' molto recente e la forma esatta delle
risposte non e' ancora ben documentata pubblicamente. Le richieste qui
seguono la documentazione ufficiale di migrazione da PA-API 5 nota al
momento della scrittura; se una chiamata fallisce, il corpo della
risposta di errore viene salvato in amazon_catalog_debug.json per poter
capire cosa correggere.
"""

import os
import json
import datetime
import requests

CLIENT_ID = os.environ.get("AMAZON_CREATORS_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("AMAZON_CREATORS_CLIENT_SECRET", "")
PARTNER_TAG = os.environ.get("AMAZON_PARTNER_TAG", "infra0ac-21")
MARKETPLACE = os.environ.get("AMAZON_MARKETPLACE", "www.amazon.it")
CREDENTIAL_VERSION = os.environ.get("AMAZON_CREDENTIAL_VERSION", "3.2")

# Endpoint di autenticazione (Login with Amazon). Cambia in base all'area
# geografica della credenziale (mostrata su Associati Central):
#   3.1 = Nord America    -> api.amazon.com
#   3.2 = Europa           -> api.amazon.co.uk   (quella creata da voi)
#   3.3 = Estremo Oriente   -> api.amazon.co.jp
TOKEN_ENDPOINT_PER_VERSIONE = {
    "3.1": "https://api.amazon.com/auth/o2/token",
    "3.2": "https://api.amazon.co.uk/auth/o2/token",
    "3.3": "https://api.amazon.co.jp/auth/o2/token",
}

API_BASE = "https://creatorsapi.amazon/catalog/v1"
OUTPUT_JSON = "amazon_catalog.json"
DEBUG_JSON = "amazon_catalog_debug.json"

# Categoria mostrata nel sito -> parola chiave usata per la ricerca reale.
CATEGORIE = {
    "casa": "casa",
    "cucina": "cucina",
    "elettrodomestici": "elettrodomestici",
    "elettronica": "elettronica",
    "giardino": "giardino outdoor",
    "fai da te": "fai da te bricolage",
}

TIMEOUT = 15


def first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if value:
                return value
        else:
            text = str(value).strip()
            if text:
                return text
    return ""


def nested(obj, *path):
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def ottieni_token():
    if not CLIENT_ID or not CLIENT_SECRET:
        return None

    url = TOKEN_ENDPOINT_PER_VERSIONE.get(CREDENTIAL_VERSION, TOKEN_ENDPOINT_PER_VERSIONE["3.2"])
    corpo = {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "creatorsapi::default",
    }
    try:
        r = requests.post(url, json=corpo, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json().get("access_token")
    except requests.exceptions.RequestException as e:
        print(f"Errore nell'ottenere il token Amazon Creators API: {e}")
        return None


def cerca_categoria(token, parola_chiave, numero_risultati=20):
    headers = {
        "Authorization": f"Bearer {token}",
        "x-marketplace": MARKETPLACE,
        "Content-Type": "application/json",
    }
    corpo = {
        "keywords": parola_chiave,
        "itemCount": numero_risultati,
        "partnerTag": PARTNER_TAG,
        "partnerType": "Associates",
        "marketplace": MARKETPLACE,
        # Chiediamo anche il prezzo di listino (SavingBasis) per calcolare
        # lo sconto reale, non solo il prezzo scontato.
        "resources": [
            "ItemInfo.Title",
            "Images.Primary.Medium",
            "Offers.Listings.Price",
            "Offers.Listings.SavingBasis",
            "Offers.Listings.MerchantInfo",
            "Offers.Listings.Condition",
            "Offers.Listings.Availability",
        ],
    }
    try:
        r = requests.post(f"{API_BASE}/searchItems", headers=headers, json=corpo, timeout=TIMEOUT)
        if r.status_code >= 400:
            print(f"Ricerca '{parola_chiave}' fallita ({r.status_code}): {r.text[:300]}")
            with open(DEBUG_JSON, "w", encoding="utf-8") as f:
                f.write(r.text)
            return []
        return normalizza_risultati(r.json())
    except requests.exceptions.RequestException as e:
        print(f"Errore di rete cercando '{parola_chiave}': {e}")
        return []




def normalizza_risultati(dati_grezzi):
    """
    La forma esatta della risposta puo' variare (API nuova, poco
    documentata pubblicamente): proviamo le chiavi piu' plausibili e
    ignoriamo silenziosamente un singolo prodotto se manca qualcosa,
    invece di far fallire l'intera categoria.
    """
    risultati = []
    elementi = dati_grezzi.get("items") or dati_grezzi.get("searchResult", {}).get("items") or []
    visti = set()

    for el in elementi:
        try:
            titolo = first_non_empty(
                nested(el, "itemInfo", "title", "displayValue"),
                el.get("title"),
            )
            immagine = first_non_empty(
                nested(el, "images", "primary", "medium", "url"),
                el.get("imageUrl"),
            )
            listini = (el.get("offers") or {}).get("listings") or [{}]
            listino = listini[0] if listini else {}

            prezzo_scontato = first_non_empty(
                nested(listino, "price", "displayAmount"),
                nested(listino, "price", "amount"),
            )
            prezzo_originale = first_non_empty(
                nested(listino, "savingBasis", "displayAmount"),
            )

            sconto = ""
            risparmio = listino.get("saving") or listino.get("savings") or {}
            if risparmio:
                valore = first_non_empty(risparmio.get("percentage"), risparmio.get("percent"))
                if valore:
                    sconto = f"{valore}%"

            venditore = first_non_empty(
                nested(listino, "merchantInfo", "name"),
                nested(listino, "merchant", "name"),
                nested(listino, "seller", "name"),
                nested(el, "merchantInfo", "name"),
            )
            condizione = first_non_empty(
                listino.get("condition"),
                nested(listino, "condition", "value"),
                nested(listino, "condition", "displayValue"),
            )
            disponibilita = first_non_empty(
                nested(listino, "availability", "displayValue"),
                listino.get("availabilityMessage"),
                listino.get("availability"),
            )
            stato_oggetto = first_non_empty(condizione, disponibilita)
            categoria = first_non_empty(el.get("browseNodeName"), el.get("category"), el.get("department"))
            link = first_non_empty(el.get("detailPageURL"), el.get("detailPageUrl"))

            # Evita duplicati della stessa ASIN/URL quando Amazon restituisce
            # lo stesso articolo in più risultati.
            chiave = first_non_empty(el.get("asin"), el.get("ASIN"), link)
            if not titolo or not link or chiave in visti:
                continue
            visti.add(chiave)

            if titolo and link:
                risultati.append({
                    "titolo": str(titolo)[:120],
                    "immagine_url": immagine or "",
                    "prezzo_scontato": str(prezzo_scontato or ""),
                    "prezzo_originale": str(prezzo_originale or ""),
                    "sconto_percentuale": sconto,
                    "venditore": venditore,
                    "condizione": condizione,
                    "disponibilita": disponibilita,
                    "stato_oggetto": stato_oggetto,
                    "categoria": categoria,
                    "link_affiliato": link,
                })
        except (AttributeError, IndexError, KeyError, TypeError):
            continue

    return risultati

def aggiorna_catalogo():
    token = ottieni_token()
    if not token:
        print("Amazon Creators API non configurata o token non ottenuto: catalogo di ricerca non aggiornato (il resto del sito funziona comunque).")
        return False

    catalogo = {}
    for chiave, parola in CATEGORIE.items():
        catalogo[chiave] = cerca_categoria(token, parola)

    dati_output = {
        "categorie": catalogo,
        "partner_tag": PARTNER_TAG,
        "ultimo_aggiornamento": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(dati_output, f, ensure_ascii=False, indent=4)

    totale = sum(len(v) for v in catalogo.values())
    print(f"Catalogo Amazon aggiornato: {totale} prodotti in {len(catalogo)} categorie.")
    return True


if __name__ == "__main__":
    aggiorna_catalogo()
