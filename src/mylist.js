'use strict';
// 行情頁的自選清單：輸入代號或名稱加入，顯示最近一個交易日收盤價（data/quotes.json，每日自動更新）。
(() => {
  const KEY = 'dca-tracker-mylist';
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

  // 代號、「代號 名稱」、完整名稱，或只有一檔符合的部分名稱
  function resolve(input) {
    const text = input.trim();
    if (!text) return { error: '請輸入股票代號或名稱。' };
    const code = text.split(/\s+/)[0].toUpperCase();
    if (quotes[code]) return { code };
    const exact = Object.keys(quotes).find(c => quotes[c][0] === text);
    if (exact) return { code: exact };
    const partial = Object.keys(quotes).filter(c => quotes[c][0].includes(text));
    if (partial.length === 1) return { code: partial[0] };
    if (partial.length > 1) return { error: `「${text}」符合 ${partial.length} 檔，請輸入代號或從選單中選擇。` };
    return { error: `找不到「${text}」，請確認代號或名稱（目前支援上市、上櫃股票與 ETF）。` };
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
    thead.append(hr);
    const tbody = el('tbody');
    for (const code of list) {
      const q = quotes[code];
      const tr = el('tr');
      const nameCell = el('td');
      if (q) {
        const a = el('a', q[0]);
        a.href = `https://tw.stock.yahoo.com/quote/${encodeURIComponent(code)}.${q[1] === 'TPEx' ? 'TWO' : 'TW'}`;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        nameCell.append(a);
        if (q[1] === 'TPEx') nameCell.append(' ', el('span', '櫃', 'flag'));
      } else {
        nameCell.textContent = '查無報價';
      }
      const [close, change] = q ? [q[2], q[3]] : [null, null];
      const prev = close != null && change != null ? close - change : null;
      const pct = prev ? change / prev : null;
      const tone = change > 0 ? 'up' : change < 0 ? 'down' : '';
      const remove = el('button', '移除', 'link-button danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', `從自選清單移除 ${q ? q[0] : code}`);
      remove.addEventListener('click', () => {
        list = list.filter(c => c !== code);
        save();
        message(`已移除 ${q ? q[0] : code}。`);
        render();
      });
      const actions = el('td', '', 'row-actions');
      actions.append(remove);
      tr.append(el('td', code), nameCell,
        el('td', close != null ? num(close) : '—'),
        el('td', change != null ? `${change > 0 ? '+' : ''}${num(change)}` : '—', tone),
        el('td', pct != null ? `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(2)}%` : '—', tone),
        actions);
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
  }

  $('#mylist-form').addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#mylist-input');
    const result = resolve(input.value);
    if (result.error) { message(result.error, true); return; }
    const name = quotes[result.code][0];
    if (list.includes(result.code)) { message(`${name}（${result.code}）已在清單中。`); return; }
    if (list.length >= MAX) { message(`清單最多 ${MAX} 檔。`, true); return; }
    list.push(result.code);
    save();
    input.value = '';
    message(`已加入 ${name}（${result.code}）。`);
    render();
  });

  fetch('./data/quotes.json', { cache: 'no-cache' })
    .then(r => {
      if (!r.ok) throw new Error(r.status === 404 ? '尚未產生報價資料，請等下一次每日更新。' : `HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      quotes = data.quotes || {};
      const status = $('#mylist-status');
      status.className = 'hint';
      const d = data.dates || {};
      const when = d.TWSE && d.TPEx && d.TWSE !== d.TPEx ? `上市 ${d.TWSE}、上櫃 ${d.TPEx}` : (d.TWSE || d.TPEx || '—');
      status.textContent = `收盤日期 ${when}・共 ${Object.keys(quotes).length} 檔可查詢・來源：${data.source || '臺灣證券交易所、證券櫃檯買賣中心'}`;
      $('#mylist-options').replaceChildren(...Object.entries(quotes).map(([c, q]) => {
        const option = document.createElement('option');
        option.value = `${c} ${q[0]}`;
        return option;
      }));
      render();
    })
    .catch(error => {
      const status = $('#mylist-status');
      status.className = 'error';
      status.textContent = `無法取得報價：${error.message}`;
      render();
    });
})();
