// ============================================
// config.js — modifica solo questo file con i tuoi dati
// ============================================
const CONFIG = {

  // Google Apps Script — incolla qui il tuo URL dopo il deploy
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzxN0iDqQCQXgGyRbYXbNwgpJFwJ3Aryd2KagSCU8JpJ_fYkGnySTIp4Vt65-ziVDk7/exec',

  // Generali
  NEGOZIO_NOME:      'Annie Boutique',
  VALUTA:            '€',
  // Apps Script serializza le richieste per utente: un intervallo troppo
  // corto riempie la coda e fa aspettare i salvataggi dietro al polling.
  POLLING_INTERVAL:  5000,  // millisecondi tra un poll e l'altro sul portale

};
