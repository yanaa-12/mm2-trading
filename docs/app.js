const MAX_SELECTED = 8;

const allItems = [];
const selected = [];       // ordered item names currently charted
const slotOf = new Map();  // item name -> color slot (0..7), stable until released
const seriesMap = new Map(); // item name -> lightweight-charts series
const historyCache = new Map(); // item name -> parsed history rows

let sortState = { key: 'value', dir: 'desc' };
let historyFocus = null;
let chart = null;
let tooltipEl = null;

function safeFilename(name) {
  return name.replace(/[\/\\]/g, '_');
}

function itemCsvUrl(name) {
  return `data/items/${encodeURIComponent(safeFilename(name))}.csv?t=${Date.now()}`;
}

function normalizeItem(row) {
  return {
    name: row.name,
    category: row.category || '',
    value: Number(row.value) || 0,
    demand: Number(row.demand) || 0,
    rarity: Number(row.rarity) || 0,
    last_change: Number(row.last_change) || 0,
    stability: row.stability || '',
    origin: row.origin || '',
  };
}

function td(text) {
  const el = document.createElement('td');
  el.textContent = text;
  return el;
}

function relativeTime(date) {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    surface: v('--surface-1'),
    text: v('--text-secondary'),
    grid: v('--gridline'),
    border: v('--baseline'),
  };
}

function seriesColor(slot) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--series-${slot + 1}`).trim();
}

function assignSlot(name) {
  const used = new Set(slotOf.values());
  for (let i = 0; i < MAX_SELECTED; i++) {
    if (!used.has(i)) {
      slotOf.set(name, i);
      return i;
    }
  }
  return null;
}

function releaseSlot(name) {
  slotOf.delete(name);
}

// ---- Chart ----

function createChart() {
  const el = document.getElementById('chart');
  const theme = themeColors();

  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth,
    height: el.clientHeight,
    layout: { background: { type: 'solid', color: theme.surface }, textColor: theme.text },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Magnet },
  });

  new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    chart.applyOptions({ width, height });
  }).observe(el);

  tooltipEl = document.createElement('div');
  tooltipEl.className = 'chart-tooltip';
  el.appendChild(tooltipEl);

  chart.subscribeCrosshairMove(handleCrosshairMove);

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyChartTheme();
    refreshSeriesColors();
  });
}

function applyChartTheme() {
  const theme = themeColors();
  chart.applyOptions({
    layout: { background: { type: 'solid', color: theme.surface }, textColor: theme.text },
    grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
    rightPriceScale: { borderColor: theme.border },
    timeScale: { borderColor: theme.border },
  });
}

function refreshSeriesColors() {
  for (const [name, series] of seriesMap) {
    series.applyOptions({ color: seriesColor(slotOf.get(name)) });
  }
  renderLegend();
}

async function fetchItemHistory(name) {
  if (historyCache.has(name)) return historyCache.get(name);
  const text = await fetch(itemCsvUrl(name), { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  historyCache.set(name, rows);
  return rows;
}

async function addSeriesForItem(name) {
  const slot = slotOf.get(name);
  const series = chart.addLineSeries({
    color: seriesColor(slot),
    lineWidth: 2,
    priceLineVisible: false,
  });
  seriesMap.set(name, series);
  try {
    const rows = await fetchItemHistory(name);
    const data = rows
      .filter((r) => r.timestamp)
      .map((r) => ({ time: Math.floor(new Date(r.timestamp).getTime() / 1000), value: Number(r.value) }))
      .sort((a, b) => a.time - b.time);
    series.setData(data);
  } catch (err) {
    console.error(`Failed to load history for ${name}`, err);
  }
}

function removeSeriesForItem(name) {
  const series = seriesMap.get(name);
  if (series) {
    chart.removeSeries(series);
    seriesMap.delete(name);
  }
}

function handleCrosshairMove(param) {
  if (!param.time || !param.point || !seriesMap.size) {
    tooltipEl.style.display = 'none';
    return;
  }

  const lines = [];
  for (const [name, series] of seriesMap) {
    const d = param.seriesData.get(series);
    if (d && d.value !== undefined) lines.push({ name, value: d.value, slot: slotOf.get(name) });
  }
  if (!lines.length) {
    tooltipEl.style.display = 'none';
    return;
  }

  tooltipEl.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'tooltip-date';
  header.textContent = new Date(param.time * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  tooltipEl.appendChild(header);

  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'tooltip-row';
    const key = document.createElement('span');
    key.className = 'tooltip-key';
    key.style.background = seriesColor(line.slot);
    const value = document.createElement('span');
    value.className = 'tooltip-value';
    value.textContent = Number(line.value).toLocaleString();
    const label = document.createElement('span');
    label.className = 'tooltip-label';
    label.textContent = line.name;
    row.append(key, value, label);
    tooltipEl.appendChild(row);
  }

  tooltipEl.style.display = 'block';
  const containerRect = document.getElementById('chart').getBoundingClientRect();
  let left = param.point.x + 16;
  let top = param.point.y + 16;
  if (left + tooltipEl.offsetWidth > containerRect.width) left = param.point.x - tooltipEl.offsetWidth - 16;
  if (top + tooltipEl.offsetHeight > containerRect.height) top = containerRect.height - tooltipEl.offsetHeight - 8;
  tooltipEl.style.left = `${Math.max(0, left)}px`;
  tooltipEl.style.top = `${Math.max(0, top)}px`;
}

// ---- Selection ----

function toggleSelect(name) {
  const idx = selected.indexOf(name);
  if (idx >= 0) {
    selected.splice(idx, 1);
    releaseSlot(name);
    removeSeriesForItem(name);
    if (historyFocus === name) historyFocus = selected[selected.length - 1] || null;
  } else {
    if (selected.length >= MAX_SELECTED) {
      const oldest = selected.shift();
      releaseSlot(oldest);
      removeSeriesForItem(oldest);
    }
    selected.push(name);
    assignSlot(name);
    addSeriesForItem(name);
    historyFocus = name;
  }
  renderTable();
  renderLegend();
  renderHistoryTable();
}

// ---- Table ----

// Subsequence match: every character of the query must appear in the target,
// in order, but not necessarily contiguously (e.g. "trvlrgun" matches "Traveler's Gun").
function fuzzyMatch(query, target) {
  if (!query) return true;
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

function getFilteredSorted() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const cat = document.getElementById('categorySelect').value;
  let rows = allItems.filter((it) => (!cat || it.category === cat) && fuzzyMatch(q, it.name.toLowerCase()));

  const { key, dir } = sortState;
  rows = rows.slice().sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (typeof av === 'string') {
      av = av.toLowerCase();
      bv = bv.toLowerCase();
    }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

function renderTable() {
  const rows = getFilteredSorted();
  document.getElementById('tableCount').textContent = `${rows.length} of ${allItems.length}`;

  const tbody = document.getElementById('itemTableBody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const item of rows) {
    const tr = document.createElement('tr');
    const isSelected = selected.includes(item.name);
    if (isSelected) tr.classList.add('selected');

    const nameTd = document.createElement('td');
    nameTd.className = 'name-cell';
    if (isSelected) {
      const dot = document.createElement('span');
      dot.className = 'row-swatch';
      dot.style.background = seriesColor(slotOf.get(item.name));
      nameTd.appendChild(dot);
    }
    const nameText = document.createElement('span');
    nameText.textContent = item.name;
    nameTd.appendChild(nameText);
    tr.appendChild(nameTd);

    tr.appendChild(td(item.category));
    tr.appendChild(td(item.value.toLocaleString()));
    tr.appendChild(td(item.demand));
    tr.appendChild(td(item.rarity));

    const changeTd = td((item.last_change >= 0 ? '+' : '') + item.last_change.toLocaleString());
    changeTd.className = item.last_change > 0 ? 'delta-up' : item.last_change < 0 ? 'delta-down' : '';
    tr.appendChild(changeTd);

    tr.appendChild(td(item.stability));

    tr.addEventListener('click', () => toggleSelect(item.name));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function updateSortIndicators() {
  document.querySelectorAll('#itemTable thead th').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === sortState.key) {
      th.classList.add(sortState.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function populateCategories(items) {
  const cats = Array.from(new Set(items.map((i) => i.category))).sort();
  const sel = document.getElementById('categorySelect');
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

// ---- Legend & history ----

function renderLegend() {
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = '';

  if (!selected.length) {
    const span = document.createElement('span');
    span.className = 'legend-empty';
    span.textContent = 'Click up to 8 items in the table to chart them';
    legend.appendChild(span);
    return;
  }

  for (const name of selected) {
    const chip = document.createElement('div');
    chip.className = 'legend-chip';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = seriesColor(slotOf.get(name));
    const label = document.createElement('span');
    label.textContent = name;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove ${name} from chart`);
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(name);
    });
    chip.append(swatch, label, removeBtn);
    legend.appendChild(chip);
  }
}

async function renderHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  const titleEl = document.getElementById('historyTitle');

  if (!historyFocus) {
    tbody.innerHTML = '';
    titleEl.textContent = 'Value history';
    return;
  }

  titleEl.textContent = `Value history — ${historyFocus}`;
  const rows = await fetchItemHistory(historyFocus);
  const sorted = rows
    .filter((r) => r.timestamp)
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const r of sorted) {
    const tr = document.createElement('tr');
    tr.appendChild(td(r.timestamp.replace('T', ' ').replace('Z', ' UTC')));
    tr.appendChild(td(Number(r.value).toLocaleString()));
    tr.appendChild(td(r.demand));
    tr.appendChild(td(r.rarity));
    const change = Number(r.last_change);
    const changeTd = td((change >= 0 ? '+' : '') + change.toLocaleString());
    changeTd.className = change > 0 ? 'delta-up' : change < 0 ? 'delta-down' : '';
    tr.appendChild(changeTd);
    tr.appendChild(td(r.stability));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

// ---- Stats bar ----

function computeStats(items, meta) {
  document.getElementById('statTotal').textContent = items.length.toLocaleString();

  if (meta && meta.last_updated) {
    const d = new Date(meta.last_updated);
    document.getElementById('statUpdated').textContent = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    document.getElementById('statUpdatedRel').textContent = relativeTime(d);
  } else {
    document.getElementById('statUpdated').textContent = 'No data yet';
  }

  if (!items.length) return;

  const highest = items.reduce((a, b) => (b.value > a.value ? b : a));
  document.getElementById('statHighest').textContent = `${highest.name} — ${highest.value.toLocaleString()}`;

  const mostVolatile = items.reduce((a, b) => (Math.abs(b.last_change) > Math.abs(a.last_change) ? b : a));
  const volEl = document.getElementById('statVolatile');
  volEl.textContent = `${mostVolatile.name} `;
  const sign = document.createElement('span');
  sign.className = mostVolatile.last_change >= 0 ? 'delta-up' : 'delta-down';
  sign.textContent = (mostVolatile.last_change >= 0 ? '+' : '') + mostVolatile.last_change.toLocaleString();
  volEl.appendChild(sign);
}

function showEmptyState(message) {
  const tbody = document.getElementById('itemTableBody');
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 7;
  cell.className = 'empty-state';
  cell.textContent = message || 'No data yet — waiting for the first scrape to run.';
  tr.appendChild(cell);
  tbody.appendChild(tr);
}

// ---- Init ----

function wireControls() {
  document.getElementById('searchInput').addEventListener('input', renderTable);
  document.getElementById('categorySelect').addEventListener('change', renderTable);
  document.querySelectorAll('#itemTable thead th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = key === 'name' || key === 'category' || key === 'stability' ? 'asc' : 'desc';
      }
      updateSortIndicators();
      renderTable();
    });
  });
}

async function init() {
  createChart();
  wireControls();

  try {
    const [latestText, meta] = await Promise.all([
      fetch(`data/latest.csv?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.text()),
      fetch(`data/meta.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    const parsed = Papa.parse(latestText, { header: true, skipEmptyLines: true }).data;
    allItems.push(...parsed.filter((r) => r.name).map(normalizeItem));

    populateCategories(allItems);
    computeStats(allItems, meta);
    updateSortIndicators();
    renderTable();
    renderLegend();

    if (!allItems.length) showEmptyState();
  } catch (err) {
    console.error('Failed to load data', err);
    showEmptyState('Failed to load data.');
  }
}

init();
