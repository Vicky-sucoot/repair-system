'use strict';
// 註冊 service worker：離線時可開啟網站並使用上次讀取的股價資料。
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 離線支援非必要功能 */ });
}
