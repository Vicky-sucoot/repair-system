'use strict';
// 行情頁的自選清單：輸入代號或名稱加入，顯示最近一個交易日收盤價（data/quotes.json，每日自動更新）。
(() => {
  const KEY = 'dca-tracker-mylist';
  const MARKET_KEY = 'dca-tracker-mylist-market';
  // 選單市場 → 資料中的市場代碼
  const MARKETS = { TW: ['TWSE', 'TPEx'], US: ['US'], JP: ['JP'] };
  const PLACEHOLDER = {
    TW: '輸入代號或名稱，例如 2330 或 台積電',
    US: '輸入代號或名稱，例如 AAPL、VOO 或 蘋果',
    JP: '輸入代號或名稱，例如 7203 或 トヨタ',
  };
  // 美股、日股報價來源禁止程式抓取，只提供代號與名稱，點名稱看 Yahoo 報價
  const NO_PRICE = ['US', 'JP'];
  let aliases = {};
  const MAX = 50;
  const $ = selector => document.querySelector(selector);
  let quotes = {};
  let list = load();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(saved) ? saved.filter(c => typeof c === 'string').slice(0, MAX) : [];
    } catch { return []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 無痕模式等情況忽略 */ }
    // 通知其他區塊（例如觀察名單的「加入自選」按鈕）清單已變更
    document.dispatchEvent(new CustomEvent('mylist:change', { detail: { list: [...list] } }));
  }
  function el(tag, text = '', className = '') {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function message(text, error = false) {
    const m = $('#mylist-message');
    m.textContent = text;
    m.className = error ? 'error' : 'hint';
  }
  const num = (v, digits = 2) => v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const market = () => $('#mylist-market').value;
  const inMarket = (code, m = market()) => Boolean(quotes[code]) && MARKETS[m].includes(quotes[code][1]);
  const shortCode = code => code.replace(/\.T$/, ''); // 日股顯示時去掉 .T
  const label = code => [aliases[code], quotes[code] && quotes[code][0]].filter(Boolean).join(' ');

  // 在選定的市場中，以代號、「代號 名稱」、完整名稱或只有一檔符合的部分名稱找股票
  function resolve(input) {
    const text = input.trim();
    if (!text) return { error: '請輸入股票代號或名稱。' };
    const m = market();
    const token = text.split(/\s+/)[0].toUpperCase();
    for (const code of [token, `${token}.T`]) if (inMarket(code, m)) return { code };
    const codes = Object.keys(quotes).filter(c => inMarket(c, m));
    const lower = text.toLowerCase();
    const exact = codes.find(c => quotes[c][0].toLowerCase() === lower || (aliases[c] || '').toLowerCase() === lower);
    if (exact) return { code: exact };
    const partial = codes.filter(c => label(c).toLowerCase().includes(lower));
    if (partial.length === 1) return { code: partial[0] };
    if (partial.length > 1) return { error: `「${text}」符合 ${partial.length} 檔，請輸入代號或從選單中選擇。` };
    const other = Object.keys(MARKETS).find(k => k !== m && [token, `${token}.T`].some(c => inMarket(c, k)));
    if (other) {
      const name = document.querySelector(`#mylist-market option[value="${other}"]`).textContent;
      return { error: `「${text}」屬於${name}，請先切換市場。` };
    }
    return { error: `找不到「${text}」，請確認代號或名稱。` };
  }

  function fillOptions() {
    const m = market();
    $('#mylist-input').placeholder = PLACEHOLDER[m];
    $('#mylist-options').replaceChildren(...Object.keys(quotes).filter(c => inMarket(c, m)).map(c => {
      const option = document.createElement('option');
      option.value = `${shortCode(c)} ${label(c)}`;
      return option;
    }));
  }

  function render() {
    const table = $('#mylist-table');
    if (!list.length) {
      table.replaceChildren();
      $('#mylist-table').closest('.table-wrap').hidden = true;
      if (!$('#mylist-message').textContent) message('尚未加入股票。輸入代號或名稱後按「加入」。');
      return;
    }
    table.closest('.table-wrap').hidden = false;
    const thead = el('thead');
    const hr = el('tr');
    ['代號', '名稱', '收盤', '漲跌', '漲跌幅', ''].forEach(h => hr.append(el('th', h)));
    const FLAG = { TPEx: '櫃', US: '美', JP: '日' };
    const LINK = {
      TWSE: c => `https://tw.stock.yahoo.com/quote/${encodeURIComponent(c)}.TW`,
      TPEx: c => `https://tw.stock.yahoo.com/quote/${encodeURIComponent(c)}.TWO`,
      US: c => `https://finance.yahoo.com/quote/${encodeURIComponent(c)}/`,
      JP: c => `https://finance.yahoo.com/quote/${encodeURIComponent(c)}/`,
    };
    // 收盤價加上幣別（窄螢幕以 CSS 隱藏幣別，市場標記已可辨識）
    const priceCell = (v, mk) => {
      const td = el('td');
      const cur = { US: 'US$', JP: '¥' }[mk];
      if (cur) td.append(el('span', cur, 'cur'));
      td.append(mk === 'JP' ? num(v, v >= 1000 ? 0 : 1) : num(v));
      return td;
    };
    thead.append(hr);
    const tbody = el('tbody');
    for (const code of list) {
      const q = quotes[code];
      const tr = el('tr');
      const nameCell = el('td');
      if (q) {
        // 有中文名稱時，手機版只顯示中文（英文名稱較長，以 CSS 隱藏）
        const a = el('a');
        if (aliases[code]) a.append(el('span', aliases[code]), el('span', ` ${q[0]}`, 'name-en'));
        else a.textContent = q[0];
        a.href = LINK[q[1]](code);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        nameCell.append(a);
        if (FLAG[q[1]]) nameCell.append(' ', el('span', FLAG[q[1]], 'flag'));
      } else {
        nameCell.textContent = '查無報價';
      }
      const [close, change] = q ? [q[2], q[3]] : [null, null];
      const prev = close != null && change != null ? close - change : null;
      const pct = prev ? change / prev : null;
      const tone = change > 0 ? 'up' : change < 0 ? 'down' : '';
      const remove = el('button', '移除', 'link-button danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', `從自選清單移除 ${q ? label(code) : code}`);
      remove.addEventListener('click', () => {
        list = list.filter(c => c !== code);
        save();
        message(`已移除 ${q ? label(code) : code}。`);
        render();
      });
      const actions = el('td', '', 'row-actions');
      actions.append(remove);
      tr.append(el('td', shortCode(code)), nameCell,
        close != null ? priceCell(close, q[1]) : el('td', q && NO_PRICE.includes(q[1]) ? '點名稱看報價' : '—', 'hint no-price'),
        el('td', change != null ? `${change > 0 ? '+' : ''}${num(change)}` : '—', tone),
        el('td', pct != null ? `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(2)}%` : '—', tone),
        actions);
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
  }

  try {
    const savedMarket = localStorage.getItem(MARKET_KEY);
    if (MARKETS[savedMarket]) $('#mylist-market').value = savedMarket;
  } catch { /* 忽略 */ }
  $('#mylist-market').addEventListener('change', () => {
    try { localStorage.setItem(MARKET_KEY, market()); } catch { /* 忽略 */ }
    $('#mylist-input').value = '';
    message('');
    fillOptions();
  });

  // 其他區塊（觀察名單）以事件加入台股：detail.code 為代號，結果寫回 detail.result
  document.addEventListener('mylist:add', event => {
    const { code, name } = event.detail || {};
    if (typeof code !== 'string' || !code) return;
    const shown = label(code) || name || code;
    if (list.includes(code)) { event.detail.result = { ok: false, text: `${shown}（${code}）已在自選清單中。` }; return; }
    if (list.length >= MAX) { event.detail.result = { ok: false, text: `自選清單最多 ${MAX} 檔。`, error: true }; return; }
    list.push(code);
    save();
    message(`已從觀察名單加入 ${shown}（${code}）。`);
    render();
    event.detail.result = { ok: true, text: `已加入 ${shown}（${code}）到「行情」的自選清單。` };
  });

  $('#mylist-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#mylist-input');
    const result = resolve(input.value);
    if (result.error) { message(result.error, true); return; }
    const name = label(result.code);
    const shown = shortCode(result.code);
    if (list.includes(result.code)) { message(`${name}（${shown}）已在清單中。`); return; }
    if (list.length >= MAX) { message(`清單最多 ${MAX} 檔。`, true); return; }
    list.push(result.code);
    save();
    input.value = '';
    message(`已加入 ${name}（${shown}）。${NO_PRICE.includes(quotes[result.code][1]) ? '美股、日股不顯示價格，點名稱可開啟 Yahoo 看報價。' : ''}`);
    render();
  });

  fetch('./data/quotes.json', { cache: 'no-cache' })
    .then(r => {
      if (!r.ok) throw new Error(r.status === 404 ? '尚未產生報價資料，請等下一次每日更新。' : `HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      quotes = data.quotes || {};
      aliases = data.aliases || {};
      const status = $('#mylist-status');
      status.className = 'hint';
      const d = data.dates || {};
      const parts = [['上市', d.TWSE], ['上櫃', d.TPEx]].filter(([, v]) => v).map(([k, v]) => `${k} ${v.slice(5)}`);
      status.textContent = `台股收盤日期 ${parts.join('、') || '—'}・共 ${Object.keys(quotes).length} 檔可查詢・美股、日股只提供代號與名稱，點名稱看 Yahoo 報價`;
      fillOptions();
      render();
    })
    .catch(error => {
      const status = $('#mylist-status');
      status.className = 'error';
      status.textContent = `無法取得報價：${error.message}`;
      render();
    });
})();
