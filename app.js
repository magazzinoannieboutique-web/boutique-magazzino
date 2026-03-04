// ============================================
// STATO GLOBALE
// ============================================
let prodottiCache = [];
let scanCorrente  = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logoNome').textContent = CONFIG.NEGOZIO_NOME;

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
// API
// ============================================
async function api(params) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL + '?' + new URLSearchParams(params));
  return res.json();
}
async function apiPost(body) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

// ============================================
// POLLING
// ============================================
function avviaPolling() {
  setInterval(async () => {
    try {
      const data = await api({ action: 'pollScan' });
      if (data.scan && (!scanCorrente || scanCorrente.SKU !== data.scan.SKU)) {
        scanCorrente = data.scan;
        mostraScanBanner(data.scan);
      }
    } catch(e) {}
  }, CONFIG.POLLING_INTERVAL);
}

function mostraScanBanner(p) {
  document.getElementById('scanBanner').style.display  = 'block';
  document.getElementById('scanNome').textContent      = p.Nome;
  document.getElementById('scanDettagli').textContent  = `${p.Taglia} · ${p.Colore} · ${p.Brand || ''}`;
  document.getElementById('scanPrezzo').textContent    = CONFIG.VALUTA + ' ' + p.Prezzo;
  document.getElementById('scanStock').textContent     = `In magazzino: ${p.Quantità} pz`;
  document.getElementById('scanSpeciale').style.display = p.Speciale === 'SI' ? 'inline-block' : 'none';
  const fotoEl = document.getElementById('scanFoto');
  fotoEl.innerHTML = p.Foto_URL
    ? `<img src="${p.Foto_URL}" style="width:100%;height:100%;object-fit:cover;">`
    : 'No foto';
}

function chiudiScan() {
  scanCorrente = null;
  document.getElementById('scanBanner').style.display = 'none';
}

async function vendiDaPortale() {
  if (!scanCorrente) return;
  const res = await apiPost({ action: 'vendiProdotto', sku: scanCorrente.SKU });
  if (res.success) {
    showToast('✅ Vendita registrata!', 'success');
    chiudiScan();
    caricaDashboard();
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

// ============================================
// DASHBOARD
// ============================================
async function caricaDashboard() {
  const d = await api({ action: 'getDashboard' });
  document.getElementById('statVenditeOggi').textContent = d.venditeOggi;
  document.getElementById('statIncassoOggi').textContent = CONFIG.VALUTA + ' ' + d.incassoOggi;
  document.getElementById('statVenditeTot').textContent  = d.venditeTotali;
  document.getElementById('statIncassoTot').textContent  = CONFIG.VALUTA + ' ' + d.incassoTotale;
  const uv = document.getElementById('ultimaVendita');
  if (d.ultimaVendita) {
    const v = d.ultimaVendita;
    uv.innerHTML = `<strong>${v.Nome}</strong> — ${v.Taglia} ${v.Colore} — ${CONFIG.VALUTA} ${v.Prezzo}
      <span style="color:#bbb; margin-left:8px;">${new Date(v.Timestamp).toLocaleString('it-IT')}</span>`;
  } else {
    uv.textContent = 'Nessuna vendita ancora';
  }
}

// ============================================
// INVENTARIO
// ============================================
async function caricaInventario() {
  prodottiCache = await api({ action: 'getProdotti' });
  const categorie = [...new Set(prodottiCache.map(p => p.Categoria).filter(Boolean))];
  const sel = document.getElementById('filtroCategoria');
  sel.innerHTML = '<option value="">Tutte le categorie</option>';
  categorie.forEach(c => sel.innerHTML += `<option value="${c}">${c}</option>`);
  renderProdotti(prodottiCache);
}

function filtraInventario() {
  const testo = document.getElementById('filtroTesto').value.toLowerCase();
  const cat   = document.getElementById('filtroCategoria').value;
  const spec  = document.getElementById('filtroSpeciale').value;
  renderProdotti(prodottiCache.filter(p =>
    (!testo || p.Nome?.toLowerCase().includes(testo) || p.SKU?.toLowerCase().includes(testo)) &&
    (!cat   || p.Categoria === cat) &&
    (!spec  || p.Speciale === spec)
  ));
}

function renderProdotti(lista) {
  const grid = document.getElementById('gridProdotti');
  if (!lista.length) { grid.innerHTML = '<div style="color:#888;">Nessun prodotto trovato.</div>'; return; }
  grid.innerHTML = lista.map(p => `
    <div class="articolo-card">
      <div class="articolo-foto">
        ${p.Foto_URL ? `<img src="${p.Foto_URL}" alt="${p.Nome}">` : '<span>📷 No foto</span>'}
      </div>
      <div class="articolo-info">
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
          ${p.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️ Speciale</span>' : ''}
          ${p.Categoria ? `<span class="badge">${p.Categoria}</span>` : ''}
        </div>
        <div class="articolo-nome">${p.Nome}</div>
        <div class="articolo-brand">${p.Taglia} · ${p.Colore} · <span style="color:#bbb;">${p.SKU}</span></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
          <div class="articolo-prezzo">${CONFIG.VALUTA} ${p.Prezzo}</div>
          <div style="font-size:12px; color:${parseInt(p.Quantità) > 0 ? '#888' : '#c0392b'};">
            ${parseInt(p.Quantità) > 0 ? p.Quantità + ' pz' : '<span class="badge badge-esaurito">Esaurito</span>'}
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

// ============================================
// CARICA PRODOTTO
// ============================================
async function salvaProdotto() {
  const dati = {
    action:    'addProdotto',
    Nome:      document.getElementById('pNome').value.trim(),
    Categoria: document.getElementById('pCategoria').value.trim(),
    Brand:     document.getElementById('pBrand').value.trim(),
    Taglia:    document.getElementById('pTaglia').value.trim(),
    Colore:    document.getElementById('pColore').value.trim(),
    Prezzo:    document.getElementById('pPrezzo').value,
    Quantita:  document.getElementById('pQuantita').value,
    Speciale:  document.getElementById('pSpeciale').value,
    Note:      document.getElementById('pNote').value.trim(),
    Foto_URL:  document.getElementById('pFoto').value,
  };
  if (!dati.Nome) { showToast('Il nome è obbligatorio', 'error'); return; }
  const res = await apiPost(dati);
  if (res.success) {
    showToast(`✅ Prodotto salvato!`, 'success');
    const box = document.getElementById('skuGenerato');
    box.textContent = `✅ SKU generato: ${res.sku}`;
    box.style.display = 'block';
    // Reset form
    ['pNome','pCategoria','pBrand','pTaglia','pColore','pPrezzo','pNote','pFoto'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('pQuantita').value = '1';
    document.getElementById('fotoPreview').style.display = 'none';
    document.getElementById('fotoStatus').textContent = 'Nessuna foto';
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

// ============================================
// ETICHETTE
// ============================================
let etichetteCache = [];

async function caricaEtichette() {
  etichetteCache = await api({ action: 'getProdotti' });
  renderEtichette(etichetteCache);
}

function filtraEtichette() {
  const testo = document.getElementById('filtroEtichetta').value.toLowerCase();
  renderEtichette(etichetteCache.filter(p =>
    !testo || p.Nome?.toLowerCase().includes(testo) || p.SKU?.toLowerCase().includes(testo)
  ));
}

function renderEtichette(lista) {
  const el = document.getElementById('listaEtichette');
  if (!lista.length) { el.innerHTML = '<div style="color:#888;">Nessun prodotto trovato.</div>'; return; }
  el.innerHTML = lista.map(p => `
    <label style="display:flex; align-items:center; gap:12px; background:white; border:1px solid var(--border);
      border-radius:10px; padding:14px; cursor:pointer; transition:border-color 0.15s;"
      onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <input type="checkbox" class="etichetta-check" value="${p.SKU}"
        style="width:16px; height:16px; accent-color:var(--accent); flex-shrink:0;">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.Nome}</div>
        <div style="font-size:12px; color:#888; margin-top:2px;">${p.Taglia} · ${p.Colore}</div>
        <div style="font-size:13px; color:var(--accent); margin-top:2px; font-weight:600;">€ ${p.Prezzo}</div>
      </div>
      <div style="font-size:11px; color:#bbb; font-family:monospace; flex-shrink:0;">${p.SKU}</div>
    </label>
  `).join('');
}

function selezionaTutte()   { document.querySelectorAll('.etichetta-check').forEach(c => c.checked = true); }
function deselezionaTutte() { document.querySelectorAll('.etichetta-check').forEach(c => c.checked = false); }

function stampaEtichette() {
  const skus = [...document.querySelectorAll('.etichetta-check:checked')].map(c => c.value);
  if (!skus.length) { showToast('Seleziona almeno un prodotto', 'error'); return; }
  const prodotti = skus.map(sku => etichetteCache.find(p => p.SKU === sku)).filter(Boolean);

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Etichette — ${CONFIG.NEGOZIO_NOME}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: system-ui, sans-serif; background:#fff; padding:12px; }
    .controls { margin-bottom:16px; display:flex; gap:10px; align-items:center; }
    .btn-print { padding:10px 22px; background:#5b87a0; color:white; border:none; border-radius:8px; font-size:14px; cursor:pointer; font-family:system-ui; }
    .grid { display:flex; flex-wrap:wrap; gap:8px; }
    .etichetta {
      width: 62mm;
      padding: 6px 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      page-break-inside: avoid;
      text-align: center;
      gap: 4px;
    }
    .shop-name { font-size:9px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#333; }
    .shop-dot  { width:6px; height:6px; background:#5b87a0; border-radius:50%; display:inline-block; margin-right:4px; vertical-align:middle; }
    .qr-wrap   { margin: 2px 0; }
    .prod-nome { font-size:10px; font-weight:700; line-height:1.2; }
    .prod-det  { font-size:9px; color:#555; }
    .prod-price{ font-size:13px; font-weight:800; }
    .prod-sku  { font-size:7px; color:#aaa; font-family:monospace; }
    .divider   { width:100%; height:1px; background:#eee; margin:2px 0; }
    @media print {
      body { padding:4px; }
      .controls { display:none; }
      .etichetta { border-color:#999; }
    }
  </style>
</head>
<body>
  <div class="controls">
    <button class="btn-print" onclick="window.print()">🖨️ Stampa</button>
    <span style="font-size:13px; color:#888;">${prodotti.length} etichett${prodotti.length === 1 ? 'a' : 'e'} pronte</span>
  </div>
  <div class="grid" id="grid"></div>
  <script>
    const prodotti = ${JSON.stringify(prodotti)};
    const negozio  = '${CONFIG.NEGOZIO_NOME}';
    const grid = document.getElementById('grid');
    prodotti.forEach(p => {
      const div = document.createElement('div');
      div.className = 'etichetta';
      div.innerHTML = \`
        <div class="shop-name"><span class="shop-dot"></span>\${negozio}</div>
        <div class="divider"></div>
        <div class="qr-wrap" id="qr-\${p.SKU}"></div>
        <div class="prod-nome">\${p.Nome}</div>
        <div class="prod-det">\${p.Taglia} · \${p.Colore}</div>
        <div class="prod-price">€ \${p.Prezzo}</div>
        <div class="prod-sku">\${p.SKU}</div>
      \`;
      grid.appendChild(div);
      new QRCode(document.getElementById('qr-' + p.SKU), {
        text: p.SKU, width: 80, height: 80,
        colorDark: '#1a1a1a', colorLight: '#ffffff',
      });
    });
  <\/script>
</body>
</html>`);
  win.document.close();
}

// ============================================
// STORICO
// ============================================
async function caricaStorico() {
  const data  = await api({ action: 'getVendite' });
  const tbody = document.getElementById('tabellaVendite');
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="6" style="color:#888;">Nessuna vendita ancora</td></tr>'; return; }
  tbody.innerHTML = [...data].reverse().map(v => `<tr>
    <td>${new Date(v.Timestamp).toLocaleString('it-IT')}</td>
    <td><strong>${v.Nome}</strong></td>
    <td>${v.Taglia}</td><td>${v.Colore}</td>
    <td>${CONFIG.VALUTA} ${v.Prezzo}</td>
    <td style="color:#bbb; font-size:12px;">${v.ID_Vendita}</td>
  </tr>`).join('');
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