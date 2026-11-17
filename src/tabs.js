'use strict';
// 底部選項列：一次只顯示一個頁面（定期定額、行情、外資動向、新聞情緒、觀察名單）。
(() => {
  const KEY = 'dca-tracker-page';
  const pages = [...document.querySelectorAll('.page[data-page]')];
  const tabs = [...document.querySelectorAll('.tabbar [data-page]')];
  const ids = pages.map(p => p.dataset.page);

  function show(id, { save = true, scroll = true } = {}) {
    if (!ids.includes(id)) id = ids[0];
    pages.forEach(p => { p.hidden = p.dataset.page !== id; });
    tabs.forEach(t => {
      const active = t.dataset.page === id;
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    if (save) {
      try { localStorage.setItem(KEY, id); } catch { /* 無痕模式等情況忽略 */ }
      history.replaceState(null, '', `#${id}`);
    }
    if (scroll) window.scrollTo(0, 0);
    // 圖表依容器寬度繪製，切回頁面時重新排版
    window.dispatchEvent(new Event('resize'));
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => show(tab.dataset.page));
    tab.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      show(next.dataset.page);
    });
  });
  window.addEventListener('hashchange', () => show(location.hash.slice(1), { scroll: false }));

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* 忽略 */ }
  show(location.hash.slice(1) || saved || ids[0], { save: false, scroll: false });
})();
