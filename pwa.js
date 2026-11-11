'use strict';

const connectionMessage = document.querySelector('#connection-message');
const pwaMessage = document.querySelector('#pwa-message');
const installButton = document.querySelector('#install-button');
let installPrompt;

function showConnection() {
  connectionMessage.textContent = navigator.onLine
    ? '新增報修與讀取清單需要網路連線。'
    : '目前離線：不能送出或更新清單，不會自動補送報修。';
  connectionMessage.className = navigator.onLine ? 'hint' : 'error';
}
showConnection();
window.addEventListener('online', showConnection);
window.addEventListener('offline', showConnection);

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  installButton.disabled = true;
  try {
    await installPrompt.prompt();
    await installPrompt.userChoice;
  } catch {
    pwaMessage.textContent = '請使用瀏覽器選單中的安裝或加入主畫面功能。';
  } finally {
    installPrompt = null;
    installButton.hidden = true;
    installButton.disabled = false;
  }
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
  pwaMessage.textContent = '已安裝報修登記。';
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(async registration => {
    // 等待安裝完成才顯示離線可用，避免第一次尚未快取就斷線。
    const ready = await navigator.serviceWorker.ready;
    if (ready.scope === registration.scope) {
      pwaMessage.textContent = '離線說明已備妥；報修資料不儲存在離線快取。';
    }
  }).catch(() => {
    pwaMessage.textContent = '離線支援未就緒，仍可在線上使用網頁；請連線後重新開啟。';
  });
} else {
  pwaMessage.textContent = '此瀏覽器或連線不支援離線安裝；請使用 HTTPS 網址開啟。';
}
