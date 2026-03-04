// ============================================
// STATO GLOBALE
// ============================================
let articoliCache = [];
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
      if (sec === 'storico') caricaStorico();
      if (sec === 'inventario') caricaInventario();
      if (sec === 'dashboard') caricaDashboard();
    });
  });

  // Avvia polling e carica dati iniziali
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
      // Silenzioso — non interrompe l'UI
    }
  }, CONFIG.POLLING_INTERVAL);
}

function mostraScanBanner(v) {
  document.getElementById('scanBanner').style.display = 'block';
  document.getElementById('scanNome').textContent = v.Nome || v.SKU;
  document.getElementById('scanDettagli').textContent = `${v.Taglia} · ${v.Colore} · ${v.Brand || ''}`;
  document.getElementById('scanPrezzo').textContent = CONFIG.VALUTA + ' ' + (v.Prezzo || '—');
  document.getElementById('scanStock').textContent = `In magazzino: ${v.Quantità} pz`;

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
  document.getElementById('statVenditeTot').textContent = data.venditeTotali;
  document.getElementById('statIncassoTot').textContent = CONFIG.VALUTA + ' ' + data.incassoTotale;

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
  const cat = document.getElementById('filtroCategoria').value;
  const spec = document.getElementById('filtroSpeciale').value;

  const filtrati = articoliCache.filter(a => {
    const matchTesto = !testo || a.Nome?.toLowerCase().includes(testo) || a.SKU?.toLowerCase().includes(testo);
    const matchCat = !cat || a.Categoria === cat;
    const matchSpec = !spec || a.Speciale === spec;
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
// CARICA ARTICOLO / VARIANTE
// ============================================
async function salvaArticolo() {
  const dati = {
    action: 'addArticolo',
    SKU: document.getElementById('nSKU').value.trim(),
    Nome: document.getElementById('nNome').value.trim(),
    Categoria: document.getElementById('nCategoria').value.trim(),
    Brand: document.getElementById('nBrand').value.trim(),
    Prezzo: document.getElementById('nPrezzo').value,
    Foto_URL: document.getElementById('nFoto').value.trim(),
    Speciale: document.getElementById('nSpeciale').value,
    Note: document.getElementById('nNote').value.trim(),
  };
  if (!dati.SKU || !dati.Nome) { showToast('SKU e Nome sono obbligatori', 'error'); return; }
  const res = await apiPost(dati);
  if (res.success) {
    showToast('✅ Articolo salvato!', 'success');
    document.getElementById('vSKU').value = dati.SKU; // pre-compila SKU variante
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

async function salvaVariante() {
  const dati = {
    action: 'addVariante',
    SKU: document.getElementById('vSKU').value.trim(),
    Taglia: document.getElementById('vTaglia').value.trim(),
    Colore: document.getElementById('vColore').value.trim(),
    Quantita: document.getElementById('vQuantita').value,
    Speciale: document.getElementById('vSpeciale').value,
  };
  if (!dati.SKU || !dati.Taglia || !dati.Colore) { showToast('SKU, Taglia e Colore sono obbligatori', 'error'); return; }
  const res = await apiPost(dati);
  if (res.success) {
    showToast(`✅ Variante ${res.id_variante} aggiunta!`, 'success');
  } else {
    showToast('❌ ' + (res.error || 'Errore'), 'error');
  }
}

// ============================================
// STORICO
// ============================================
async function caricaStorico() {
  const data = await api({ action: 'getVendite' });
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
  t.className = 'toast show ' + tipo;
  setTimeout(() => t.className = 'toast', 3000);
}
