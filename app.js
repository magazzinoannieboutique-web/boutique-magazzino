// ============================================
// STATO GLOBALE
// ============================================
let articoliCache = [];
let variantiCache = [];
let scanCorrente = null;
let pollingTimer = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('logoNome').textContent = CONFIG.NEGOZIO_NOME;

  // Navigazione
  document.querySelectorAll('nav a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const sec = a.dataset.section;
      document.querySelectorAll('nav a').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.section').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
      document.getElementById('sec-' + sec).classList.add('active');
      if (sec === 'storico')    caricaStorico();
      if (sec === 'inventario') caricaInventario();
      if (sec === 'dashboard')  caricaDashboard();
      if (sec === 'etichette')  caricaEtichette();
    });
  });

  caricaDashboard();
  avviaPolling();
});

// ============================================
// API
// ============================================
async function api(params) {
  const url = CONFIG.APPS_SCRIPT_URL + '?' + new URLSearchParams(params);
  const res = await fetch(url);
  return res.json();
}

async function apiPost(body) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return res.json();
}

// ============================================
// POLLING SCAN
// ============================================
function avviaPolling() {
  pollingTimer = setInterval(async () => {
    try {
      const data = await api({ action: 'pollScan' });
      if (data.scan && (!scanCorrente || scanCorrente.ID_Variante !== data.scan.ID_Variante)) {
        scanCorrente = data.scan;
        mostraScanBanner(data.scan);
      }
    } catch (e) {
      // Silenzioso
    }
  }, CONFIG.POLLING_INTERVAL);
}

function mostraScanBanner(v) {
  document.getElementById('scanBanner').style.display = 'block';
  document.getElementById('scanNome').textContent     = v.Nome || v.SKU;
  document.getElementById('scanDettagli').textContent = `${v.Taglia} · ${v.Colore} · ${v.Brand || ''}`;
  document.getElementById('scanPrezzo').textContent   = CONFIG.VALUTA + ' ' + (v.Prezzo || '—');
  document.getElementById('scanStock').textContent    = `In magazzino: ${v.Quantità} pz`;

  const speciale = v.Speciale === 'SI' || v.Speciale_Articolo === 'SI';
  document.getElementById('scanSpeciale').style.display = speciale ? 'inline-block' : 'none';

  const fotoEl = document.getElementById('scanFoto');
  if (v.Foto_URL) {
    fotoEl.innerHTML = `<img src="${v.Foto_URL}" alt="${v.Nome}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    fotoEl.textContent = 'No foto';
  }
}

function chiudiScan() {
  scanCorrente = null;
  document.getElementById('scanBanner').style.display = 'none';
}

async function vendiDaPortale() {
  if (!scanCorrente) return;
  const res = await apiPost({ action: 'vendiVariante', id_variante: scanCorrente.ID_Variante });
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
  const data = await api({ action: 'getDashboard' });
  document.getElementById('statVenditeOggi').textContent = data.venditeOggi;
  document.getElementById('statIncassoOggi').textContent = CONFIG.VALUTA + ' ' + data.incassoOggi;
  document.getElementById('statVenditeTot').textContent  = data.venditeTotali;
  document.getElementById('statIncassoTot').textContent  = CONFIG.VALUTA + ' ' + data.incassoTotale;

  const uv = document.getElementById('ultimaVendita');
  if (data.ultimaVendita) {
    const v = data.ultimaVendita;
    const d = new Date(v.Timestamp).toLocaleString('it-IT');
    uv.innerHTML = `<strong>${v.Nome}</strong> — ${v.Taglia} ${v.Colore} — ${CONFIG.VALUTA} ${v.Prezzo} <span style="color:#bbb; margin-left:8px;">${d}</span>`;
  } else {
    uv.textContent = 'Nessuna vendita ancora';
  }
}

// ============================================
// INVENTARIO
// ============================================
async function caricaInventario() {
  const data = await api({ action: 'getArticoli' });
  articoliCache = data;

  const categorie = [...new Set(data.map(a => a.Categoria).filter(Boolean))];
  const sel = document.getElementById('filtroCategoria');
  sel.innerHTML = '<option value="">Tutte le categorie</option>';
  categorie.forEach(c => sel.innerHTML += `<option value="${c}">${c}</option>`);

  renderArticoli(data);
}

function filtraArticoli() {
  const testo = document.getElementById('filtroTesto').value.toLowerCase();
  const cat   = document.getElementById('filtroCategoria').value;
  const spec  = document.getElementById('filtroSpeciale').value;

  const filtrati = articoliCache.filter(a => {
    const matchTesto = !testo || a.Nome?.toLowerCase().includes(testo) || a.SKU?.toLowerCase().includes(testo);
    const matchCat   = !cat   || a.Categoria === cat;
    const matchSpec  = !spec  || a.Speciale === spec;
    return matchTesto && matchCat && matchSpec;
  });

  renderArticoli(filtrati);
}

function renderArticoli(lista) {
  const grid = document.getElementById('gridArticoli');
  if (!lista.length) {
    grid.innerHTML = '<div style="color:#888; font-size:14px;">Nessun articolo trovato.</div>';
    return;
  }
  grid.innerHTML = lista.map(a => `
    <div class="articolo-card">
      <div class="articolo-foto">
        ${a.Foto_URL
          ? `<img src="${a.Foto_URL}" alt="${a.Nome}">`
          : '<span>📷 No foto</span>'}
      </div>
      <div class="articolo-info">
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
          ${a.Speciale === 'SI' ? '<span class="badge badge-speciale">✂️ Speciale</span>' : ''}
          ${a.Categoria ? `<span class="badge">${a.Categoria}</span>` : ''}
        </div>
        <div class="articolo-nome">${a.Nome}</div>
        <div class="articolo-brand">${a.Brand || ''} · ${a.SKU}</div>
        <div class="articolo-prezzo">${CONFIG.VALUTA} ${a.Prezzo}</div>
      </div>
    </div>
  `).join('');
}

// ============================================
// CARICA ARTICOLO — SKU automatico
// ============================================
async function salvaArticolo() {
  const dati = {
    action:    'addArticolo',
    Nome:      document.getElementById('nNome').value.trim(),
    Categoria: document.getElementById('nCategoria').value.trim(),
    Brand:     document.getElementById('nBrand').value.trim(),
    Prezzo:    document.getElementById('nPrezzo').value,
    Foto_URL:  document.getElementById('nFoto').value.trim(),
    Speciale:  document.getElementById('nSpeciale').value,
    Note:      document.getElementById('nNote').value.trim(),
  };
  if (!dati.Nome) { showToast('Il nome è obbligatorio', 'error'); return; }

  const res = await apiPost(dati);
  if (res.success) {
    showToast(`✅ Articolo salvato! SKU: ${res.sku}`, 'success');
    // Pre-compila SKU nel form variante
    document.getElementById('vSKU').value = res.sku;
    document.getElementById('skuGenerato').textContent = `SKU generato: ${res.sku}`;
    document.getElementById('skuGenerato').style.display = 'block';
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

async function salvaVariante() {
  const dati = {
    action:   'addVariante',
    SKU:      document.getElementById('vSKU').value.trim(),
    Taglia:   document.getElementById('vTaglia').value.trim(),
    Colore:   document.getElementById('vColore').value.trim(),
    Quantita: document.getElementById('vQuantita').value,
    Speciale: document.getElementById('vSpeciale').value,
  };
  if (!dati.SKU || !dati.Taglia || !dati.Colore) {
    showToast('SKU, Taglia e Colore sono obbligatori', 'error');
    return;
  }
  const res = await apiPost(dati);
  if (res.success) {
    showToast(`✅ Variante ${res.id_variante} aggiunta!`, 'success');
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

// ============================================
// ETICHETTE QR
// ============================================
let etichetteCache = [];

async function caricaEtichette() {
  const [articoli, varianti] = await Promise.all([
    api({ action: 'getArticoli' }),
    api({ action: 'getVarianti' })
  ]);
  articoliCache   = articoli;
  variantiCache   = varianti;
  etichetteCache  = varianti.map(v => {
    const art = articoli.find(a => a.SKU === v.SKU) || {};
    return { ...v, Nome: art.Nome || v.SKU, Brand: art.Brand || '', Prezzo: art.Prezzo || '' };
  });
  renderEtichette(etichetteCache);
}

function filtraEtichette() {
  const testo = document.getElementById('filtroEtichettaTesto').value.toLowerCase();
  const filtrate = etichetteCache.filter(v =>
    !testo || v.Nome?.toLowerCase().includes(testo) || v.SKU?.toLowerCase().includes(testo)
  );
  renderEtichette(filtrate);
}

function renderEtichette(lista) {
  const el = document.getElementById('listaEtichette');
  if (!lista.length) {
    el.innerHTML = '<div style="color:#888; font-size:14px;">Nessuna variante trovata.</div>';
    return;
  }
  el.innerHTML = lista.map(v => `
    <label style="display:flex; align-items:center; gap:12px; background:white; border:1px solid var(--border); border-radius:10px; padding:14px; cursor:pointer; transition: border-color 0.15s;">
      <input type="checkbox" class="etichetta-check" value="${v.ID_Variante}" style="width:16px; height:16px; accent-color: var(--accent);">
      <div style="flex:1;">
        <div style="font-weight:600; font-size:14px;">${v.Nome}</div>
        <div style="font-size:12px; color:#888; margin-top:2px;">${v.Taglia} · ${v.Colore} · ${v.SKU}</div>
        <div style="font-size:13px; color: var(--accent); margin-top:2px;">€ ${v.Prezzo}</div>
      </div>
      <div style="font-size:11px; color:#bbb; font-family:monospace;">${v.ID_Variante}</div>
    </label>
  `).join('');
}

function selezionaTutte() {
  document.querySelectorAll('.etichetta-check').forEach(c => c.checked = true);
}

function deselezionaTutte() {
  document.querySelectorAll('.etichetta-check').forEach(c => c.checked = false);
}

function stampaEtichette() {
  const selezionate = [...document.querySelectorAll('.etichetta-check:checked')].map(c => c.value);
  if (!selezionate.length) { showToast('Seleziona almeno una variante', 'error'); return; }

  const varianti = selezionate.map(id => etichetteCache.find(v => v.ID_Variante === id)).filter(Boolean);

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Etichette QR</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: system-ui, sans-serif; background: white; }
        .grid { display: flex; flex-wrap: wrap; gap: 0; }
        .etichetta {
          width: 6cm; padding: 8px; border: 1px solid #ddd;
          display: flex; flex-direction: column; align-items: center;
          page-break-inside: avoid; text-align: center;
        }
        .qr { margin-bottom: 6px; }
        .nome { font-size: 10px; font-weight: 600; }
        .dettagli { font-size: 9px; color: #666; margin-top: 2px; }
        .prezzo { font-size: 12px; font-weight: 700; margin-top: 4px; }
        .id { font-size: 7px; color: #aaa; margin-top: 2px; font-family: monospace; }
        @media print {
          body { margin: 0; }
          button { display: none; }
        }
      </style>
    </head>
    <body>
      <button onclick="window.print()" style="margin:16px; padding:10px 20px; background:#5b87a0; color:white; border:none; border-radius:8px; font-size:14px; cursor:pointer;">
        🖨️ Stampa
      </button>
      <div class="grid" id="grid"></div>
      <script>
        const varianti = ${JSON.stringify(varianti)};
        const grid = document.getElementById('grid');
        varianti.forEach(v => {
          const div = document.createElement('div');
          div.className = 'etichetta';
          div.innerHTML = \`
            <div class="qr" id="qr-\${v.ID_Variante}"></div>
            <div class="nome">\${v.Nome}</div>
            <div class="dettagli">\${v.Taglia} · \${v.Colore}</div>
            <div class="prezzo">€ \${v.Prezzo}</div>
            <div class="id">\${v.ID_Variante}</div>
          \`;
          grid.appendChild(div);
          new QRCode(document.getElementById('qr-' + v.ID_Variante), {
            text: v.ID_Variante, width: 90, height: 90,
            colorDark: '#1a1a1a', colorLight: '#ffffff',
          });
        });
      <\/script>
    </body>
    </html>
  `);
  win.document.close();
}

// ============================================
// STORICO
// ============================================
async function caricaStorico() {
  const data  = await api({ action: 'getVendite' });
  const tbody = document.getElementById('tabellaVendite');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#888;">Nessuna vendita ancora</td></tr>';
    return;
  }
  tbody.innerHTML = [...data].reverse().map(v => {
    const d = new Date(v.Timestamp).toLocaleString('it-IT');
    return `<tr>
      <td>${d}</td>
      <td><strong>${v.Nome || v.SKU}</strong></td>
      <td>${v.Taglia}</td>
      <td>${v.Colore}</td>
      <td>${CONFIG.VALUTA} ${v.Prezzo}</td>
      <td style="color:#bbb; font-size:12px;">${v.ID_Vendita}</td>
    </tr>`;
  }).join('');
}

// ============================================
// TOAST
// ============================================
function showToast(msg, tipo = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast show ' + tipo;
  setTimeout(() => t.className = 'toast', 3000);
}