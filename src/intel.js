// 外資動向與財經新聞情緒：讀取 Python 每日流程匯出的 data/foreign.json、data/news.json。
// 所有外部文字（股名、新聞標題）一律以 textContent 寫入，避免被當成 HTML。

const $ = selector => document.querySelector(selector);
const int = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
let foreignData = null;
let newsData = null;
let foreignView = 'streaks';
let newsFilter = '全部';

function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const tone = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const lots = n => `${n > 0 ? '+' : ''}${int.format(n)}`;
const yi = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v / 1e8).toFixed(2)}`);
function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}
async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(response.status === 404 ? '尚未產生資料，請在 GitHub Actions 執行「外資動向與新聞情緒」。' : `HTTP ${response.status}`);
  return response.json();
}

// ---------- 外資動向 ----------
function renderForeign() {
  const table = $('#foreign-table');
  document.querySelectorAll('[data-foreign]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.foreign === foreignView)));
  if (!foreignData) { table.replaceChildren(); return; }
  const rows = foreignData[foreignView] || [];
  const thead = el('thead');
  const hr = el('tr');
  ['代號', '名稱', '買賣超(張)', '金額(億)', '連買'].forEach(h => hr.append(el('th', h)));
  thead.append(hr);
  const tbody = el('tbody');
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', foreignView === 'streaks' ? `今日沒有連續買超 ${foreignData.streak_min_days} 天以上的個股。` : '沒有資料。', 'hint');
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr');
    const name = el('td', r.name);
    if (r.is_big) name.append(' ', el('span', r.net_shares > 0 ? '大買' : '大賣', `flag ${tone(r.net_shares)}`));
    if (r.market === 'TPEx') name.append(' ', el('span', '櫃', 'flag'));
    tr.append(el('td', r.code), name, el('td', lots(r.net_lots), tone(r.net_lots)), el('td', yi(r.net_value), tone(r.net_value ?? 0)),
      el('td', r.streak_days ? `${r.streak_days} 天` : '—'));
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);
}

// Claude 對外資動向的解讀（需設定 API 金鑰；沒有時不顯示）
function renderInsight() {
  const box = $('#foreign-insight');
  const insight = foreignData?.insight;
  if (!insight?.summary) { box.hidden = true; box.replaceChildren(); return; }
  const head = el('p', '', 'insight-head');
  head.append(el('strong', 'Claude 解讀'), el('span', `・${insight.model || 'Claude'}・AI 產生，僅供參考`, 'hint'));
  const parts = [head, el('p', insight.summary, 'insight-summary')];
  if (insight.highlights?.length) {
    const list = el('ul', '', 'insight-list');
    for (const h of insight.highlights) {
      const li = el('li');
      li.append(el('span', h.view, `badge-sentiment ${h.view === '偏多' ? 'up' : h.view === '偏空' ? 'down' : ''}`), ' ',
        el('strong', `${h.name} ${h.code}`), el('span', `：${h.reason}`));
      list.append(li);
    }
    parts.push(list);
  }
  const tags = [...(insight.themes || []).map(t => ['題材', t]), ...(insight.risks || []).map(r => ['風險', r])];
  if (tags.length) {
    const chips = el('ul', '', 'chips');
    tags.forEach(([kind, text]) => {
      const li = el('li', '', 'chip');
      li.append(el('strong', `${kind} `), text);
      chips.append(li);
    });
    parts.push(chips);
  }
  box.replaceChildren(...parts);
  box.hidden = false;
}

// ---------- 新聞情緒 ----------
function sentimentClass(s) { return s === '利多' ? 'up' : s === '利空' ? 'down' : 'neutral'; }

function renderNews() {
  document.querySelectorAll('[data-news]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.news === newsFilter)));
  const list = $('#news-list');
  if (!newsData) { list.replaceChildren(); return; }
  const counts = newsData.counts || {};
  $('#news-counts').replaceChildren(...['利多', '利空', '中性'].map(k => {
    const box = el('div', '', `tile ${sentimentClass(k)}`);
    box.append(el('span', k, 'tile-label'), el('strong', `${counts[k] ?? 0} 則`, 'tile-value'));
    return box;
  }));
  const chips = (newsData.stocks || []).slice(0, 12).map(s => {
    const li = el('li', '', 'chip');
    li.append(el('strong', `${s.name} ${s.code}`));
    if (s.bullish) li.append(' ', el('span', `利多 ${s.bullish}`, 'up'));
    if (s.bearish) li.append(' ', el('span', `利空 ${s.bearish}`, 'down'));
    if (!s.bullish && !s.bearish) li.append(' ', el('span', `中性 ${s.neutral}`, 'neutral'));
    return li;
  });
  $('#news-stocks').replaceChildren(...(chips.length ? chips : [el('li', '近期新聞沒有比對到個股。', 'hint')]));
  const items = (newsData.items || []).filter(i => newsFilter === '全部' || i.sentiment === newsFilter);
  list.replaceChildren(...items.slice(0, 60).map(item => {
    const li = el('li', '', 'news-item');
    const head = el('div', '', 'news-head');
    head.append(el('span', item.sentiment, `badge-sentiment ${sentimentClass(item.sentiment)}`));
    const url = safeUrl(item.url);
    const title = url ? el('a', item.title) : el('span', item.title);
    if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    head.append(title);
    li.append(head, el('p', `${item.source}・${timeLabel(item.published_at)}`, 'news-meta'));
    const bits = [];
    if (item.bullish_keywords?.length) bits.push(`利多詞：${item.bullish_keywords.join('、')}`);
    if (item.bearish_keywords?.length) bits.push(`利空詞：${item.bearish_keywords.join('、')}`);
    if (item.stocks?.length) bits.push(`個股：${item.stocks.map(s => `${s.name}(${s.code})`).join('、')}`);
    if (item.reason) bits.push(item.reason);
    if (bits.length) li.append(el('p', bits.join('｜'), 'news-meta'));
    return li;
  }));
  if (!items.length) list.replaceChildren(el('li', '沒有符合的新聞。', 'hint'));
}

async function loadIntel() {
  const foreignStatus = $('#foreign-status');
  const newsStatus = $('#news-status');
  try {
    foreignData = await loadJson('./data/foreign.json');
    const c = foreignData.counts || {};
    foreignStatus.className = 'hint';
    foreignStatus.textContent = `${foreignData.date} 外資及陸資買賣超・買超 ${c.buy ?? 0} 家、賣超 ${c.sell ?? 0} 家・連買 ${foreignData.streak_min_days} 天以上 ${c.streaks ?? 0} 家・大買／大賣門檻 ${(foreignData.big_trade_value / 1e8).toFixed(0)} 億元・來源：${foreignData.source}`;
  } catch (error) {
    foreignStatus.className = 'error';
    foreignStatus.textContent = `無法取得外資資料：${error.message}`;
  }
  try {
    newsData = await loadJson('./data/news.json');
    newsStatus.className = 'hint';
    newsStatus.textContent = `近 ${newsData.items?.length ?? 0} 則・更新於 ${timeLabel(newsData.updatedAt)}・來源：${(newsData.sources || []).join('、')}・分析方式：${newsData.analyzer === 'llm' ? 'Claude AI' : '關鍵字詞典'}`;
  } catch (error) {
    newsStatus.className = 'error';
    newsStatus.textContent = `無法取得新聞資料：${error.message}`;
  }
  renderInsight();
  renderForeign();
  renderNews();
}

document.querySelectorAll('[data-foreign]').forEach(b => b.addEventListener('click', () => { foreignView = b.dataset.foreign; renderForeign(); }));
document.querySelectorAll('[data-news]').forEach(b => b.addEventListener('click', () => { newsFilter = b.dataset.news; renderNews(); }));
loadIntel();
