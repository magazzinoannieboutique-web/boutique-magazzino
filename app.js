// ============================================
// STATO GLOBALE
// ============================================
let prodottiCache = [];
let scanCorrente  = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {

  document.querySelectorAll('nav a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const sec = a.dataset.section;
      document.querySelectorAll('nav a').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.section').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
      document.getElementById('sec-' + sec).classList.add('active');
      if (sec === 'dashboard')  caricaDashboard();
      if (sec === 'inventario') caricaInventario();
      if (sec === 'etichette')  caricaEtichette();
      if (sec === 'storico')    caricaStorico();
    });
  });

  caricaDashboard();
  initVarianti();
  avviaPolling();
});

// ============================================
// API — fetch diretto (Apps Script risponde con CORS aperto).
// JSONP via <script src> è stato abbandonato: la catena di redirect
// di Apps Script a volte restituisce una pagina HTML intermedia che
// il browser esegue come script, rompendo la callback JSONP.
// fetch() segue i redirect HTTP nativamente senza questo rischio.
// ============================================
// 60s, non 30: Apps Script può metterci 8-30 secondi solo per avviare
// l'esecuzione. Con 30s si abortivano richieste che sarebbero riuscite,
// e per le scritture (non ritentabili) significava perdere il capo.
const TIMEOUT_MS = 60000;

async function chiamaApi(params) {
  const url = CONFIG.APPS_SCRIPT_URL + '?' + new URLSearchParams(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const testo = await res.text();
    return JSON.parse(testo);
  } finally {
    clearTimeout(timeout);
  }
}

// Azioni che MODIFICANO i dati: non vanno mai ritentate alla cieca.
// Apps Script può aver eseguito la scrittura e aver risposto oltre il timeout
// del browser: un retry creava una seconda riga (il capo caricato doppio).
const AZIONI_SCRITTURA = [
  'addProdotto', 'vendiProdotto', 'aggiornaQuantita',
  'addOpzione', 'aggiornaProdotto', 'eliminaProdotto',
];

async function api(params, tentativi = 2) {
  // Su una scrittura un solo tentativo: meglio un errore da riprovare a mano
  // che un doppione silenzioso.
  if (AZIONI_SCRITTURA.indexOf(params.action) !== -1) tentativi = 1;

  for (let i = 0; i < tentativi; i++) {
    try {
      return await chiamaApi(params);
    } catch (e) {
      if (i === tentativi - 1) throw e;
    }
  }
}

function apiPost(body) { return api(body); }

// Token univoco per rendere un inserimento ripetibile senza doppioni.
// Prefisso temporale: il server ordina per chiave per scartare i più vecchi.
function nuovoToken() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ============================================
// CACHE PRODOTTI — condivisa tra inventario, etichette e storico.
// Ognuno scaricava per conto proprio gli stessi ~360 KB: su Apps Script,
// che serve una richiesta alla volta, ogni download in meno conta.
// ============================================
let _cacheProdotti = null;
let _cacheTs        = 0;
let _cacheInCorso   = null;      // promise condivisa: evita download paralleli
const CACHE_TTL_MS  = 60000;

// I prodotti vengono ricordati nel browser: Apps Script fallisce a
// intermittenza (404 casuali) e senza memoria locale ogni apertura
// dipendeva da una richiesta che poteva non arrivare mai.
const LS_PRODOTTI = 'annie_prodotti_v1';

function leggiProdottiLocali() {
  try {
    const raw = localStorage.getItem(LS_PRODOTTI);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.prodotti) || !d.prodotti.length) return null;
    return d;
  } catch (e) { return null; }   // storage negato o dato corrotto
}

function salvaProdottiLocali(prodotti) {
  try {
    localStorage.setItem(LS_PRODOTTI, JSON.stringify({ prodotti, ts: Date.now() }));
  } catch (e) { /* spazio esaurito: non è critico */ }
}

// Scarica a blocchi invece di 330 KB in un colpo: un blocco che fallisce
// si ritenta da solo e costa pochi secondi, non quaranta.
const BLOCCO_SERVER = 200;

async function scaricaTuttiProdotti(onProgresso) {
  const tutti = [];
  let da = 0, totale = null;

  for (let giro = 0; giro < 40; giro++) {   // limite di sicurezza
    let pag = null;
    // Tre tentativi per blocco, con attesa crescente: i 404 sono casuali,
    // quindi ritentare lo stesso blocco funziona.
    for (let t = 0; t < 3; t++) {
      try {
        pag = await api({ action: 'getPagina', da, quanti: BLOCCO_SERVER }, 1);
        if (pag && Array.isArray(pag.prodotti)) break;
        pag = null;
      } catch (e) { pag = null; }
      if (t < 2) await new Promise(r => setTimeout(r, 1000 * (t + 1)));
    }
    if (!pag) throw new Error('Blocco non scaricato (da ' + da + ')');

    tutti.push(...pag.prodotti);
    if (totale === null) totale = pag.totale || 0;
    da += (pag.letti || pag.prodotti.length || BLOCCO_SERVER);

    if (onProgresso) onProgresso(Math.min(da, totale), totale);
    if (pag.fine) break;
  }

  return tutti;
}

async function getProdottiCached(forza = false, onProgresso = null) {
  const fresca = _cacheProdotti && (Date.now() - _cacheTs) < CACHE_TTL_MS;
  if (!forza && fresca) return _cacheProdotti;

  // Se un download è già in volo, ci si aggancia invece di farne un altro.
  if (_cacheInCorso) return _cacheInCorso;

  _cacheInCorso = (async () => {
    try {
      const dati = await scaricaTuttiProdotti(onProgresso);
      if (!dati.length) throw new Error('Nessun dato ricevuto');
      _cacheProdotti = dati;
      _cacheTs = Date.now();
      salvaProdottiLocali(dati);
      return dati;
    } finally {
      _cacheInCorso = null;
    }
  })();

  return _cacheInCorso;
}

// Dati mostrabili subito: memoria di sessione, poi quella del browser.
// Restituisce null se non c'è nulla di ricordato.
function prodottiSubito() {
  if (_cacheProdotti) return { prodotti: _cacheProdotti, ts: _cacheTs, fresco: true };
  const locali = leggiProdottiLocali();
  if (locali) {
    _cacheProdotti = locali.prodotti;   // riusabile da tutte le sezioni
    _cacheTs = 0;                       // 0 = da aggiornare
    return { prodotti: locali.prodotti, ts: locali.ts, fresco: false };
  }
  return null;
}

// "3 minuti fa", per dire quanto sono vecchi i dati mostrati.
function quantoFa(ts) {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1)  return 'ora';
  if (min < 60) return min + ' min fa';
  const ore = Math.floor(min / 60);
  if (ore < 24) return ore + (ore === 1 ? ' ora fa' : ' ore fa');
  const gg = Math.floor(ore / 24);
  return gg + (gg === 1 ? ' giorno fa' : ' giorni fa');
}

// Da chiamare dopo ogni scrittura, così la prossima lettura è fresca.
function invalidaCacheProdotti() {
  _cacheProdotti = null;
  _cacheTs = 0;
}

// ============================================
// POLLING — silenzioso, non blocca il tab
// ============================================
let pollingAttivo = true;

// UNA sola chiamata per ciclo (scan + riepilogo insieme) invece di due.
// Apps Script esegue una richiesta alla volta per utente: ogni richiesta di
// polling in più allunga la coda in cui finiscono anche i salvataggi.
// Il polling serve solo mentre si vende (il telefono manda le scansioni).
// Dopo un po' di inattività si sospende: 12 richieste/minuto per ore sono
// migliaia di esecuzioni inutili sul progetto Apps Script.
const POLL_PAUSA_MS = 20 * 60 * 1000;   // 20 minuti
let _ultimaAttivita = Date.now();

function segnalaAttivita() {
  const eraSospeso = (Date.now() - _ultimaAttivita) > POLL_PAUSA_MS;
  _ultimaAttivita = Date.now();
  if (eraSospeso) aggiornaStatoPolling();
}

function pollingSospeso() {
  return (Date.now() - _ultimaAttivita) > POLL_PAUSA_MS;
}

function aggiornaStatoPolling() {
  const el = document.getElementById('statoPolling');
  if (!el) return;
  if (pollingSospeso()) {
    el.innerHTML = '⏸ In attesa — <a href="#" onclick="segnalaAttivita();return false;" ' +
                   'style="color:var(--c4);">riattiva</a>';
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function avviaPolling() {
  // Qualunque interazione conta come "sono qui".
  ['click', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, segnalaAttivita, { passive: true }));

  async function tick() {
    // Tab in secondo piano o nessuna attività da 20 minuti: niente polling.
    // Una tab dimenticata aperta in negozio occupava la coda tutto il giorno.
    if (!pollingAttivo || document.hidden || pollingSospeso()) {
      aggiornaStatoPolling();
      setTimeout(tick, CONFIG.POLLING_INTERVAL);
      return;
    }

    try {
      const data = await api({ action: 'poll' });

      if (data.scan && !data.scan.error &&
          (!scanCorrente || scanCorrente.SKU !== data.scan.SKU)) {
        scanCorrente = data.scan;
        mostraModalScan(data.scan);
      }

      if (data.riepilogo && data.riepilogo.length) {
        mostraRiepilogo(data.riepilogo);
      }
    } catch(e) {}

    setTimeout(tick, CONFIG.POLLING_INTERVAL);
  }
  setTimeout(tick, CONFIG.POLLING_INTERVAL);
}

// ============================================
// MODAL SCANSIONE — solo visualizzazione, vende solo il telefono
// ============================================
function mostraModalScan(p) {
  document.getElementById('smSpeciale').style.display = p.Speciale === 'SI' ? 'block' : 'none';
  document.getElementById('smNome').textContent     = p.Nome;
  document.getElementById('smDettagli').textContent = [p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ');
  document.getElementById('smPrezzo').textContent   = '€ ' + p.Prezzo;
  document.getElementById('smStock').textContent    = 'In magazzino: ' + p.Quantità + ' pz';
  document.getElementById('scanModal').style.display = 'flex';
}

function chiudiScan() {
  scanCorrente = null;
  document.getElementById('scanModal').style.display = 'none';
}

// ============================================
// DASHBOARD — solo slogan, niente dati
// ============================================
function caricaDashboard() {}

// ============================================
// RIEPILOGO — arriva dal telefono, si chiude da solo dopo 15s
// ============================================
let _riepilogoTimer = null;

function mostraRiepilogo(capi) {
  if (_riepilogoTimer) clearTimeout(_riepilogoTimer);
  const totale = capi.reduce((s,c) => s + parseFloat(c.Prezzo||0), 0);
  document.getElementById('riepilogoSub').textContent =
    capi.length + (capi.length === 1 ? ' capo venduto' : ' capi venduti');
  document.getElementById('riepilogoLista').innerHTML = capi.map(c => `
    <div class="riepilogo-row">
      <div>
        <div class="riepilogo-nome">${c.Nome}</div>
        <div class="riepilogo-det">${[c.Taglia, c.Colore].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="riepilogo-prezzo">€ ${c.Prezzo}</div>
    </div>
  `).join('');
  document.getElementById('riepilogoTotale').textContent = '€ ' + totale.toFixed(2);

  // Barra progressiva 15s
  const bar = document.getElementById('riepilogoBar');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '100%';
    setTimeout(() => { bar.style.transition = 'width 15s linear'; bar.style.width = '0%'; }, 60);
  }

  document.getElementById('riepilogoModal').style.display = 'flex';
  _riepilogoTimer = setTimeout(() => chiudiRiepilogo(), 15000);
}

function chiudiRiepilogo() {
  if (_riepilogoTimer) { clearTimeout(_riepilogoTimer); _riepilogoTimer = null; }
  document.getElementById('riepilogoModal').style.display = 'none';
}

// ============================================
// INVENTARIO
// ============================================
async function caricaInventario() {
  const grid = document.getElementById('gridProdotti');

  // 1. Quello che c'è già, immediatamente: l'inventario è utilizzabile
  //    prima che il server risponda (e anche se non risponde).
  const subito = prodottiSubito();
  if (subito) {
    prodottiCache = subito.prodotti;
    popolaFiltriInventario();
    filtraInventario();
    if (!subito.fresco) statoDati('Dati di ' + quantoFa(subito.ts) + ' · aggiornamento...');
  } else {
    grid.innerHTML = '<div style="color:var(--c3); font-size:13px;">Caricamento...</div>';
  }

  // 2. Aggiornamento dal foglio. Se ci sono già dati a schermo l'errore non
  //    è bloccante: si continua a lavorare su quelli.
  try {
    prodottiCache = await getProdottiCached(true, (fatti, tot) => {
      if (tot) statoDati('Aggiornamento ' + fatti + '/' + tot + '...');
    });
    popolaFiltriInventario();
    filtraInventario();
    statoDati('');
  } catch (e) {
    if (subito) {
      statoDati('⚠️ Aggiornamento non riuscito — dati di ' + quantoFa(subito.ts) +
                ' <button onclick="caricaInventario()" class="btn btn-ghost" ' +
                'style="padding:4px 12px; font-size:12px; margin-left:8px;">Riprova</button>');
    } else {
      // Nessun dato di riserva: qui l'errore va detto e basta.
      prodottiCache = [];
      grid.innerHTML = `
        <div style="color:var(--c3); font-size:13px; line-height:1.6;">
          ⚠️ Caricamento non riuscito (il server non ha risposto).
          <button onclick="caricaInventario()" style="
            margin-top:10px; display:block; padding:8px 16px;
            border:1px solid rgba(91,135,160,0.3); background:white;
            color:#5b87a0; border-radius:10px; cursor:pointer; font-size:13px;
          ">Riprova</button>
        </div>`;
    }
  }
}

function popolaFiltriInventario() {
  const categorie = [...new Set(prodottiCache.map(p => p.Categoria).filter(Boolean))].sort();
  const selCat = document.getElementById('filtroCategoria');
  const catSel = selCat.value;   // non perdere il filtro attivo
  selCat.innerHTML = '<option value="">Tutte le categorie</option>';
  categorie.forEach(c => selCat.innerHTML += `<option value="${c}">${c}</option>`);
  selCat.value = catSel;

  const brand = [...new Set(prodottiCache.map(p => p.Brand).filter(Boolean))].sort();
  const selBrand = document.getElementById('filtroBrand');
  const brSel = selBrand.value;
  selBrand.innerHTML = '<option value="">Tutti i brand</option>';
  brand.forEach(b => selBrand.innerHTML += `<option value="${b}">${b}</option>`);
  selBrand.value = brSel;
}

// Riga di stato sopra l'inventario: età dei dati, avanzamento, errori.
function statoDati(html) {
  const el = document.getElementById('statoDati');
  if (!el) return;
  el.innerHTML = html || '';
  el.style.display = html ? 'block' : 'none';
}

function str(v) { return v == null ? '' : String(v).toLowerCase(); }

let _mostraEsauriti  = false;
let _modalitaSaldi   = false;

// Arrotondamento commerciale: ,01-,49 → difetto, ,50-,99 → eccesso
function arrotonda(prezzo) {
  const intero = Math.floor(prezzo);
  const dec    = prezzo - intero;
  return dec < 0.5 ? intero : intero + 1;
}

function calcolaSaldo(prezzoOriginale, pct) {
  if (!pct || pct <= 0) return null;
  const scontato = prezzoOriginale * (1 - pct / 100);
  return arrotonda(scontato);
}

function toggleEsauriti() {
  _mostraEsauriti = !_mostraEsauriti;
  document.getElementById('btnMostraEsauriti').classList.toggle('attivo', _mostraEsauriti);
  filtraInventario();
}

function toggleSaldi() {
  _modalitaSaldi = !_modalitaSaldi;
  const btn = document.getElementById('btnModalitaSaldi');
  btn.classList.toggle('attivo', _modalitaSaldi);
  btn.textContent = _modalitaSaldi ? '🏷 Esci da saldi' : '🏷 Saldi';
  filtraInventario();
}

function matchStagione(p, filtro) {
  return !filtro || !p.Stagione || p.Stagione === 'Tutte' || p.Stagione === filtro;
}

function filtraInventario() {
  const testo    = document.getElementById('filtroTesto').value.toLowerCase().trim();
  const cat      = document.getElementById('filtroCategoria').value;
  const brand    = document.getElementById('filtroBrand').value;
  const spec     = document.getElementById('filtroSpeciale').value;
  const stagione = document.getElementById('filtroStagione').value;
  renderProdotti(prodottiCache.filter(p =>
    (!testo || str(p.Nome).includes(testo) || str(p.SKU).includes(testo) || str(p.Brand).includes(testo)) &&
    (!cat   || p.Categoria === cat) &&
    (!brand || p.Brand === brand) &&
    (!spec  || p.Speciale === spec) &&
    matchStagione(p, stagione) &&
    (_mostraEsauriti || parseInt(p.Quantità) > 0)
  ));
}

function renderProdotti(lista) {
  const grid = document.getElementById('gridProdotti');
  if (!lista.length) { grid.innerHTML = '<div style="color:var(--c3);">Nessun prodotto trovato.</div>'; return; }

  grid.innerHTML = lista.map(p => {
    const prezzoBase  = parseFloat(p.Prezzo) || 0;
    const prezzoSaldo = parseFloat(p.PrezzoSaldo) || 0;
    const hasSaldo    = prezzoSaldo > 0;
    const pctCorrente = hasSaldo ? Math.round((1 - prezzoSaldo / prezzoBase) * 100) : '';

    const badgeSaldo = hasSaldo
      ? `<span class="badge badge-saldo">-${pctCorrente}% · €${prezzoSaldo}</span>`
      : '';

    const badgeStagione = p.Stagione === 'Estate' ? '<span class="badge">☀️</span>'
      : p.Stagione === 'Inverno' ? '<span class="badge">❄️</span>'
      : '';

    // Card normale
    if (!_modalitaSaldi) return `
      <div class="inv-card ${hasSaldo ? 'inv-card-insaldo' : ''}">
        <div class="inv-card-info">
          <div class="inv-card-badges">
            ${p.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️</span>' : ''}
            ${p.Categoria ? `<span class="badge">${p.Categoria}</span>` : ''}
            ${badgeStagione}
            ${badgeSaldo}
          </div>
          <div class="inv-card-nome">${p.Nome}</div>
          <div class="inv-card-sub">${[p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ')}</div>
          <div class="inv-card-bottom">
            ${hasSaldo ? `<span class="inv-prezzo-barrato">€ ${prezzoBase}</span>` : ''}
            <span class="inv-prezzo">€ ${hasSaldo ? prezzoSaldo : prezzoBase}</span>
            <span class="inv-qty ${parseInt(p.Quantità) <= 0 ? 'esaurito' : ''}">
              ${parseInt(p.Quantità) > 0 ? p.Quantità + ' pz' : 'Esaurito'}
            </span>
          </div>
          <button class="inv-edit" onclick="apriModifica('${p.SKU}')" title="Modifica">✏️</button>
        </div>
      </div>`;

    // Card modalità saldi — con input % inline
    return `
      <div class="inv-card inv-card-saldo-edit">
        <div class="inv-card-info">
          <div class="inv-card-nome">${p.Nome}</div>
          <div class="inv-card-sub">${[p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ')}</div>
          <div style="display:flex; align-items:center; gap:10px; margin-top:8px; flex-wrap:wrap;">
            <div style="font-size:13px; color:var(--c3); text-decoration:line-through;">€ ${prezzoBase}</div>
            <div style="display:flex; align-items:center; gap:6px;">
              <input
                type="number" min="0" max="90" step="5"
                value="${pctCorrente}"
                placeholder="%"
                id="saldo-${p.SKU}"
                oninput="aggiornaPrevSaldo('${p.SKU}', ${prezzoBase})"
                style="width:60px; padding:6px 10px; border:1px solid rgba(91,135,160,0.3);
                  border-radius:10px; font-size:13px; font-family:var(--font);
                  background:white; color:var(--c6); text-align:center;"
              ><span style="font-size:12px; color:var(--c3);">%</span>
            </div>
            <div id="prev-${p.SKU}" style="font-family:var(--serif); font-size:20px; font-weight:600; color:#b5451b; min-width:50px;">
              ${hasSaldo ? '€ ' + prezzoSaldo : ''}
            </div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; justify-content:center; gap:6px; padding:12px; flex-shrink:0;">
          <button onclick="applicaSaldo('${p.SKU}', ${prezzoBase})" style="
            padding:8px 14px; background:var(--c4); color:white;
            border:none; border-radius:999px; font-size:12px;
            cursor:pointer; font-family:var(--font); white-space:nowrap;
          ">✓ Applica</button>
          ${hasSaldo ? `<button onclick="rimuoviSaldo('${p.SKU}')" style="
            padding:8px 14px; background:rgba(181,69,27,0.08); color:#b5451b;
            border:1px solid rgba(181,69,27,0.2); border-radius:999px; font-size:12px;
            cursor:pointer; font-family:var(--font); white-space:nowrap;
          ">✕ Rimuovi</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function aggiornaPrevSaldo(sku, prezzoBase) {
  const pct    = parseFloat(document.getElementById('saldo-' + sku).value) || 0;
  const prev   = document.getElementById('prev-' + sku);
  const saldo  = calcolaSaldo(prezzoBase, pct);
  prev.textContent = saldo !== null && pct > 0 ? '€ ' + saldo : '';
}

async function applicaSaldo(sku, prezzoBase) {
  const pct   = parseFloat(document.getElementById('saldo-' + sku).value) || 0;
  const saldo = calcolaSaldo(prezzoBase, pct);
  if (!saldo || pct <= 0) { showToast('Inserisci una percentuale valida', 'error'); return; }
  const res = await api({ action: 'aggiornaProdotto', sku, PrezzoSaldo: saldo });
  if (res.success) {
    // aggiorna cache locale
    const p = prodottiCache.find(x => x.SKU === sku);
    if (p) p.PrezzoSaldo = saldo;
    showToast(`✅ Saldo applicato: € ${saldo}`, 'success');
    filtraInventario();
  } else showToast('❌ ' + (res.error || 'Errore'), 'error');
}

async function rimuoviSaldo(sku) {
  const res = await api({ action: 'aggiornaProdotto', sku, PrezzoSaldo: 0 });
  if (res.success) {
    const p = prodottiCache.find(x => x.SKU === sku);
    if (p) p.PrezzoSaldo = 0;
    showToast('Saldo rimosso', '');
    filtraInventario();
  } else showToast('❌ ' + (res.error || 'Errore'), 'error');
}

// ============================================
// MODAL MODIFICA PRODOTTO
// ============================================
function apriModifica(sku) {
  const p = prodottiCache.find(x => x.SKU === sku);
  if (!p) return;
  document.getElementById('mSKU').value           = p.SKU;
  document.getElementById('mNome').value          = p.Nome || '';
  document.getElementById('mCategoria').value     = p.Categoria || '';
  document.getElementById('mBrand').value         = p.Brand || '';
  document.getElementById('mTaglia').value        = p.Taglia || '';
  document.getElementById('mColore').value        = p.Colore || '';
  document.getElementById('mPrezzo').value        = p.Prezzo || '';
  document.getElementById('mPrezzoAcquisto').value= p.PrezzoAcquisto || '';
  document.getElementById('mQuantita').value      = p.Quantità || 0;
  document.getElementById('mSpeciale').value      = p.Speciale || 'NO';
  document.getElementById('mStagione').value      = p.Stagione || 'Tutte';
  document.getElementById('mNote').value          = p.Note || '';
  document.getElementById('modalModifica').style.display = 'flex';
}

function chiudiModifica() {
  document.getElementById('modalModifica').style.display = 'none';
}

async function salvaModifica() {
  const sku = document.getElementById('mSKU').value;
  const btn = document.querySelector('#modalModifica .btn-primary');
  btn.textContent = '⏳ Salvataggio...'; btn.disabled = true;

  const res = await api({
    action:         'aggiornaProdotto',
    sku,
    Nome:           document.getElementById('mNome').value.trim(),
    Categoria:      document.getElementById('mCategoria').value.trim(),
    Brand:          document.getElementById('mBrand').value.trim(),
    Taglia:         document.getElementById('mTaglia').value.trim().toUpperCase(),
    Colore:         document.getElementById('mColore').value.trim(),
    Prezzo:         document.getElementById('mPrezzo').value.replace(',', '.'),
    PrezzoAcquisto: document.getElementById('mPrezzoAcquisto').value.replace(',', '.'),
    Quantita:       document.getElementById('mQuantita').value,
    Speciale:       document.getElementById('mSpeciale').value,
    Stagione:       document.getElementById('mStagione').value,
    Note:           document.getElementById('mNote').value.trim(),
  });

  btn.textContent = '💾 Salva modifiche'; btn.disabled = false;

  if (res.success) {
    chiudiModifica();
    showToast('✅ Prodotto aggiornato', 'success');
    invalidaCacheProdotti();
    await caricaInventario();
    document.querySelector('nav a[data-section="inventario"]').click();
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

async function eliminaProdotto() {
  const sku = document.getElementById('mSKU').value;
  const nome = document.getElementById('mNome').value;
  if (!confirm(`Eliminare "${nome}"? Rimarrà nel database ma sparirà dall'app.`)) return;

  const btn = document.querySelector('#modalModifica .btn-danger');
  btn.textContent = '⏳'; btn.disabled = true;

  const res = await api({ action: 'eliminaProdotto', sku });
  btn.textContent = '🗑 Elimina'; btn.disabled = false;

  if (res.success) {
    chiudiModifica();
    showToast('🗑 Prodotto eliminato', '');
    invalidaCacheProdotti();
    await caricaInventario();
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}
// Token dell'ultimo inserimento non confermato, per un retry senza doppioni.
let _tokenInSospeso = { firma: null, tokens: [] };

// ============================================
// VARIANTI — una riga per capo: taglia, colore, quantità.
// Sostituisce i campi singoli con parsing di stringhe ("S,M,L" + "1,2,1"),
// che non potevano esprimere combinazioni come "1 M blu, 2 L rosse".
// ============================================
function rigaVariante(taglia = '', colore = '', qta = 1) {
  return `
    <div class="var-row">
      <input class="form-input var-taglia" placeholder="M" value="${escapeAttr(taglia)}"
             style="text-transform:uppercase;">
      <input class="form-input var-colore" placeholder="blu" value="${escapeAttr(colore)}">
      <input class="form-input var-qta" type="number" min="1" value="${qta}">
      <span class="var-azioni">
        <button type="button" class="var-btn var-btn-add" onclick="aggiungiVariante(this)"
                title="Aggiungi riga con lo stesso colore">+</button>
        <button type="button" class="var-btn var-btn-del" onclick="rimuoviVariante(this)"
                title="Rimuovi riga">✕</button>
      </span>
    </div>`;
}

// I valori vanno dentro un attributo HTML: senza escape, un apice in
// "blu chiaro 'vintage'" chiuderebbe l'attributo e romperebbe la riga.
function escapeAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initVarianti() {
  const c = document.getElementById('varianti');
  if (c) c.innerHTML = rigaVariante();
  aggiornaStatoVarianti();
}

// ============================================
// SALDO IN CARICAMENTO — stesso comportamento dell'inventario:
// il bottone si trasforma nell'input della percentuale, la ✕ lo annulla.
// ============================================
function apriSaldoCarica() {
  document.getElementById('btnSaldoCarica').style.display = 'none';
  document.getElementById('boxSaldoCarica').style.display = 'flex';
  document.getElementById('pSaldoPct').focus();
}

function annullaSaldoCarica() {
  document.getElementById('pSaldoPct').value = '';
  document.getElementById('boxSaldoCarica').style.display = 'none';
  document.getElementById('btnSaldoCarica').style.display = 'flex';
  document.getElementById('anteprimaSaldo').style.display = 'none';
}

// Mostra a quanto viene venduto, così la percentuale si verifica a occhio.
function aggiornaAnteprimaSaldo() {
  const el   = document.getElementById('anteprimaSaldo');
  const pct  = parseFloat(document.getElementById('pSaldoPct').value) || 0;
  const base = parseFloat((document.getElementById('pPrezzo').value || '').replace(',', '.')) || 0;
  const saldo = calcolaSaldo(base, pct);
  if (!saldo) { el.style.display = 'none'; return; }
  el.textContent = '→ € ' + saldo;
  el.style.display = 'block';
}

// Percentuale di saldo attiva, 0 se nessuna.
function saldoCaricaPct() {
  if (document.getElementById('boxSaldoCarica').style.display === 'none') return 0;
  return parseFloat(document.getElementById('pSaldoPct').value) || 0;
}

// Nuova riga subito sotto quella premuta, con lo stesso colore: caricando
// più taglie di un colore basta digitare la taglia.
function aggiungiVariante(btn) {
  const riga    = btn.closest('.var-row');
  const taglia  = riga.querySelector('.var-taglia');
  const colore  = riga.querySelector('.var-colore');

  // Riga vuota: aggiungerne un'altra creerebbe due capi identici.
  // Si segnala il campo invece di procedere in silenzio.
  if (!taglia.value.trim() && !colore.value.trim()) {
    riga.classList.add('var-row-errore');
    setTimeout(() => riga.classList.remove('var-row-errore'), 1200);
    taglia.focus();
    showToast('Compila taglia o colore prima di aggiungere una riga', 'error');
    return;
  }

  riga.insertAdjacentHTML('afterend', rigaVariante('', colore.value, 1));
  aggiornaStatoVarianti();
  const nuova = riga.nextElementSibling;
  if (nuova) nuova.querySelector('.var-taglia').focus();
}

function rimuoviVariante(btn) {
  const righe = document.querySelectorAll('#varianti .var-row');
  if (righe.length <= 1) {   // l'ultima si svuota, non si elimina
    const r = righe[0];
    r.querySelector('.var-taglia').value = '';
    r.querySelector('.var-colore').value = '';
    r.querySelector('.var-qta').value    = 1;
    return;
  }
  btn.closest('.var-row').remove();
  aggiornaStatoVarianti();
}

// Con una sola riga il pulsante di rimozione non serve.
function aggiornaStatoVarianti() {
  const righe = document.querySelectorAll('#varianti .var-row');
  righe.forEach(r => {
    const del = r.querySelector('.var-btn-del');
    if (del) del.style.visibility = righe.length > 1 ? 'visible' : 'hidden';
  });
}

// Legge le righe compilate. Una riga conta se ha taglia O colore: un capo
// senza varianti (taglia unica, colore non rilevante) resta valido.
function leggiVarianti() {
  return [...document.querySelectorAll('#varianti .var-row')].map(r => ({
    Taglia:   r.querySelector('.var-taglia').value.trim().toUpperCase(),
    Colore:   r.querySelector('.var-colore').value.trim(),
    Quantita: Math.max(1, parseInt(r.querySelector('.var-qta').value) || 1),
  }));
}

async function salvaProdotto() {
  const nome = document.getElementById('pNome').value.trim();
  if (!nome) { showToast('Il nome è obbligatorio', 'error'); return; }

  // Fix virgola→punto sui prezzi
  const prezzoStr         = document.getElementById('pPrezzo').value.replace(',', '.');
  const prezzoAcquistoStr = document.getElementById('pPrezzoAcquisto').value.replace(',', '.');

  // Saldo applicato in caricamento: si invia il prezzo scontato calcolato
  // con la stessa funzione usata dall'inventario.
  const pctSaldo = saldoCaricaPct();
  const prezzoSaldo = pctSaldo > 0
    ? (calcolaSaldo(parseFloat(prezzoStr) || 0, pctSaldo) || 0)
    : 0;

  const datiBase = {
    action:         'addProdotto',
    Nome:           nome,
    Categoria:      document.getElementById('pCategoria').value.trim(),
    Brand:          document.getElementById('pBrand').value.trim(),
    Prezzo:         prezzoStr,
    PrezzoAcquisto: prezzoAcquistoStr,
    PrezzoSaldo:    prezzoSaldo,
    Speciale:       document.getElementById('pSpeciale').value,
    Stagione:       document.getElementById('pStagione').value,
    Note:           document.getElementById('pNote').value.trim(),
  };

  const varianti = leggiVarianti();

  // Due righe con la stessa taglia E lo stesso colore sarebbero due capi
  // identici: quasi sempre un errore di battitura, non un'intenzione.
  const chiavi = varianti.map(v => v.Taglia + '|' + v.Colore.toLowerCase());
  const dupe = chiavi.find((k, i) => chiavi.indexOf(k) !== i);
  if (dupe !== undefined) {
    showToast('❌ Due righe hanno la stessa taglia e colore', 'error');
    return;
  }

  // Un token per variante: se il salvataggio va in timeout e lo riprovi, il
  // server riconosce il token e non crea una seconda riga.
  // I token di un tentativo interrotto vengono riusati al tentativo dopo —
  // è questo che rende sicuro ripremere Salva.
  const firmaInserimento = JSON.stringify([datiBase, varianti]);
  if (_tokenInSospeso.firma !== firmaInserimento) {
    _tokenInSospeso = {
      firma:  firmaInserimento,
      tokens: varianti.map(() => nuovoToken()),
    };
  }

  const tasks = varianti.map((v, i) => ({
    ...datiBase,
    ...v,
    token: _tokenInSospeso.tokens[i],
  }));

  const btn = document.getElementById('btnSalvaProdotto');
  btn.textContent = tasks.length > 1 ? `⏳ Salvataggio 0/${tasks.length}...` : '⏳ Salvataggio...';
  btn.disabled = true;

  const creati  = [];   // { SKU, Nome, Taglia, Colore, Prezzo, Quantità }
  const incerti = [];   // varianti la cui risposta non è arrivata
  let interrotto = false;

  // Ogni variante viene tentata, anche se una fallisce: prima un errore
  // interrompeva il ciclo e le varianti successive non venivano nemmeno
  // provate. Un timeout non significa "non salvato" — il server può aver
  // scritto e risposto troppo tardi — quindi quelle incerte si verificano
  // rileggendo il foglio, invece di essere scartate in silenzio.
  for (let i = 0; i < tasks.length; i++) {
    if (tasks.length > 1) btn.textContent = `⏳ Salvataggio ${i+1}/${tasks.length}...`;
    try {
      const res = await apiPost(tasks[i]);
      if (res && res.success) {
        creati.push({
          SKU:        res.sku,
          Nome:       nome,
          Taglia:     tasks[i].Taglia,
          Colore:     tasks[i].Colore,
          Brand:      datiBase.Brand,
          Prezzo:     parseFloat(prezzoStr) || 0,
          'Quantità': tasks[i].Quantita,
        });
      } else {
        // Errore esplicito del server: la riga non è stata scritta.
        interrotto = true;
        showToast('❌ ' + ((res && res.error) || 'Errore') +
                  ' (' + [tasks[i].Taglia, tasks[i].Colore].filter(Boolean).join(' ') + ')', 'error');
      }
    } catch (e) {
      // Timeout o rete: esito sconosciuto, da verificare sul foglio.
      incerti.push(tasks[i]);
      interrotto = true;
    }
  }

  btn.textContent = 'Salva prodotto';
  btn.disabled = false;

  // Recupero delle varianti incerte: si rilegge il foglio e si cerca la
  // combinazione nome+taglia+colore. Se c'è, era stata salvata.
  if (incerti.length) {
    btn.textContent = '⏳ Verifica...';
    btn.disabled = true;
    try {
      const attuali = await getProdottiCached(true);   // forza il ricarico
      let recuperate = 0;
      incerti.forEach(t => {
        const trovato = attuali.find(p =>
          str(p.Nome) === str(nome) &&
          str(p.Taglia) === str(t.Taglia) &&
          str(p.Colore) === str(t.Colore));
        if (trovato) {
          recuperate++;
          creati.push({
            SKU:        trovato.SKU,
            Nome:       trovato.Nome,
            Taglia:     trovato.Taglia,
            Colore:     trovato.Colore,
            Brand:      trovato.Brand,
            Prezzo:     parseFloat(trovato.Prezzo) || 0,
            'Quantità': parseInt(trovato['Quantità']) || 1,
          });
        }
      });
      const persi = incerti.length - recuperate;
      if (persi > 0) {
        showToast(`⚠️ ${persi} variante/i non salvata/e: ripremi Salva (non crea doppioni)`, 'error');
      }
    } catch (e) {
      showToast('⚠️ Connessione lenta: ripremi Salva per verificare (non crea doppioni)', 'error');
    } finally {
      btn.textContent = 'Salva prodotto';
      btn.disabled = false;
    }
  }

  // Tutto confermato: i token hanno esaurito il loro scopo. Senza questo
  // reset, reinserire lo stesso capo di proposito restituirebbe il primo SKU.
  if (!interrotto) _tokenInSospeso = { firma: null, tokens: [] };

  if (!creati.length) return;

  invalidaCacheProdotti();  // la lista in cache è superata

  const box = document.getElementById('skuGenerato');
  box.innerHTML = `✅ ${creati.length > 1 ? creati.length + ' capi salvati' : 'Capo salvato'}: <strong>${creati.map(c => c.SKU).join(', ')}</strong>`;
  box.style.display = 'block';
  showToast(`✅ ${creati.length} capo/i salvato/i`, 'success');

  // Reset: si mantengono nome, categoria, brand e prezzi per inserire
  // rapidamente un capo simile; le varianti ripartono da una riga vuota.
  initVarianti();
  if (!interrotto) {
    ['pNome','pCategoria','pBrand','pPrezzo','pPrezzoAcquisto','pNote'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    // Il saldo va azzerato: lasciarlo attivo lo applicherebbe di nascosto
    // al capo successivo.
    annullaSaldoCarica();
  }

  mostraEtichetteNuove(creati);
}

// ============================================
// MODAL ETICHETTE DEI CAPI APPENA CREATI
// Evita di dover cercare a mano i capi appena inseriti nella sezione
// Etichette per stamparli.
// ============================================
let _nuoviCreati = [];

function mostraEtichetteNuove(creati) {
  _nuoviCreati = creati;
  const modal = document.getElementById('modalNuoveEtichette');
  if (!modal) return;

  document.getElementById('neSub').textContent =
    creati.length + (creati.length === 1 ? ' capo creato' : ' capi creati');

  document.getElementById('neLista').innerHTML = creati.map((c, i) => `
    <label class="ne-row">
      <input type="checkbox" class="ne-check" value="${i}" checked>
      <span class="ne-info">
        <span class="ne-nome">${c.Nome}</span>
        <span class="ne-sub">${[c.Taglia, c.Colore].filter(Boolean).join(' · ')}${
          c['Quantità'] > 1 ? ' — ' + c['Quantità'] + ' etichette' : ''}</span>
      </span>
      <span class="ne-sku">${c.SKU}</span>
    </label>
  `).join('');

  aggiornaConteggioNuove();
  modal.style.display = 'flex';
}

function aggiornaConteggioNuove() {
  const scelti = [...document.querySelectorAll('.ne-check:checked')].map(c => +c.value);
  // Il totale conta le copie: un capo con 3 pezzi stampa 3 etichette.
  const copie = scelti.reduce((s, i) => s + (parseInt(_nuoviCreati[i]['Quantità']) || 1), 0);
  const btn = document.getElementById('neStampa');
  if (btn) {
    btn.textContent = `🖨 Stampa (${copie})`;
    btn.disabled = copie === 0;
  }
}

function chiudiNuoveEtichette() {
  const m = document.getElementById('modalNuoveEtichette');
  if (m) m.style.display = 'none';
  _nuoviCreati = [];
}

function stampaNuoveEtichette() {
  const scelti = [...document.querySelectorAll('.ne-check:checked')].map(c => +c.value);
  if (!scelti.length) return;

  // Una copia per pezzo, senza chiedere: le quantità sono già state
  // dichiarate riga per riga nel form.
  const daStampare = [];
  scelti.forEach(i => {
    const c = _nuoviCreati[i];
    const n = parseInt(c['Quantità']) || 1;
    for (let k = 0; k < n; k++) daStampare.push(c);
  });

  chiudiNuoveEtichette();
  apriFinestraEtichette(daStampare);
}

// ============================================
// ETICHETTE
// ============================================
let etichetteCache = [];

// Di norma si stampano i capi appena caricati: aprire su 1383 card è
// inutile e lento. Default = capi dell'ultima data di carico presente nel
// foglio (non "oggi": se carichi lunedì e stampi martedì, li ritrovi).
let _soloUltimoLotto = true;
let _ultimaData      = '';

function dataCarico(p) {
  return String(p.Data || '').substring(0, 10);
}

function formattaData(iso) {
  if (!iso) return '';
  const [a, m, g] = iso.split('-');
  const mesi = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return `${parseInt(g)} ${mesi[parseInt(m) - 1] || ''} ${a}`;
}

// I dati arrivano dal server già ordinati dal più recente: non serve
// invertirli (getPagina legge il foglio dal fondo).
function preparaEtichette(raw) {
  etichetteCache = raw.slice();
  _ultimaData = etichetteCache
    .map(dataCarico).filter(Boolean)
    .sort().pop() || '';
}

async function caricaEtichette() {
  const el = document.getElementById('listaEtichette');

  // Quello che c'è già, subito: le etichette si stampano senza attendere.
  const subito = prodottiSubito();
  if (subito) {
    preparaEtichette(subito.prodotti);
    filtraEtichette();
  } else {
    el.innerHTML = '<div style="color:var(--c3); font-size:13px;">Caricamento...</div>';
  }

  try {
    const raw = await getProdottiCached(true);
    preparaEtichette(raw);
    filtraEtichette();
  } catch (e) {
    if (subito) return;   // si continua con i dati mostrati
    // Senza questo catch l'errore restava silenzioso: la pagina mostrava
    // "Caricamento..." per sempre e i filtri lavoravano su una lista vuota,
    // rispondendo "Nessun prodotto trovato".
    etichetteCache = [];
    el.innerHTML = `
      <div style="color:var(--c3); font-size:13px; line-height:1.6;">
        ⚠️ Caricamento non riuscito (connessione lenta o server occupato).
        <button onclick="caricaEtichette()" style="
          margin-top:10px; display:block; padding:8px 16px;
          border:1px solid rgba(91,135,160,0.3); background:white;
          color:#5b87a0; border-radius:10px; cursor:pointer; font-size:13px;
        ">Riprova</button>
      </div>`;
  }
}

function filtraEtichette() {
  const testo    = document.getElementById('filtroEtichetta').value.toLowerCase().trim();
  const stagione = document.getElementById('filtroStagioneEtichetta').value;

  // Cercare significa voler guardare in tutto il magazzino: il filtro del
  // lotto si sospende da sé, altrimenti la ricerca sembrerebbe rotta.
  const soloLotto = _soloUltimoLotto && !testo && _ultimaData;

  renderEtichette(etichetteCache.filter(p =>
    (!testo || str(p.Nome).includes(testo) || str(p.SKU).includes(testo) ||
               str(p.Brand).includes(testo) || str(p.Colore).includes(testo)) &&
    matchStagione(p, stagione) &&
    (!soloLotto || dataCarico(p) === _ultimaData)
  ));

  aggiornaIntestazioneEtichette(soloLotto, testo);
}

function aggiornaIntestazioneEtichette(soloLotto, testo) {
  const el = document.getElementById('etichetteInfo');
  if (!el) return;

  if (soloLotto) {
    const n = etichetteCache.filter(p => dataCarico(p) === _ultimaData).length;
    el.innerHTML = `Ultimo carico: <strong>${formattaData(_ultimaData)}</strong> · ${n} capi
      <button class="btn btn-ghost" style="margin-left:10px; padding:5px 14px; font-size:12px;"
              onclick="mostraTutteEtichette()">Mostra tutti (${etichetteCache.length})</button>`;
  } else if (testo) {
    el.innerHTML = `Ricerca su tutti i ${etichetteCache.length} capi`;
  } else {
    el.innerHTML = `Tutti i capi (${etichetteCache.length})
      ${_ultimaData ? `<button class="btn btn-ghost" style="margin-left:10px; padding:5px 14px; font-size:12px;"
              onclick="mostraSoloUltimoLotto()">Solo ultimo carico</button>` : ''}`;
  }
}

function mostraTutteEtichette() {
  _soloUltimoLotto = false;
  filtraEtichette();
}

function mostraSoloUltimoLotto() {
  _soloUltimoLotto = true;
  document.getElementById('filtroEtichetta').value = '';
  filtraEtichette();
}

// Rendering a blocchi: 1383 card sono ~24.000 nodi DOM su una pagina alta
// 180.000px, e il browser resta bloccato su layout e paint. Mostrando i primi
// BLOCCO_ETICHETTE e aggiungendo il resto quando serve, la pagina è utile
// subito e il thread non si inchioda.
const BLOCCO_ETICHETTE = 60;
let _etichetteVisibili = [];
let _etichetteMostrate = 0;

function renderEtichette(lista) {
  const el = document.getElementById('listaEtichette');
  if (!lista.length) { el.innerHTML = '<div style="color:var(--c3);">Nessun prodotto trovato.</div>'; return; }

  _etichetteVisibili = lista;
  _etichetteMostrate = 0;
  el.innerHTML = '';
  mostraAltreEtichette();
}

function mostraAltreEtichette() {
  const el = document.getElementById('listaEtichette');
  const blocco = _etichetteVisibili.slice(
    _etichetteMostrate, _etichetteMostrate + BLOCCO_ETICHETTE
  );
  if (!blocco.length) return;

  // Il bottone "mostra altri" va rimosso prima di accodare il blocco nuovo,
  // altrimenti resterebbe in mezzo alla lista.
  const vecchio = el.querySelector('#etichetteAltro');
  if (vecchio) vecchio.remove();

  el.insertAdjacentHTML('beforeend', cardEtichette(blocco));
  _etichetteMostrate += blocco.length;

  const restanti = _etichetteVisibili.length - _etichetteMostrate;
  if (restanti > 0) {
    el.insertAdjacentHTML('beforeend', `
      <div id="etichetteAltro" style="padding:16px 0; text-align:center;">
        <button onclick="mostraAltreEtichette()" style="
          padding:12px 24px; border:1px solid rgba(91,135,160,0.3);
          background:white; color:#5b87a0; border-radius:12px;
          cursor:pointer; font-size:14px;
        ">Mostra altri ${Math.min(restanti, BLOCCO_ETICHETTE)} (ne restano ${restanti})</button>
      </div>`);
  }
}

function cardEtichette(lista) {
  return lista.map(p => `
    <label class="et-card">
      <input type="checkbox" class="etichetta-check" value="${p.SKU}"
             ${_etichetteSelezionate.has(p.SKU) ? 'checked' : ''}
             onchange="toggleEtichetta(this.value, this.checked)">
      <div class="et-card-info">
        <div class="et-card-nome">${p.Nome}</div>
        <div class="et-card-taglia">${[p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ')}</div>
        <div class="et-card-bottom">
          <span class="et-card-prezzo">€ ${p.Prezzo}</span>
          ${p.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️</span>' : ''}
          ${parseInt(p.Quantità) > 1 ? `<span class="et-card-qty">${p.Quantità} pz</span>` : ''}
        </div>
      </div>
    </label>
  `).join('');
}

// La selezione vive in un Set, non nel DOM: con il rendering a blocchi i
// checkbox delle card non ancora mostrate non esistono, e "Seleziona tutte"
// avrebbe selezionato solo quelle a schermo senza dirlo.
let _etichetteSelezionate = new Set();

function selezionaTutte() {
  _etichetteSelezionate = new Set(_etichetteVisibili.map(p => p.SKU));
  document.querySelectorAll('.etichetta-check').forEach(c => c.checked = true);
  aggiornaContatoreSelezione();
}

function deselezionaTutte() {
  _etichetteSelezionate.clear();
  document.querySelectorAll('.etichetta-check').forEach(c => c.checked = false);
  aggiornaContatoreSelezione();
}

// Tiene il Set allineato quando si spunta una singola card.
function toggleEtichetta(sku, checked) {
  if (checked) _etichetteSelezionate.add(sku);
  else         _etichetteSelezionate.delete(sku);
  aggiornaContatoreSelezione();
}

function aggiornaContatoreSelezione() {
  const el = document.getElementById('contatoreSelezione');
  if (!el) return;
  const n = _etichetteSelezionate.size;
  el.textContent = n ? `${n} selezionat${n === 1 ? 'o' : 'i'}` : '';
}

// Modal quantità etichette — più elegante del prompt nativo
function chiediCopie(p) {
  return new Promise(resolve => {
    const qta = parseInt(p.Quantità) || 1;
    // Se quantità = 1, salta il modal
    if (qta <= 1) { resolve(1); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:9999;
      background:rgba(30,48,64,0.45); backdrop-filter:blur(8px);
      display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    overlay.innerHTML = `
      <div style="
        background:rgba(255,255,255,0.95); border-radius:24px;
        padding:28px 28px 22px; max-width:320px; width:100%;
        box-shadow:0 24px 64px rgba(30,48,64,0.2);
        animation: popIn 0.22s cubic-bezier(0.34,1.56,0.64,1);
      ">
        <div style="font-family:'Cormorant Garamond',serif; font-size:22px; font-weight:500; color:#1e3040; margin-bottom:4px;">
          Quante etichette?
        </div>
        <div style="font-size:12px; color:#8ab4c8; margin-bottom:20px;">
          ${p.Nome}${p.Taglia ? ' · ' + p.Taglia : ''} &nbsp;·&nbsp; ${qta} pz disponibili
        </div>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
          <button id="qMeno" style="
            width:40px; height:40px; border:1px solid rgba(91,135,160,0.25);
            background:white; color:#5b87a0; border-radius:12px;
            font-size:20px; cursor:pointer; flex-shrink:0;
          ">−</button>
          <input id="qInput" type="number" min="1" max="${qta}" value="${qta}" style="
            flex:1; text-align:center; font-family:'Cormorant Garamond',serif;
            font-size:32px; font-weight:600; color:#5b87a0;
            border:none; outline:none; background:transparent;
          ">
          <button id="qPiu" style="
            width:40px; height:40px; border:1px solid rgba(91,135,160,0.25);
            background:white; color:#5b87a0; border-radius:12px;
            font-size:20px; cursor:pointer; flex-shrink:0;
          ">+</button>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="qSkip" style="
            flex:1; padding:11px; border:1px solid rgba(91,135,160,0.2);
            background:rgba(91,135,160,0.06); color:#8ab4c8;
            border-radius:999px; font-size:13px; cursor:pointer;
          ">Salta</button>
          <button id="qOk" style="
            flex:2; padding:11px; border:none;
            background:#5b87a0; color:white;
            border-radius:999px; font-size:13px; cursor:pointer;
            box-shadow:0 3px 12px rgba(91,135,160,0.35);
          ">Conferma</button>
        </div>
      </div>
      <style>@keyframes popIn { from { transform:scale(0.88) translateY(16px); opacity:0; } to { transform:scale(1) translateY(0); opacity:1; } }</style>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#qInput');
    overlay.querySelector('#qMeno').onclick  = () => { input.value = Math.max(1, parseInt(input.value||1) - 1); };
    overlay.querySelector('#qPiu').onclick   = () => { input.value = Math.min(qta, parseInt(input.value||1) + 1); };
    overlay.querySelector('#qSkip').onclick  = () => { document.body.removeChild(overlay); resolve(0); };
    overlay.querySelector('#qOk').onclick    = () => {
      const v = Math.max(1, Math.min(qta, parseInt(input.value) || 1));
      document.body.removeChild(overlay);
      resolve(v);
    };
  });
}

async function stampaEtichette() {
  // Dal Set, non dal DOM: le card oltre il blocco visibile non hanno checkbox
  // e sarebbero state escluse dalla stampa senza alcun avviso.
  const skus = [..._etichetteSelezionate];
  if (!skus.length) { showToast('Seleziona almeno un prodotto', 'error'); return; }
  const selezionati = skus.map(sku => etichetteCache.find(p => p.SKU === sku)).filter(Boolean);

  // Chiedi copie per ogni prodotto con qtà > 1, in sequenza
  const prodotti = [];
  for (const p of selezionati) {
    const copie = await chiediCopie(p);
    for (let i = 0; i < copie; i++) prodotti.push(p);
  }
  if (!prodotti.length) return;

  apriFinestraEtichette(prodotti);
}

// Apre la finestra di stampa per una lista già espansa in copie.
// Condivisa tra la sezione Etichette e il modal dei capi appena creati,
// così il formato dell'etichetta è definito in un solo posto.
function apriFinestraEtichette(prodotti) {
  const win = window.open('', '_blank');
  if (!win) { showToast('Consenti i popup per stampare', 'error'); return; }
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Etichette</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:system-ui,sans-serif; background:#fff; }

    .controls {
      padding:12px 16px; background:#f5f5f5;
      display:flex; gap:10px; align-items:center;
    }
    .btn-print {
      padding:9px 20px; background:#5b87a0; color:white;
      border:none; border-radius:8px; font-size:14px; cursor:pointer;
    }
    .btn-print:disabled { opacity:0.5; cursor:default; }
    .info { font-size:13px; color:#666; }

    .grid { padding:10px; display:flex; flex-wrap:wrap; gap:3mm; }

    /* 50×30mm — 2 colonne 25/25 */
    .etichetta {
      width:50mm; height:30mm;
      display:flex; flex-direction:row;
      overflow:hidden;
      page-break-inside:avoid; break-inside:avoid;
    }

    .et-sx {
      width:25mm; flex-shrink:0;
      display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      gap:1.2mm; padding:1.5mm;
      border-right:0.2mm solid #ddd;
    }
    .et-logo { width:19mm; height:auto; max-height:8mm; object-fit:contain; }
    /* Prezzo su una riga da solo. */
    .et-prezzo { font-size:13pt; font-weight:900; line-height:1; }
    /* Taglia e colore insieme sulla riga sotto: devono starci entrambi,
       quindi il colore si accorcia con l'ellissi se serve. */
    .et-tc {
      display:flex; align-items:baseline; justify-content:center;
      gap:1mm; line-height:1; max-width:22mm;
    }
    .et-taglia { font-size:8.5pt; font-weight:700; color:#333; flex-shrink:0; }
    .et-sep    { font-size:6pt; color:#bbb; flex-shrink:0; }
    /* Corpo contenuto e nessuna spaziatura extra: un colore come
       "scacco beige" deve entrare per intero accanto alla taglia. */
    .et-colore {
      font-size:6pt; font-weight:700; color:#555;
      text-transform:uppercase; letter-spacing:0;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      min-width:0;
    }

    .et-dx {
      width:25mm; flex-shrink:0;
      display:flex; flex-direction:column;
      align-items:center; justify-content:center;
      gap:0.5mm; padding:1mm;
    }
    .et-qr-img { width:20mm; height:20mm; display:block; flex-shrink:0; }
    .et-nome {
      font-size:6pt; color:#222; text-align:center; font-weight:700;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:23mm;
    }
    .et-sku { font-size:3.5pt; color:#aaa; font-family:monospace; }

    @media print {
      @page {
        size: 50mm 30mm;
        margin: 0;
      }
      body { padding:0; margin:0; }
      .controls { display:none; }
      .grid { padding:0; gap:0; }
      .etichetta { width:50mm; height:30mm; }
    }
  </style>
</head>
<body>
  <div class="controls">
    <button class="btn-print" id="btnStampa" disabled>⏳ Generazione QR...</button>
    <span class="info" id="infoTxt">Attendere...</span>
  </div>
  <div class="grid" id="grid"></div>

  <script>
    const prodotti = ${JSON.stringify(prodotti)};
    const grid = document.getElementById('grid');

    function buildQR(text, size) {
      return new Promise(resolve => {
        const tmp = document.createElement('div');
        tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmp);
        new QRCode(tmp, {
          text, width: size, height: size,
          colorDark:'#000000', colorLight:'#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
        setTimeout(() => {
          const canvas = tmp.querySelector('canvas');
          const url = canvas ? canvas.toDataURL('image/png') : '';
          document.body.removeChild(tmp);
          resolve(url);
        }, 80);
      });
    }

    // Nome e colore arrivano dal foglio: se contengono < o & romperebbero
    // l'HTML dell'etichetta.
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function init() {
      for (const p of prodotti) {
        const qrUrl = await buildQR(p.SKU, 76);
        const div = document.createElement('div');
        div.className = 'etichetta';
        div.innerHTML =
          '<div class="et-sx">' +
            '<img class="et-logo" src="logo.png" alt="" onerror="this.hidden=true">' +
            '<div class="et-nome">' + esc(p.Nome) + '</div>' +
            '<div class="et-prezzo">€ ' + (p.Prezzo || '—') + '</div>' +
            // Taglia e colore sulla stessa riga: il colore va stampato,
            // altrimenti ogni scatola va aperta per sapere quale variante è.
            ((p.Taglia || p.Colore)
              ? '<div class="et-tc">' +
                  (p.Taglia ? '<span class="et-taglia">' + esc(p.Taglia) + '</span>' : '') +
                  (p.Taglia && p.Colore ? '<span class="et-sep">·</span>' : '') +
                  (p.Colore ? '<span class="et-colore">' + esc(p.Colore) + '</span>' : '') +
                '</div>'
              : '') +
          '</div>' +
          '<div class="et-dx">' +
            (qrUrl ? '<img class="et-qr-img" src="' + qrUrl + '" alt="QR">' : '') +
          '</div>';
        grid.appendChild(div);
      }

      const btn = document.getElementById('btnStampa');
      btn.textContent = '🖨️ Stampa';
      btn.disabled = false;
      btn.onclick = () => window.print();
      document.getElementById('infoTxt').textContent =
        prodotti.length + ' etichett' + (prodotti.length === 1 ? 'a' : 'e') + ' · 50×30mm · ORGBRO Z3';
    }

    init();
  <\/script>
</body>
</html>`);
  win.document.close();
}

// ============================================
// STORICO — con filtri periodo, speciali, margine
// ============================================
let _venditeCache   = [];
let _periodoCorrente = 'oggi';
let _soloSpeciali    = false;
let _prodottiMap     = {}; // SKU → PrezzoAcquisto

async function caricaStorico() {
  const [vendite, prodotti] = await Promise.all([
    api({ action: 'getVendite' }),
    getProdottiCached()
  ]);

  _venditeCache = vendite;
  // Mappa SKU → PrezzoAcquisto
  _prodottiMap = {};
  prodotti.forEach(p => { _prodottiMap[p.SKU] = parseFloat(p.PrezzoAcquisto || 0); });

  // Incasso totale sempre su tutto
  const incTot = vendite.reduce((s,v) => s + parseFloat(v.Prezzo||0), 0);
  document.getElementById('statIncassoTot').textContent = '€ ' + incTot.toFixed(2);

  setPeriodo(_periodoCorrente);
}

function setPeriodo(p) {
  _periodoCorrente = p;
  document.querySelectorAll('.periodo-tab').forEach(b => b.classList.toggle('active', b.dataset.periodo === p));

  const ora   = new Date();
  let da = null, a = null;

  if (p === 'oggi') {
    da = new Date(ora); da.setHours(0,0,0,0);
    a  = new Date(ora); a.setHours(23,59,59,999);
  } else if (p === 'mese') {
    da = new Date(ora.getFullYear(), ora.getMonth(), 1);
    a  = new Date(ora.getFullYear(), ora.getMonth()+1, 0, 23,59,59,999);
  } else if (p === 'anno') {
    da = new Date(ora.getFullYear(), 0, 1);
    a  = new Date(ora.getFullYear(), 11, 31, 23,59,59,999);
  } else if (p === 'custom') {
    const vda = document.getElementById('filtroDataDa').value;
    const va  = document.getElementById('filtroDataA').value;
    da = vda ? new Date(vda + 'T00:00:00') : null;
    a  = va  ? new Date(va  + 'T23:59:59') : null;
  }
  // tutto: nessun filtro data
  renderStorico(da, a);
}

function resetFiltriStorico() {
  _soloSpeciali = false;
  _periodoCorrente = 'oggi';
  document.getElementById('btnSoloSpeciali').classList.remove('attivo');
  document.getElementById('filtroDataDa').value = '';
  document.getElementById('filtroDataA').value  = '';
  setPeriodo('oggi');
}

function toggleSoloSpeciali() {
  _soloSpeciali = !_soloSpeciali;
  document.getElementById('btnSoloSpeciali').classList.toggle('attivo', _soloSpeciali);
  setPeriodo(_periodoCorrente);
}

function renderStorico(da, a) {
  let lista = [..._venditeCache].reverse();

  // Filtro data
  if (da) lista = lista.filter(v => new Date(v.Timestamp) >= da);
  if (a)  lista = lista.filter(v => new Date(v.Timestamp) <= a);

  // Filtro speciali — recupera dal prodotto
  if (_soloSpeciali) lista = lista.filter(v => {
    const p = Object.values(_prodottiMap); // cerca per nome/sku nella cache prodotti
    return v.Speciale === 'SI' || v.speciale === 'SI';
  });

  const tbody = document.getElementById('tabellaVendite');

  // Stats periodo
  const incasso = lista.reduce((s,v) => s + parseFloat(v.Prezzo||0), 0);
  const margine = lista.reduce((s,v) => {
    const costo = parseFloat(v.PrezzoAcquisto || _prodottiMap[v.SKU] || 0);
    return s + (parseFloat(v.Prezzo||0) - costo);
  }, 0);
  document.getElementById('statVenditePeriodo').textContent  = lista.length;
  document.getElementById('statIncassoPeriodo').textContent  = '€ ' + incasso.toFixed(2);
  document.getElementById('statMarginePeriodo').textContent  = (margine >= 0 ? '+' : '') + '€ ' + margine.toFixed(2);
  document.getElementById('statMarginePeriodo').style.color  = margine >= 0 ? 'var(--success)' : 'var(--warning)';

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--c3); text-align:center; padding:24px;">Nessuna vendita nel periodo</td></tr>';
    return;
  }

  tbody.innerHTML = lista.map(v => {
    const costo   = parseFloat(v.PrezzoAcquisto || _prodottiMap[v.SKU] || 0);
    const prezzo  = parseFloat(v.Prezzo || 0);
    const margine = prezzo - costo;
    const mClass  = margine >= 0 ? 'margine-pos' : 'margine-neg';
    const mText   = costo > 0 ? (margine >= 0 ? '+' : '') + '€ ' + margine.toFixed(2) : '—';
    return `<tr>
      <td style="font-size:12px; color:var(--c3);">${new Date(v.Timestamp).toLocaleString('it-IT', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</td>
      <td><strong>${v.Nome}</strong>${v.Speciale === 'SI' ? ' <span class="badge badge-speciale" style="font-size:9px;">✂️</span>' : ''}</td>
      <td>${v.Taglia||'—'}</td>
      <td>${v.Colore||'—'}</td>
      <td style="font-family:var(--serif); font-size:15px;">€ ${prezzo.toFixed(2)}</td>
      <td style="color:var(--c3); font-size:13px;">${costo > 0 ? '€ ' + costo.toFixed(2) : '—'}</td>
      <td class="${mClass}">${mText}</td>
    </tr>`;
  }).join('');
}

// ============================================
// TOAST
// ============================================
function showToast(msg, tipo = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + tipo;
  setTimeout(() => t.className = 'toast', 3000);
}