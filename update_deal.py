import json
import datetime
import requests
from bs4 import BeautifulSoup
import re

# URL della versione web pubblica del tuo canale Casa & Risparmio
URL_CANALE = "https://t.me/s/CasaRisparmio"

def estrai_ultima_offerta():
    # Simuliamo un browser per non farci bloccare da Telegram
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(URL_CANALE, headers=headers)
        response.raise_for_status()
    except Exception as e:
        print(f"Errore di connessione a Telegram: {e}")
        return None
        
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Trova tutti i messaggi visibili nella pagina web del canale
    messaggi = soup.find_all('div', class_='tgme_widget_message')
    
    if not messaggi:
        print("Nessun messaggio trovato nel canale.")
        return None
        
    # Prendi l'assoluto ultimo messaggio (il più recente) in fondo
    ultimo_messaggio = messaggi[-1]
    
    # 1. Estrai il testo completo del post
    testo_div = ultimo_messaggio.find('div', class_='tgme_widget_message_text')
    testo_completo = testo_div.get_text(separator='\n') if testo_div else "Nessun testo"
    
    # 2. Estrai l'immagine di copertina
    immagine_url = ""
    foto_wrap = ultimo_messaggio.find('a', class_='tgme_widget_message_photo_wrap')
    if foto_wrap:
        style = foto_wrap.get('style', '')
        # Usa le regex per tirare fuori l'URL dall'attributo background-image CSS
        match = re.search(r"background-image:url\('(.*?)'\)", style)
        if match:
            immagine_url = match.group(1)
            
    # 3. Estrai il Link Affiliato Amazon
    link_affiliato = ""
    # Cerca il primo link cliccabile che contiene amzn.to o amazon.it
    link_tag = ultimo_messaggio.find('a', href=re.compile(r'amzn\.to|amazon\.it'))
    if link_tag:
        link_affiliato = link_tag.get('href')

    # Costruisci i dati da inviare alla Landing Page
    # Nota: la prima riga del testo viene usata provvisoriamente come titolo
    offerta_corrente = {
        "titolo": testo_completo.split('\n')[0][:80], 
        "testo_completo": testo_completo,
        "immagine_url": immagine_url,
        "link_affiliato": link_affiliato,
        "ultimo_aggiornamento": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    
    return offerta_corrente

def aggiorna_file_json():
    dati = estrai_ultima_offerta()
    
    if dati:
        # Sovrascrive latest_deal.json con l'offerta appena prelevata da Telegram
        with open('latest_deal.json', 'w', encoding='utf-8') as f:
            json.dump(dati, f, ensure_ascii=False, indent=4)
        print("Sito aggiornato! Ultima offerta sincronizzata con Telegram.")
    else:
        print("Impossibile aggiornare il JSON. Dati mancanti.")

if __name__ == "__main__":
    aggiorna_file_json()
