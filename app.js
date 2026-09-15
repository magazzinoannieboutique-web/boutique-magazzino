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
async function chiamaApi(params) {
  const url = CONFIG.APPS_SCRIPT_URL + '?' + new URLSearchParams(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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

async function getProdottiCached(forza = false) {
  const fresca = _cacheProdotti && (Date.now() - _cacheTs) < CACHE_TTL_MS;
  if (!forza && fresca) return _cacheProdotti;

  // Se un download è già in volo, ci si aggancia invece di farne un altro.
  if (_cacheInCorso) return _cacheInCorso;

  _cacheInCorso = (async () => {
    try {
      const dati = await api({ action: 'getProdotti' });
      if (!Array.isArray(dati)) throw new Error(dati && dati.error || 'Risposta non valida');
      _cacheProdotti = dati;
      _cacheTs = Date.now();
      return dati;
    } finally {
      _cacheInCorso = null;
    }
  })();

  return _cacheInCorso;
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
function avviaPolling() {
  async function tick() {
    // Tab in secondo piano: niente polling. Una tab dimenticata aperta in
    // negozio occupava la coda tutto il giorno per nulla.
    if (!pollingAttivo || document.hidden) {
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
  prodottiCache = await getProdottiCached();

  // Popola categorie
  const categorie = [...new Set(prodottiCache.map(p => p.Categoria).filter(Boolean))];
  const selCat = document.getElementById('filtroCategoria');
  selCat.innerHTML = '<option value="">Tutte le categorie</option>';
  categorie.forEach(c => selCat.innerHTML += `<option value="${c}">${c}</option>`);

  // Popola brand
  const brand = [...new Set(prodottiCache.map(p => p.Brand).filter(Boolean))].sort();
  const selBrand = document.getElementById('filtroBrand');
  selBrand.innerHTML = '<option value="">Tutti i brand</option>';
  brand.forEach(b => selBrand.innerHTML += `<option value="${b}">${b}</option>`);

  renderProdotti(prodottiCache);
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
  const riga   = btn.closest('.var-row');
  const colore = riga.querySelector('.var-colore').value;
  riga.insertAdjacentHTML('afterend', rigaVariante('', colore, 1));
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

  const creati = [];   // { SKU, Nome, Taglia, Colore, Prezzo, Quantità }
  let interrotto = false;
  try {
    for (let i = 0; i < tasks.length; i++) {
      if (tasks.length > 1) btn.textContent = `⏳ Salvataggio ${i+1}/${tasks.length}...`;
      const res = await apiPost(tasks[i]);
      if (res.success) {
        creati.push({
          SKU:        res.sku,
          Nome:       nome,
          Taglia:     tasks[i].Taglia,
          Colore:     tasks[i].Colore,
          Brand:      datiBase.Brand,
          Prezzo:     parseFloat(prezzoStr) || 0,
          'Quantità': tasks[i].Quantita,
        });
      } else { showToast('❌ ' + (res.error || 'Errore'), 'error'); interrotto = true; break; }
    }
  } catch (e) {
    // Timeout o rete: la scrittura può essere andata a buon fine comunque.
    // I task hanno un token, quindi ripremere Salva non crea doppioni.
    interrotto = true;
    showToast('⚠️ Connessione lenta: premi di nuovo Salva per verificare (non creerà doppioni)', 'error');
  } finally {
    btn.textContent = 'Salva prodotto';
    btn.disabled = false;
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

async function caricaEtichette() {
  const el = document.getElementById('listaEtichette');
  el.innerHTML = '<div style="color:var(--c3); font-size:13px;">Caricamento...</div>';
  try {
    const raw = await getProdottiCached();
    etichetteCache = [...raw].reverse(); // ultimo inserito prima

    // Data di carico più recente presente nei dati.
    _ultimaData = etichetteCache
      .map(dataCarico).filter(Boolean)
      .sort().pop() || '';

    filtraEtichette();
  } catch (e) {
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
      gap:2mm; padding:1.5mm;
      border-right:0.2mm solid #ddd;
    }
    .et-logo { width:20mm; height:auto; max-height:10mm; object-fit:contain; }
    .et-main { display:flex; align-items:baseline; gap:1mm; line-height:1; }
    .et-prezzo { font-size:12pt; font-weight:900; }
    .et-sep    { font-size:7pt; color:#bbb; }
    .et-taglia { font-size:9pt; font-weight:700; color:#444; }
    /* Colore su riga propria: sui 25mm di sinistra non sta in linea con
       prezzo e taglia senza rischiare il troncamento. */
    .et-colore {
      font-size:6pt; font-weight:700; color:#555;
      text-transform:uppercase; letter-spacing:0.2pt;
      max-width:22mm; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis;
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
            '<div class="et-main">' +
              '<span class="et-prezzo">€ ' + (p.Prezzo || '—') + '</span>' +
              (p.Taglia ? '<span class="et-sep">·</span><span class="et-taglia">' + esc(p.Taglia) + '</span>' : '') +
            '</div>' +
            // Il colore va stampato: senza, ogni scatola va aperta per sapere
            // a quale variante appartiene l'etichetta.
            (p.Colore ? '<div class="et-colore">' + esc(p.Colore) + '</div>' : '') +
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