import { ASSETS, FX_SYMBOL, MARKET_DEFAULTS, simulate, combineTimelines, syntheticSeries } from './dca.js';
import { renderChart } from './chart.js';

const STORAGE_KEY = 'dca-tracker-plans-v2';
const SELECTED_KEY = 'dca-tracker-selected-plan';
const LEGACY_KEY = 'dca-tracker-plans-v1';
const DATA_URL = './data/prices.json';
const QUOTES_URL = './data/quotes.json';
const DEFAULT_PLANS = [
  { symbol: '0050.TW', startDate: '2020-01-02', initial: 100000, ...MARKET_DEFAULTS.TW, reinvest: true, entries: [] },
  { symbol: 'VOO', startDate: '2020-01-02', initial: 100000, ...MARKET_DEFAULTS.US, reinvest: true, entries: [] }
];
// 使用者自行新增的台股項目
const customDefaults = (code, name) => ({ symbol: code, name, custom: true, startDate: todayString(), initial: 0, initialPrice: null,
  ...MARKET_DEFAULTS.TW, reinvest: false, entries: [] });
const NUMBER_FIELDS = ['initial', 'feeRate', 'minFee', 'dividendTax'];
const SETTING_FIELDS = ['symbol', 'startDate', ...NUMBER_FIELDS, 'initialPrice', 'wholeShares', 'reinvest'];

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
let quoteData = null; // 全市場最新收盤（自訂項目的現價與名稱）
let plans = loadPlans();
const results = [];

// 讀取設定與投入紀錄；舊版（定期定額）只沿用基本設定，不沿用自動扣款。
function loadPlans() {
  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const saved = read(STORAGE_KEY) || read(LEGACY_KEY);
  if (Array.isArray(saved) && saved.length) {
    return saved.filter(p => p && typeof p.symbol === 'string').map((p, i) => {
      const custom = Boolean(p.custom) && !ASSETS[p.symbol];
      const plan = custom ? customDefaults(p.symbol, p.name || p.symbol)
        : { ...(DEFAULT_PLANS.find(d => d.symbol === p.symbol) || DEFAULT_PLANS[i % DEFAULT_PLANS.length]) };
      for (const key of SETTING_FIELDS) if (p?.[key] !== undefined) plan[key] = p[key];
      if (!custom && !ASSETS[plan.symbol]) plan.symbol = DEFAULT_PLANS[i % DEFAULT_PLANS.length].symbol;
      plan.entries = Array.isArray(p?.entries)
        ? p.entries.filter(e => e && typeof e.date === 'string' && Number(e.amount) > 0).map(e => ({ id: String(e.id), date: e.date, amount: Number(e.amount), price: Number(e.price) > 0 ? Number(e.price) : null }))
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
function assetOf(plan) {
  return ASSETS[plan.symbol] || { short: plan.symbol, name: plan.name || plan.symbol, currency: 'TWD', market: 'TW', custom: true };
}

function buildPlans(selected) {
  const container = $('#plans');
  const template = $('#plan-template');
  container.replaceChildren();
  plans.forEach((plan, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.index = index;
    const form = card.querySelector('.plan-form');
    // 送出鍵位於表單外（交易紀錄上方），以 form 屬性連結到表單。
    form.id = `plan-form-${index}`;
    card.querySelector('.submit-button').setAttribute('form', form.id);
    const select = form.elements.symbol;
    const custom = Boolean(assetOf(plan).custom);
    if (custom) {
      select.append(new Option(`${plan.symbol} ${plan.name || ''}`, plan.symbol));
      select.disabled = true; // 自訂項目不能改標的（刪除後重新新增）
    } else {
      for (const [symbol, asset] of Object.entries(ASSETS)) select.append(new Option(`${asset.short} ${asset.name}`, symbol));
    }
    card.querySelector('.plan-custom-note').hidden = !custom;
    card.querySelector('.delete-plan').addEventListener('click', () => deletePlan(index));
    fillForm(form, plan);
    setEditing(card, false);
    // 切換標的時先帶入該市場的預設手續費與稅率，按送出才生效。
    if (!custom) select.addEventListener('change', () => {
      const defaults = MARKET_DEFAULTS[ASSETS[select.value].market];
      // 不同標的價格不同，清除原本輸入的成交價。
      fillForm(form, { ...readForm(form), ...defaults, symbol: select.value, initialPrice: null });
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
  refreshPlanSelect(selected);
}
// 投資項目下拉選單：一次只顯示一個項目的卡片。
function refreshPlanSelect(selected) {
  const select = $('#plan-select');
  if (selected === undefined) {
    try { selected = Number(localStorage.getItem(SELECTED_KEY)) || 0; } catch { selected = 0; }
  }
  if (!(selected >= 0 && selected < plans.length)) selected = 0;
  select.replaceChildren(...plans.map((_, i) => new Option('', String(i))));
  updatePlanOptions();
  select.value = String(selected);
  showPlan(selected);
  try { localStorage.setItem(SELECTED_KEY, String(selected)); } catch { /* 忽略 */ }
}
$('#plan-select').addEventListener('change', () => {
  showPlan(Number($('#plan-select').value));
  try { localStorage.setItem(SELECTED_KEY, $('#plan-select').value); } catch { /* 忽略 */ }
});

// ---------- 新增、刪除投資項目（台股） ----------
function twStocks() {
  return Object.entries(quoteData?.quotes || {}).filter(([, q]) => q[1] === 'TWSE' || q[1] === 'TPEx');
}
function resolveStock(input) {
  const text = input.trim();
  if (!text) return { error: '請輸入台股代號或名稱。' };
  const stocks = twStocks();
  if (!stocks.length) return { error: '報價資料尚未載入，請稍後再試。' };
  const token = text.split(/\s+/)[0].toUpperCase();
  const byCode = stocks.find(([c]) => c === token);
  if (byCode) return { code: byCode[0], name: byCode[1][0] };
  const exact = stocks.find(([, q]) => q[0] === text);
  if (exact) return { code: exact[0], name: exact[1][0] };
  const partial = stocks.filter(([, q]) => q[0].includes(text));
  if (partial.length === 1) return { code: partial[0][0], name: partial[0][1][0] };
  if (partial.length > 1) return { error: `「${text}」符合 ${partial.length} 檔，請輸入代號或從選單中選擇。` };
  return { error: `找不到「${text}」（目前支援上市、上櫃股票與 ETF）。` };
}
function itemMessage(text, error = false) {
  const m = $('#item-message');
  m.textContent = text;
  m.className = error ? 'error' : 'hint';
}
$('#item-form').addEventListener('submit', event => {
  event.preventDefault();
  const result = resolveStock($('#item-input').value);
  if (result.error) { itemMessage(result.error, true); return; }
  const builtIn = Object.entries(ASSETS).find(([, a]) => a.short === result.code);
  const symbol = builtIn ? builtIn[0] : result.code;
  if (plans.some(p => p.symbol === symbol)) { itemMessage(`${result.name}（${result.code}）已在投資項目中。`, true); return; }
  plans.push(builtIn ? { ...DEFAULT_PLANS.find(d => d.symbol === symbol), initial: 0, entries: [] } : customDefaults(result.code, result.name));
  savePlans();
  $('#item-input').value = '';
  buildPlans(plans.length - 1);
  render();
  itemMessage(`已新增 ${result.name}（${result.code}）。請在下方「每月投入」輸入投入金額與成交價。`);
});
function deletePlan(index) {
  const plan = plans[index];
  const asset = assetOf(plan);
  if (plans.length <= 1) { itemMessage('至少需要保留一個投資項目。', true); return; }
  const n = plan.entries.length;
  if (!window.confirm(`確定刪除「${asset.short} ${asset.name}」${n ? `及其 ${n} 筆投入紀錄` : ''}？刪除後無法復原。`)) return;
  plans.splice(index, 1);
  savePlans();
  buildPlans(Math.max(0, index - 1));
  render();
  itemMessage(`已刪除 ${asset.short} ${asset.name}。`);
}
function fillItemOptions() {
  $('#item-options').replaceChildren(...twStocks().map(([c, q]) => new Option(`${c} ${q[0]}`)));
}
function showPlan(index) {
  document.querySelectorAll('.plan').forEach(card => { card.hidden = Number(card.dataset.index) !== index; });
}
function updatePlanOptions() {
  const select = $('#plan-select');
  plans.forEach((plan, i) => {
    const asset = assetOf(plan);
    if (select.options[i]) select.options[i].textContent = `${asset.short} ${asset.name}`;
  });
}
function fillForm(form, plan) {
  form.elements.symbol.value = plan.symbol;
  form.elements.startDate.value = plan.startDate;
  NUMBER_FIELDS.forEach(name => { form.elements[name].value = plan[name]; });
  form.elements.initialPrice.value = plan.initialPrice > 0 ? plan.initialPrice : '';
  form.querySelector('.price-unit').textContent = assetOf(plan).currency === 'USD' ? 'US$' : 'NT$';
  form.elements.wholeShares.checked = plan.wholeShares;
  form.elements.reinvest.checked = plan.reinvest;
}
function readForm(form) {
  const values = { symbol: form.elements.symbol.value, startDate: form.elements.startDate.value };
  NUMBER_FIELDS.forEach(name => { values[name] = Number(form.elements[name].value); });
  const price = Number(form.elements.initialPrice.value);
  values.initialPrice = form.elements.initialPrice.value !== '' && price > 0 ? price : null;
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
  const values = readForm(form);
  const previous = plans[index];
  if (previous.custom) {
    // 自訂項目沒有歷史價格，原始投入須填成交價；標的固定
    if (values.initial > 0 && !values.initialPrice) {
      card.querySelector('.edit-status').textContent = '自訂項目有原始投入金額時，請填寫原始投入成交價。';
      form.elements.initialPrice.focus();
      return;
    }
    Object.assign(values, { symbol: previous.symbol, name: previous.name, custom: true });
  }
  let note = '';
  // 換標的後，舊紀錄的手動成交價屬於原標的，清除後改用收盤價。
  if (values.symbol !== previous.symbol && previous.entries.some(e => e.price > 0)) {
    previous.entries.forEach(e => { e.price = null; });
    note = '已更換標的，每月投入的手動成交價已清除，改用收盤價計算。';
  }
  plans[index] = { ...values, entries: previous.entries };
  fillForm(form, plans[index]);
  savePlans();
  setEditing(card, false);
  render();
  card.querySelector('.edit-status').textContent = `已送出並重新計算。${note}`;
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
    // 每月投入的成交價為必填。
    const price = Number(form.elements.price.value);
    if (!(price > 0)) return;
    const plan = plans[index];
    const editingId = editingEntry[index];
    const sameMonth = plan.entries.filter(e => e.id !== editingId && e.date.slice(0, 7) === date.slice(0, 7)).length;
    if (editingId) {
      const entry = plan.entries.find(e => e.id === editingId);
      if (entry) Object.assign(entry, { date, amount, price });
    } else {
      plan.entries.push({ id: newId(), date, amount, price });
    }
    plan.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    savePlans();
    resetEntryForm(index, card);
    render();
    card.querySelector('.entry-status').textContent =
      `${editingId ? '已修改' : '已送出'}：${date} 投入 ${format.money(amount)}${price ? `，成交價 ${format.price(price, assetOf(plan).currency)}` : ''}。${sameMonth ? `（${date.slice(0, 7)} 共有 ${sameMonth + 1} 筆投入）` : ''}`;
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
  form.elements.price.value = '';
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
  form.elements.price.value = entry.price > 0 ? entry.price : '';
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
      ? [`${format.price(t.price, result.currency)}${t.manualPrice ? '（手動）' : ''}`, format.shares(t.shares, whole), t.feeTWD ? format.money(t.feeTWD) : '—', format.money(t.investedAfter), format.shares(t.sharesAfter, whole)]
      : [result ? '待成交' : '—', '—', '—', '—', '—'];
    cells.forEach(c => tr.append(text('td', c)));
    tbody.append(tr);
  }
  element.replaceChildren(thead, tbody);
}

// ---------- 計算與顯示 ----------
// 內建標的用完整歷史價格；自訂台股用投入成交價＋最新收盤價組成簡易序列
function seriesFor(plan, asset) {
  if (!asset.custom) return prices.symbols[plan.symbol];
  const contributions = [{ date: plan.startDate, price: plan.initial > 0 ? plan.initialPrice : null },
    ...plan.entries.map(e => ({ date: e.date, price: e.price }))];
  const q = quoteData?.quotes?.[plan.symbol];
  const latestDate = q ? (quoteData.dates || {})[q[1]] : null;
  return syntheticSeries(contributions, q && latestDate ? { date: latestDate, close: q[2] } : null);
}
function renderPlan(index) {
  const plan = plans[index];
  const asset = assetOf(plan);
  const card = document.querySelector(`.plan[data-index="${index}"]`);
  card.querySelector('.plan-title').textContent = `${asset.short} ${asset.name}`;
  updatePlanOptions();
  card.querySelector('.plan-currency').textContent = asset.currency === 'USD' ? '美元計價・換算新台幣' : '新台幣計價';
  card.querySelector('.entry-price-unit').textContent = asset.currency === 'USD' ? 'US$' : 'NT$';
  const message = card.querySelector('.plan-message');
  const tiles = card.querySelector('.plan-tiles');
  const txTable = card.querySelector('.tx-table');
  const entryTable = card.querySelector('.entry-table');
  results[index] = null;
  if (!prices) { tiles.replaceChildren(); renderEntryTable(index, entryTable, null); return; }
  try {
    const r = simulate(plan, seriesFor(plan, asset), prices.symbols[FX_SYMBOL], asset);
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

// 最新行情卡片：每張可點開來源網站查看最新報價。
const QUOTE_LINKS = {
  '0050.TW': 'https://tw.stock.yahoo.com/quote/0050.TW',
  'VOO': 'https://finance.yahoo.com/quote/VOO/',
  [FX_SYMBOL]: 'https://finance.yahoo.com/quote/TWD%3DX/',
  TWII: 'https://tw.stock.yahoo.com/quote/%5ETWII',
  TX_NIGHT: 'https://www.taifex.com.tw/cht/3/futDailyMarketReport'
};
const indexNumber = n => n.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function quoteCard({ key, short, name, value, change, detail, date }) {
  const li = text('li', '', 'quote');
  const link = text('a', '', 'quote-link');
  link.href = QUOTE_LINKS[key];
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = `開啟 ${short} 最新行情（新視窗）`;
  link.append(text('span', short, 'quote-symbol'), text('span', name, 'quote-name'),
    text('strong', value, 'quote-price'), text('span', detail, `quote-change ${tone(change)}`), text('span', date, 'quote-date'));
  li.append(link);
  return li;
}
function renderQuotes() {
  const list = $('#quotes');
  const cards = [];
  // 指數放最前面。
  const twii = prices.indices?.TWII;
  if (twii?.close?.length) {
    const n = twii.close.length;
    const change = n > 1 ? twii.close[n - 1] / twii.close[n - 2] - 1 : 0;
    const diff = n > 1 ? twii.close[n - 1] - twii.close[n - 2] : 0;
    cards.push(quoteCard({ key: 'TWII', short: '加權指數', name: '台灣證券交易所', value: indexNumber(twii.close[n - 1]), change,
      detail: `${diff >= 0 ? '+' : ''}${indexNumber(diff)}（${format.percent(change)}）`, date: twii.dates[n - 1] }));
  }
  const night = prices.indices?.TX_NIGHT?.series?.at(-1);
  if (night) {
    const pct = night.changePct == null ? null : night.changePct / 100;
    cards.push(quoteCard({ key: 'TX_NIGHT', short: '台指期夜盤', name: `近月 ${night.month.slice(0, 4)}/${night.month.slice(4)}`, value: twd.format(night.close), change: night.change ?? 0,
      detail: `${night.change > 0 ? '+' : ''}${night.change ?? '—'}（${format.percent(pct)}）`, date: `${night.date} 夜盤收盤` }));
  }
  const entries = [...Object.entries(ASSETS).map(([s, a]) => [s, a.short, a.name, a.currency]), [FX_SYMBOL, 'USD/TWD', '美元兌新台幣', 'FX']];
  for (const [symbol, short, name, currency] of entries) {
    const s = prices.symbols[symbol];
    if (!s) continue;
    const n = s.close.length;
    const change = n > 1 ? s.close[n - 1] / s.close[n - 2] - 1 : 0;
    cards.push(quoteCard({ key: symbol, short, name, change,
      value: currency === 'FX' ? s.close[n - 1].toFixed(3) : format.price(s.close[n - 1], currency),
      detail: format.percent(change), date: s.dates[n - 1] }));
  }
  list.replaceChildren(...cards);
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
    try {
      const qr = await fetch(QUOTES_URL, { cache: 'no-cache' });
      if (qr.ok) { quoteData = await qr.json(); fillItemOptions(); }
    } catch { /* 自訂項目會改用最後一筆成交價 */ }
    const updated = new Date(data.updatedAt);
    const ageDays = (Date.now() - updated.getTime()) / 86400000;
    status.textContent = `資料來源：${data.source || '臺灣證券交易所、臺灣期貨交易所、Yahoo Finance'}・每個交易日自動更新・更新於 ${updated.toLocaleString('zh-TW', { hour12: false })}${ageDays > 4 ? '（資料可能已過期）' : ''}`;
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
