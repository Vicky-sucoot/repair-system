import { ASSETS, FX_SYMBOL, MARKET_DEFAULTS, simulate, combineTimelines } from './dca.js';
import { renderChart } from './chart.js';

const STORAGE_KEY = 'dca-tracker-plans-v1';
const DATA_URL = './data/prices.json';
const DEFAULT_PLANS = [
  { symbol: '0050.TW', startDate: '2020-01-02', initial: 100000, monthly: 10000, day: 6, ...MARKET_DEFAULTS.TW, reinvest: true },
  { symbol: 'VOO', startDate: '2020-01-02', initial: 100000, monthly: 10000, day: 6, ...MARKET_DEFAULTS.US, reinvest: true }
];
const NUMBER_FIELDS = ['initial', 'monthly', 'day', 'feeRate', 'minFee', 'dividendTax'];

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

function loadPlans() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length === DEFAULT_PLANS.length) {
      return saved.map((p, i) => ({ ...DEFAULT_PLANS[i], ...p, symbol: ASSETS[p.symbol] ? p.symbol : DEFAULT_PLANS[i].symbol }));
    }
  } catch { /* 無痕模式或資料損毀時使用預設值 */ }
  return DEFAULT_PLANS.map(p => ({ ...p }));
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
function buildPlans() {
  const container = $('#plans');
  const template = $('#plan-template');
  plans.forEach((plan, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.index = index;
    const form = card.querySelector('form');
    const select = form.elements.symbol;
    for (const [symbol, asset] of Object.entries(ASSETS)) {
      select.append(new Option(`${asset.short} ${asset.name}`, symbol));
    }
    fillForm(form, plan);
    form.addEventListener('input', event => onPlanInput(index, form, event.target));
    form.addEventListener('submit', event => event.preventDefault());
    container.append(card);
  });
  const today = new Date().toISOString().slice(0, 10);
  container.querySelectorAll('input[name="startDate"]').forEach(input => { input.max = today; });
}
function fillForm(form, plan) {
  form.elements.symbol.value = plan.symbol;
  form.elements.startDate.value = plan.startDate;
  NUMBER_FIELDS.forEach(name => { form.elements[name].value = plan[name]; });
  form.elements.wholeShares.checked = plan.wholeShares;
  form.elements.reinvest.checked = plan.reinvest;
}
function onPlanInput(index, form, target) {
  const plan = plans[index];
  if (target.name === 'symbol') {
    plan.symbol = target.value;
    Object.assign(plan, MARKET_DEFAULTS[ASSETS[plan.symbol].market]);
    fillForm(form, plan);
  } else if (target.type === 'checkbox') {
    plan[target.name] = target.checked;
  } else if (target.name === 'startDate') {
    if (!target.value) return;
    plan.startDate = target.value;
  } else if (NUMBER_FIELDS.includes(target.name)) {
    const value = Number(target.value);
    if (target.value === '' || !Number.isFinite(value) || value < 0) return;
    plan[target.name] = target.name === 'day' ? Math.min(31, Math.max(1, Math.round(value))) : value;
  }
  savePlans();
  render();
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
  results[index] = null;
  if (!prices) { tiles.replaceChildren(); return; }
  try {
    const r = simulate(plan, prices.symbols[plan.symbol], prices.symbols[FX_SYMBOL]);
    results[index] = r;
    message.className = 'plan-message hint';
    message.textContent = r.investedTWD > 0
      ? `試算至 ${r.asOf}，共 ${r.transactions.filter(t => t.type !== '配息').length} 筆買進。`
      : '開始日期之後尚無扣款紀錄。';
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
