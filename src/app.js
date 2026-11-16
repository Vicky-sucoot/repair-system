import { ASSETS, FX_SYMBOL, MARKET_DEFAULTS, simulate, combineTimelines } from './dca.js';
import { renderChart } from './chart.js';

const STORAGE_KEY = 'dca-tracker-plans-v2';
const LEGACY_KEY = 'dca-tracker-plans-v1';
const DATA_URL = './data/prices.json';
const DEFAULT_PLANS = [
  { symbol: '0050.TW', startDate: '2020-01-02', initial: 100000, ...MARKET_DEFAULTS.TW, reinvest: true, entries: [] },
  { symbol: 'VOO', startDate: '2020-01-02', initial: 100000, ...MARKET_DEFAULTS.US, reinvest: true, entries: [] }
];
const NUMBER_FIELDS = ['initial', 'feeRate', 'minFee', 'dividendTax'];
const SETTING_FIELDS = ['symbol', 'startDate', ...NUMBER_FIELDS, 'wholeShares', 'reinvest'];

const twd = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const format = {
  money: n => `NT$${twd.format(Math.round(n))}`,
  signed: n => `${n > 0 ? '+' : n < 0 ? '−' : ''}NT$${twd.format(Math.abs(Math.round(n)))}`,
  percent: n => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`),
  compact: n => (n >= 1e8 ? `${+(n / 1e8).toFixed(1)}億` : n >= 1e4 ? `${+(n / 1e4).toFixed(1)}萬` : twd.format(n)),
  price: (n, currency) => `${currency === 'USD' ? 'US$' : 'NT$'}${n.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  shares: (n, whole) => n.toLocaleString('zh-TW', { maximumFractionDigits: whole ? 0 : 4 })
};

const $ = selector => document.querySelector(selector);
let prices = null;
let plans = loadPlans();
const results = [];

// 讀取設定與投入紀錄；舊版（定期定額）只沿用基本設定，不沿用自動扣款。
function loadPlans() {
  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const saved = read(STORAGE_KEY) || read(LEGACY_KEY);
  if (Array.isArray(saved) && saved.length === DEFAULT_PLANS.length) {
    return saved.map((p, i) => {
      const plan = { ...DEFAULT_PLANS[i] };
      for (const key of SETTING_FIELDS) if (p?.[key] !== undefined) plan[key] = p[key];
      if (!ASSETS[plan.symbol]) plan.symbol = DEFAULT_PLANS[i].symbol;
      plan.entries = Array.isArray(p?.entries)
        ? p.entries.filter(e => e && typeof e.date === 'string' && Number(e.amount) > 0).map(e => ({ id: String(e.id), date: e.date, amount: Number(e.amount) }))
        : [];
      return plan;
    });
  }
  return DEFAULT_PLANS.map(p => ({ ...p, entries: [] }));
}
function savePlans() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch { /* 忽略 */ }
}

function text(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function tile(label, value, tone = '', sub = '') {
  const box = text('div', '', `tile ${tone}`);
  box.append(text('span', label, 'tile-label'), text('strong', value, 'tile-value'));
  if (sub) box.append(text('span', sub, 'tile-sub'));
  return box;
}
const tone = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');
function table(element, head, rows) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  head.forEach(h => tr.append(text('th', h)));
  thead.append(tr);
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const r = document.createElement('tr');
    row.forEach(cell => r.append(text('td', cell)));
    tbody.append(r);
  });
  element.replaceChildren(thead, tbody);
}

// ---------- 方案表單 ----------
// 表單預設鎖定；按「修改」解鎖編輯，按「送出」驗證、儲存並重新計算。
function buildPlans() {
  const container = $('#plans');
  const template = $('#plan-template');
  plans.forEach((plan, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.index = index;
    const form = card.querySelector('.plan-form');
    // 送出鍵位於表單外（交易紀錄上方），以 form 屬性連結到表單。
    form.id = `plan-form-${index}`;
    card.querySelector('.submit-button').setAttribute('form', form.id);
    const select = form.elements.symbol;
    for (const [symbol, asset] of Object.entries(ASSETS)) {
      select.append(new Option(`${asset.short} ${asset.name}`, symbol));
    }
    fillForm(form, plan);
    setEditing(card, false);
    // 切換標的時先帶入該市場的預設手續費與稅率，按送出才生效。
    select.addEventListener('change', () => {
      const defaults = MARKET_DEFAULTS[ASSETS[select.value].market];
      fillForm(form, { ...readForm(form), ...defaults, symbol: select.value });
    });
    form.addEventListener('submit', event => { event.preventDefault(); submitPlan(index, card); });
    card.querySelector('.edit-button').addEventListener('click', () => {
      setEditing(card, true);
      form.elements.initial.focus();
    });
    setupEntryForm(index, card);
    container.append(card);
  });
  container.querySelectorAll('input[type="date"]').forEach(input => { input.max = todayString(); });
}
function fillForm(form, plan) {
  form.elements.symbol.value = plan.symbol;
  form.elements.startDate.value = plan.startDate;
  NUMBER_FIELDS.forEach(name => { form.elements[name].value = plan[name]; });
  form.elements.wholeShares.checked = plan.wholeShares;
  form.elements.reinvest.checked = plan.reinvest;
}
function readForm(form) {
  const values = { symbol: form.elements.symbol.value, startDate: form.elements.startDate.value };
  NUMBER_FIELDS.forEach(name => { values[name] = Number(form.elements[name].value); });
  values.wholeShares = form.elements.wholeShares.checked;
  values.reinvest = form.elements.reinvest.checked;
  return values;
}
function setEditing(card, editing) {
  card.querySelector('.plan-fields').disabled = !editing;
  card.querySelector('.submit-button').disabled = !editing;
  card.querySelector('.edit-button').disabled = editing;
  card.classList.toggle('editing', editing);
  card.querySelector('.edit-status').textContent = editing ? '修改中：調整後請按「送出」重新計算。' : '';
}
function submitPlan(index, card) {
  const form = card.querySelector('.plan-form');
  if (!form.reportValidity()) return;
  plans[index] = { ...readForm(form), entries: plans[index].entries };
  fillForm(form, plans[index]);
  savePlans();
  setEditing(card, false);
  render();
  card.querySelector('.edit-status').textContent = '已送出並重新計算。';
}

// ---------- 每月投入（定期不定額） ----------
function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
const editingEntry = [];
function setupEntryForm(index, card) {
  const form = card.querySelector('.entry-form');
  form.elements.date.value = todayString();
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const date = form.elements.date.value;
    const amount = Math.round(Number(form.elements.amount.value));
    if (!(amount > 0)) return;
    const plan = plans[index];
    const editingId = editingEntry[index];
    const sameMonth = plan.entries.filter(e => e.id !== editingId && e.date.slice(0, 7) === date.slice(0, 7)).length;
    if (editingId) {
      const entry = plan.entries.find(e => e.id === editingId);
      if (entry) Object.assign(entry, { date, amount });
    } else {
      plan.entries.push({ id: newId(), date, amount });
    }
    plan.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    savePlans();
    resetEntryForm(index, card);
    render();
    card.querySelector('.entry-status').textContent =
      `${editingId ? '已修改' : '已送出'}：${date} 投入 ${format.money(amount)}。${sameMonth ? `（${date.slice(0, 7)} 共有 ${sameMonth + 1} 筆投入）` : ''}`;
  });
  card.querySelector('.entry-cancel').addEventListener('click', () => {
    resetEntryForm(index, card);
    card.querySelector('.entry-status').textContent = '已取消修改。';
  });
}
function resetEntryForm(index, card) {
  const form = card.querySelector('.entry-form');
  editingEntry[index] = null;
  form.elements.date.value = todayString();
  form.elements.amount.value = '';
  form.querySelector('.entry-submit').textContent = '送出';
  form.querySelector('.entry-cancel').hidden = true;
  card.classList.remove('editing-entry');
}
function editEntry(index, id) {
  const card = document.querySelector(`.plan[data-index="${index}"]`);
  const entry = plans[index].entries.find(e => e.id === id);
  if (!entry) return;
  const form = card.querySelector('.entry-form');
  editingEntry[index] = id;
  form.elements.date.value = entry.date;
  form.elements.amount.value = entry.amount;
  form.querySelector('.entry-submit').textContent = '儲存修改';
  form.querySelector('.entry-cancel').hidden = false;
  card.classList.add('editing-entry');
  card.querySelector('.entry-status').textContent = `修改 ${entry.date} 的投入紀錄，完成後按「儲存修改」。`;
  form.elements.amount.focus();
}
function deleteEntry(index, id) {
  const plan = plans[index];
  const entry = plan.entries.find(e => e.id === id);
  if (!entry || !window.confirm(`確定刪除 ${entry.date} 投入 ${format.money(entry.amount)} 的紀錄？`)) return;
  plan.entries = plan.entries.filter(e => e.id !== id);
  const card = document.querySelector(`.plan[data-index="${index}"]`);
  if (editingEntry[index] === id) resetEntryForm(index, card);
  savePlans();
  render();
  card.querySelector('.entry-status').textContent = `已刪除 ${entry.date} 的投入紀錄。`;
}
function button(label, className, onClick) {
  const b = text('button', label, className);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
// 投入紀錄表：原始投入與每月投入，含成交結果與累計；每月投入可修改或刪除。
function renderEntryTable(index, element, result) {
  const plan = plans[index];
  const whole = plan.wholeShares;
  const byId = new Map((result?.transactions || []).filter(t => t.id).map(t => [t.id, t]));
  const rows = [];
  if (plan.initial > 0) rows.push({ id: 'initial', date: plan.startDate, amount: plan.initial, type: '原始投入' });
  plan.entries.forEach(e => rows.push({ ...e, type: '每月投入' }));
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const head = ['投入日期', '投入金額', '操作', '成交價', '買進股數', '手續費', '累計投入', '累計庫存'];
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  head.forEach(h => hr.append(text('th', h)));
  thead.append(hr);
  const tbody = document.createElement('tbody');
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = text('td', '尚無投入紀錄，請在上方輸入本月投入金額並送出。', 'hint');
    td.colSpan = head.length;
    tr.append(td);
    tbody.append(tr);
  }
  for (const row of rows) {
    const t = byId.get(row.id);
    const tr = document.createElement('tr');
    if (editingEntry[index] === row.id) tr.className = 'row-editing';
    // 成交日與投入日期不同（遇假日順延）時一併標示。
    const dateLabel = `${row.date}${row.id === 'initial' ? '（原始投入）' : ''}${t && t.date !== row.date ? `→${t.date.slice(5)}` : ''}`;
    tr.append(text('td', dateLabel), text('td', format.money(row.amount)));
    const actions = text('td', '', 'row-actions');
    if (row.id !== 'initial') {
      actions.append(button('修改', 'link-button', () => editEntry(index, row.id)), button('刪除', 'link-button danger', () => deleteEntry(index, row.id)));
    } else {
      actions.textContent = '於基本設定修改';
      actions.classList.add('hint');
    }
    tr.append(actions);
    const cells = t
      ? [format.price(t.price, result.currency), format.shares(t.shares, whole), t.feeTWD ? format.money(t.feeTWD) : '—', format.money(t.investedAfter), format.shares(t.sharesAfter, whole)]
      : [result ? '待成交' : '—', '—', '—', '—', '—'];
    cells.forEach(c => tr.append(text('td', c)));
    tbody.append(tr);
  }
  element.replaceChildren(thead, tbody);
}

// ---------- 計算與顯示 ----------
function renderPlan(index) {
  const plan = plans[index];
  const asset = ASSETS[plan.symbol];
  const card = document.querySelector(`.plan[data-index="${index}"]`);
  card.querySelector('.plan-title').textContent = `${asset.short} ${asset.name}`;
  card.querySelector('.plan-currency').textContent = asset.currency === 'USD' ? '美元計價・換算新台幣' : '新台幣計價';
  const message = card.querySelector('.plan-message');
  const tiles = card.querySelector('.plan-tiles');
  const txTable = card.querySelector('.tx-table');
  const entryTable = card.querySelector('.entry-table');
  results[index] = null;
  if (!prices) { tiles.replaceChildren(); renderEntryTable(index, entryTable, null); return; }
  try {
    const r = simulate(plan, prices.symbols[plan.symbol], prices.symbols[FX_SYMBOL]);
    results[index] = r;
    message.className = 'plan-message hint';
    const buys = r.transactions.filter(t => t.id).length;
    message.textContent = (r.investedTWD > 0
      ? `計算至 ${r.asOf}，已累積 ${buys} 筆投入。`
      : '尚無已成交的投入。') + (r.pending.length ? `另有 ${r.pending.length} 筆共 ${format.money(r.pendingTWD)} 待成交（股價更新後計入）。` : '');
    renderEntryTable(index, entryTable, r);
    tiles.replaceChildren(
      tile('庫存股數', `${format.shares(r.shares, plan.wholeShares)} 股`, '', `平均成本 ${r.shares ? format.price(r.averageCost, 'TWD') : '—'}`),
      tile('最新收盤價', format.price(r.price, r.currency), '', r.currency === 'USD' ? `匯率 ${r.rate.toFixed(3)}` : r.asOf),
      tile('累計投入', format.money(r.investedTWD), '', `含手續費 ${format.money(r.feesTWD)}`),
      tile('目前市值', format.money(r.marketValueTWD), '', r.cashTWD > 0.5 ? `另有現金股息 ${format.money(r.cashTWD)}` : ''),
      tile('總損益', format.signed(r.profitTWD), tone(r.profitTWD), `報酬率 ${format.percent(r.returnRate)}`),
      tile('年化報酬率', format.percent(r.annualized), tone(r.annualized ?? 0), `累計領息 ${format.money(r.dividendsTWD)}`)
    );
    table(txTable, ['日期', '類型', '成交價／每股股息', '股數', '手續費', '金額（新台幣）', '累計庫存'],
      [...r.transactions].reverse().map(t => [
        t.date, t.type,
        t.type === '配息' ? `${t.price.toFixed(4)}` : format.price(t.price, r.currency),
        t.shares ? format.shares(t.shares, plan.wholeShares) : '—',
        t.feeTWD ? format.money(t.feeTWD) : '—',
        t.type === '配息' ? `+${format.money(-t.costTWD)}` : format.money(t.costTWD),
        format.shares(t.sharesAfter, plan.wholeShares)
      ]));
  } catch (error) {
    message.className = 'plan-message error';
    message.textContent = error.message;
    tiles.replaceChildren();
    txTable.replaceChildren();
    renderEntryTable(index, entryTable, null);
  }
}

function renderSummary() {
  const done = results.filter(Boolean);
  const summary = $('#summary');
  if (!done.length) {
    summary.replaceChildren(text('p', prices ? '尚無可計算的方案。' : '等待股價資料…', 'hint'));
    renderChart($('#chart'), $('#tooltip'), [], format);
    $('#timeline-table').replaceChildren();
    return;
  }
  const sum = key => done.reduce((s, r) => s + r[key], 0);
  const invested = sum('investedTWD');
  const total = sum('totalTWD');
  const profit = total - invested;
  summary.replaceChildren(
    tile('累計投入', format.money(invested)),
    tile('資產總值', format.money(total), '', '市值＋現金股息'),
    tile('總損益', format.signed(profit), tone(profit), `報酬率 ${format.percent(invested ? profit / invested : 0)}`),
    tile('累計領息', format.money(sum('dividendsTWD')), '', '已扣預扣稅')
  );
  const points = combineTimelines(done.map(r => r.timeline));
  renderChart($('#chart'), $('#tooltip'), points, format);
  table($('#timeline-table'), ['月份', '累計投入', '資產總值', '損益'],
    [...points].reverse().map(p => [p.date.slice(0, 7), format.money(p.investedTWD), format.money(p.totalTWD), format.signed(p.totalTWD - p.investedTWD)]));
}

function render() {
  plans.forEach((_, i) => renderPlan(i));
  renderSummary();
}

function renderQuotes() {
  const list = $('#quotes');
  list.replaceChildren();
  const entries = [...Object.entries(ASSETS).map(([s, a]) => [s, a.short, a.name, a.currency]), [FX_SYMBOL, 'USD/TWD', '美元兌新台幣', 'FX']];
  for (const [symbol, short, name, currency] of entries) {
    const s = prices.symbols[symbol];
    if (!s) continue;
    const n = s.close.length;
    const change = n > 1 ? s.close[n - 1] / s.close[n - 2] - 1 : 0;
    const li = text('li', '', 'quote');
    li.append(text('span', short, 'quote-symbol'), text('span', name, 'quote-name'),
      text('strong', currency === 'FX' ? s.close[n - 1].toFixed(3) : format.price(s.close[n - 1], currency), 'quote-price'),
      text('span', `${format.percent(change)}・${s.dates[n - 1]}`, `quote-change ${tone(change)}`));
    list.append(li);
  }
}

async function loadPrices() {
  const status = $('#data-status');
  const button = $('#reload-button');
  button.disabled = true;
  status.className = 'hint';
  status.textContent = '讀取股價資料中…';
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(response.status === 404 ? '尚未產生股價資料檔，請在 GitHub Actions 執行「更新股價資料」。' : `HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.symbols || !Object.keys(data.symbols).length) throw new Error('股價資料檔內容不完整。');
    prices = data;
    const updated = new Date(data.updatedAt);
    const ageDays = (Date.now() - updated.getTime()) / 86400000;
    status.textContent = `資料來源：${data.source || 'Yahoo Finance'}・更新於 ${updated.toLocaleString('zh-TW', { hour12: false })}${ageDays > 4 ? '（資料可能已過期）' : ''}`;
    if (ageDays > 4) status.className = 'error';
    renderQuotes();
  } catch (error) {
    status.className = 'error';
    status.textContent = `無法取得股價資料：${error.message}${prices ? '（顯示先前讀取的資料）' : ''}`;
  } finally {
    button.disabled = false;
    render();
  }
}

buildPlans();
render();
loadPrices();
$('#reload-button').addEventListener('click', loadPrices);
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSummary, 150); });
