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
  avviaPolling();
});

// ============================================
// API — tutto via JSONP (risolve CORS con Apps Script)
// ============================================
function jsonp(params) {
  return new Promise((resolve, reject) => {
    const cbName = 'cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      delete window[cbName];
      if (script.parentNode) document.body.removeChild(script);
      reject(new Error('JSONP timeout'));
    }, 10000);
    window[cbName] = (data) => {
      clearTimeout(timeout);
      delete window[cbName];
      if (script.parentNode) document.body.removeChild(script);
      resolve(data);
    };
    script.src = CONFIG.APPS_SCRIPT_URL + '?' + new URLSearchParams({ ...params, callback: cbName });
    script.onerror = () => {
      clearTimeout(timeout);
      delete window[cbName];
      if (script.parentNode) document.body.removeChild(script);
      reject(new Error('JSONP error'));
    };
    document.body.appendChild(script);
  });
}

function api(params)   { return jsonp(params); }
function apiPost(body) { return jsonp(body); }

// ============================================
// POLLING — silenzioso, non blocca il tab
// ============================================
let pollingAttivo = true;

function avviaPolling() {
  async function tick() {
    if (!pollingAttivo) { setTimeout(tick, CONFIG.POLLING_INTERVAL); return; }
    try {
      const data = await api({ action: 'pollScan' });
      if (data.scan && (!scanCorrente || scanCorrente.SKU !== data.scan.SKU)) {
        scanCorrente = data.scan;
        mostraModalScan(data.scan);
      }
    } catch(e) {}

    // Controlla anche riepilogo vendita multipla
    try {
      const r = await api({ action: 'getRiepilogo' });
      if (r && r.riepilogo && r.riepilogo.length) {
        mostraRiepilogo(r.riepilogo);
      }
    } catch(e) { /* route non ancora deployata, ignora */ }

    setTimeout(tick, CONFIG.POLLING_INTERVAL);
  }
  setTimeout(tick, CONFIG.POLLING_INTERVAL);
}

// ============================================
// MODAL SCANSIONE — solo visualizzazione, vende solo il telefono
// ============================================
function mostraModalScan(p) {
  const foto = document.getElementById('smFoto');
  const placeholder = document.getElementById('smFotoPlaceholder');
  if (p.Foto_URL) { foto.src = p.Foto_URL; foto.style.display = 'block'; placeholder.style.display = 'none'; }
  else            { foto.style.display = 'none'; placeholder.style.display = 'block'; }
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
  prodottiCache = await api({ action: 'getProdotti' });

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

let _mostraEsauriti = false;

function toggleEsauriti() {
  _mostraEsauriti = !_mostraEsauriti;
  document.getElementById('btnMostraEsauriti').classList.toggle('attivo', _mostraEsauriti);
  filtraInventario();
}

function filtraInventario() {
  const testo = document.getElementById('filtroTesto').value.toLowerCase().trim();
  const cat   = document.getElementById('filtroCategoria').value;
  const brand = document.getElementById('filtroBrand').value;
  const spec  = document.getElementById('filtroSpeciale').value;
  renderProdotti(prodottiCache.filter(p =>
    (!testo || str(p.Nome).includes(testo) || str(p.SKU).includes(testo) || str(p.Brand).includes(testo)) &&
    (!cat   || p.Categoria === cat) &&
    (!brand || p.Brand === brand) &&
    (!spec  || p.Speciale === spec) &&
    (_mostraEsauriti || parseInt(p.Quantità) > 0)
  ));
}

function renderProdotti(lista) {
  const grid = document.getElementById('gridProdotti');
  if (!lista.length) { grid.innerHTML = '<div style="color:var(--c3);">Nessun prodotto trovato.</div>'; return; }
  grid.innerHTML = lista.map(p => `
    <div class="inv-card">
      <div class="inv-card-info">
        <div class="inv-card-badges">
          ${p.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️</span>' : ''}
          ${p.Categoria ? `<span class="badge">${p.Categoria}</span>` : ''}
        </div>
        <div class="inv-card-nome">${p.Nome}</div>
        <div class="inv-card-sub">${[p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ')}</div>
        <div class="inv-card-bottom">
          <div class="inv-card-prezzo">€ ${p.Prezzo}</div>
          <div class="inv-card-qty ${parseInt(p.Quantità) <= 0 ? 'esaurito' : ''}">
            ${parseInt(p.Quantità) > 0 ? p.Quantità + ' pz' : 'Esaurito'}
          </div>
        </div>
      </div>
      <div class="inv-card-foto" style="position:relative;">
        ${p.Foto_URL ? `<img src="${p.Foto_URL}" alt="${p.Nome}" loading="lazy">` : `<span class="inv-nofoto">📷</span>`}
        <button onclick="apriModifica('${p.SKU}')" style="
          position:absolute; bottom:6px; right:6px;
          width:28px; height:28px; border-radius:50%;
          background:rgba(255,255,255,0.92); border:none;
          box-shadow:0 2px 8px rgba(30,48,64,0.18);
          cursor:pointer; font-size:13px; display:flex;
          align-items:center; justify-content:center;
          transition:transform 0.15s;
        " onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'">✏️</button>
      </div>
    </div>
  `).join('');
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
    Note:           document.getElementById('mNote').value.trim(),
  });

  btn.textContent = '💾 Salva modifiche'; btn.disabled = false;

  if (res.success) {
    chiudiModifica();
    showToast('✅ Prodotto aggiornato', 'success');
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
    await caricaInventario();
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}
async function salvaProdotto() {
  const nome    = document.getElementById('pNome').value.trim();
  const tagliaRaw = document.getElementById('pTaglia').value.trim();
  const qtaRaw  = document.getElementById('pQuantita').value.trim();

  if (!nome) { showToast('Il nome è obbligatorio', 'error'); return; }

  // Fix virgola→punto sui prezzi
  const prezzoStr         = document.getElementById('pPrezzo').value.replace(',', '.');
  const prezzoAcquistoStr = document.getElementById('pPrezzoAcquisto').value.replace(',', '.');

  const datiBase = {
    action:         'addProdotto',
    Nome:           nome,
    Categoria:      document.getElementById('pCategoria').value.trim(),
    Brand:          document.getElementById('pBrand').value.trim(),
    Colore:         document.getElementById('pColore').value.trim(),
    Prezzo:         prezzoStr,
    PrezzoAcquisto: prezzoAcquistoStr,
    Speciale:       document.getElementById('pSpeciale').value,
    Note:           document.getElementById('pNote').value.trim(),
    Foto_URL:       document.getElementById('pFoto').value,
  };

  // Parsing multi-taglia: "S, M, 2L" → ['S','M','2L']
  // Ogni voce può avere una quantità propria: "S:2, M:3, L:1"
  // oppure tutte usano la quantità nel campo Quantità
  const tagliaVoci = tagliaRaw
    ? tagliaRaw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    : [''];

  // Parsing quantità per taglia: "2,3,1" oppure singolo "1"
  const qtaVoci = qtaRaw.split(',').map(q => parseInt(q.trim()) || 1);

  const tasks = tagliaVoci.map((taglia, i) => ({
    ...datiBase,
    Taglia:   taglia,
    Quantita: qtaVoci[i] !== undefined ? qtaVoci[i] : qtaVoci[0],
  }));

  const btn = document.querySelector('#sec-carica .btn-primary');
  btn.textContent = tasks.length > 1 ? `⏳ Salvataggio 0/${tasks.length}...` : '⏳ Salvataggio...';
  btn.disabled = true;

  const skuGenerati = [];
  for (let i = 0; i < tasks.length; i++) {
    if (tasks.length > 1) btn.textContent = `⏳ Salvataggio ${i+1}/${tasks.length}...`;
    const res = await apiPost(tasks[i]);
    if (res.success) skuGenerati.push(res.sku);
    else { showToast('❌ ' + (res.error || 'Errore'), 'error'); break; }
  }

  btn.textContent = 'Salva prodotto';
  btn.disabled = false;

  if (skuGenerati.length) {
    const box = document.getElementById('skuGenerato');
    box.innerHTML = `✅ ${skuGenerati.length > 1 ? skuGenerati.length + ' prodotti salvati' : 'Prodotto salvato'}: <strong>${skuGenerati.join(', ')}</strong>`;
    box.style.display = 'block';
    showToast(`✅ ${skuGenerati.length} prodotto/i salvato/i!`, 'success');

    // Reset campi (mantieni nome, cat, brand, colore, prezzi per inserimento rapido taglie successive)
    document.getElementById('pTaglia').value  = '';
    document.getElementById('pQuantita').value = '1';
    // Reset completo solo se taglia singola
    if (tasks.length === 1) {
      ['pNome','pCategoria','pBrand','pColore','pPrezzo','pPrezzoAcquisto','pNote','pFoto'].forEach(id => {
        document.getElementById(id).value = '';
      });
      document.getElementById('fotoPreview').style.display = 'none';
      document.getElementById('fotoStatus').textContent = 'Nessuna foto';
    }

    // Scroll in cima alla sezione
    document.getElementById('sec-carica').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ============================================
// ETICHETTE
// ============================================
let etichetteCache = [];

async function caricaEtichette() {
  const raw = await api({ action: 'getProdotti' });
  etichetteCache = [...raw].reverse(); // ultimo inserito prima
  renderEtichette(etichetteCache);
}

function filtraEtichette() {
  const testo = document.getElementById('filtroEtichetta').value.toLowerCase();
  renderEtichette(etichetteCache.filter(p =>
    !testo || str(p.Nome).includes(testo) || str(p.SKU).includes(testo) || str(p.Brand).includes(testo)
  ));
}

function renderEtichette(lista) {
  const el = document.getElementById('listaEtichette');
  if (!lista.length) { el.innerHTML = '<div style="color:var(--c3);">Nessun prodotto trovato.</div>'; return; }
  el.innerHTML = lista.map(p => `
    <label class="et-card" onclick="">
      <input type="checkbox" class="etichetta-check" value="${p.SKU}">
      <div class="et-card-foto">
        ${p.Foto_URL
          ? `<img src="${p.Foto_URL}" alt="${p.Nome}" loading="lazy">`
          : `<span class="et-card-nofoto">📷</span>`}
      </div>
      <div class="et-card-info">
        <div class="et-card-nome">${p.Nome}</div>
        <div class="et-card-taglia">${[p.Taglia, p.Colore, p.Brand].filter(Boolean).join(' · ')}</div>
        <div class="et-card-bottom">
          <div class="et-card-prezzo">€ ${p.Prezzo}</div>
          ${p.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️</span>' : ''}
          ${parseInt(p.Quantità) > 1 ? `<span class="badge" style="color:var(--c3);">${p.Quantità} pz</span>` : ''}
        </div>
      </div>
    </label>
  `).join('');
}

function selezionaTutte()   { document.querySelectorAll('.etichetta-check').forEach(c => c.checked = true); }
function deselezionaTutte() { document.querySelectorAll('.etichetta-check').forEach(c => c.checked = false); }

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
  const skus = [...document.querySelectorAll('.etichetta-check:checked')].map(c => c.value);
  if (!skus.length) { showToast('Seleziona almeno un prodotto', 'error'); return; }
  const selezionati = skus.map(sku => etichetteCache.find(p => p.SKU === sku)).filter(Boolean);

  // Chiedi copie per ogni prodotto con qtà > 1, in sequenza
  const prodotti = [];
  for (const p of selezionati) {
    const copie = await chiediCopie(p);
    for (let i = 0; i < copie; i++) prodotti.push(p);
  }
  if (!prodotti.length) return;

  const win = window.open('', '_blank');
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

    async function init() {
      for (const p of prodotti) {
        const qrUrl = await buildQR(p.SKU, 76);
        const div = document.createElement('div');
        div.className = 'etichetta';
        div.innerHTML =
          '<div class="et-sx">' +
            '<img class="et-logo" src="logo.png" alt="" onerror="this.hidden=true">' +
            '<div class="et-nome">' + p.Nome + '</div>' +
            '<div class="et-main">' +
              '<span class="et-prezzo">€ ' + (p.Prezzo || '—') + '</span>' +
              (p.Taglia ? '<span class="et-sep">·</span><span class="et-taglia">' + p.Taglia + '</span>' : '') +
            '</div>' +
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
    api({ action: 'getProdotti' })
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
// MODAL RIEPILOGO VENDITA MULTIPLA
// ============================================
function mostraRiepilogo(capi) {
  const totale = capi.reduce((s,c) => s + parseFloat(c.Prezzo||0), 0);
  document.getElementById('riepilogoSub').textContent = capi.length + ' capo' + (capi.length !== 1 ? 'i' : '') + ' venduto' + (capi.length !== 1 ? 'i' : '');
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
  document.getElementById('riepilogoModal').style.display = 'flex';
}

function chiudiRiepilogo() {
  document.getElementById('riepilogoModal').style.display = 'none';
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