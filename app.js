'use strict';

const form = document.querySelector('#repair-form');
const submitButton = document.querySelector('#submit-button');
const refreshButton = document.querySelector('#refresh-button');
const formMessage = document.querySelector('#form-message');
const listMessage = document.querySelector('#list-message');
const list = document.querySelector('#request-list');
const filterMessage = document.querySelector('#filter-message');
const filterButtons = document.querySelectorAll('[data-urgency]');
let cachedRequests = [];
let selectedUrgency = '全部';
let hasLoaded = false;
let client;
let submitting = false;
let loading = false;

function message(element, text, type = '') {
  element.textContent = text;
  element.className = type;
}

// 所有資料均透過 textContent 顯示，避免使用者輸入被當成 HTML 執行。
function node(tag, text, className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}

function renderRequests(rows) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = node('li', '', 'request');
    const tags = node('div', '', 'tags');
    tags.append(node('span', row.category, 'tag'), node('span', `緊急程度：${row.urgency}`, row.urgency === '高' ? 'tag high' : 'tag'), node('span', row.status, 'tag'));
    const date = new Date(row.created_at);
    const time = Number.isNaN(date.getTime()) ? '時間未知' : date.toLocaleString('zh-TW');
    item.append(tags, node('h3', `${row.location} · ${row.reporter_name}`), node('p', row.description, 'description'), node('p', time, 'meta'));
    fragment.append(item);
  }
  list.replaceChildren(fragment);
}

async function loadRequests() {
  if (loading) return;
  if (!navigator.onLine) {
    message(listMessage, '目前離線，無法更新清單；若下方有資料，僅為本次開啟時讀取的舊資料。', 'error');
    return;
  }
  loading = true;
  refreshButton.disabled = true;
  list.setAttribute('aria-busy', 'true');
  message(listMessage, '載入中…');
  try {
    const { data, error } = await client.from('repair_requests')
      .select('id,created_at,reporter_name,location,category,description,urgency,status')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(20);
    if (error) throw error;
    cachedRequests = data || [];
    hasLoaded = true;
    applyFilter();
    message(listMessage, data?.length ? `已顯示最近 ${data.length} 筆報修。` : '目前沒有報修紀錄。');
  } catch (error) {
    message(listMessage, `無法更新清單，請稍後按重新整理。${list.children.length ? '下方保留上次載入的資料。' : ''}（${error.message || '連線失敗'}）`, 'error');
  } finally {
    loading = false;
    refreshButton.disabled = !navigator.onLine;
    list.setAttribute('aria-busy', 'false');
  }
}

// 篩選僅處理已讀取的最近 20 筆資料，不發出額外資料庫請求。
function applyFilter() {
  for (const button of filterButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.urgency === selectedUrgency));
  }
  if (!hasLoaded) return;
  const rows = selectedUrgency === '全部'
    ? cachedRequests
    : cachedRequests.filter(row => row.urgency === selectedUrgency);
  renderRequests(rows);
  message(filterMessage, rows.length
    ? `目前篩選：${selectedUrgency}，顯示 ${rows.length} 筆。`
    : `已載入的清單中沒有${selectedUrgency === '全部' ? '' : `緊急程度為「${selectedUrgency}」的`}報修紀錄。`);
}

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    selectedUrgency = button.dataset.urgency;
    applyFilter();
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!navigator.onLine) {
    message(formMessage, '目前離線，尚未送出；請連線後再操作，本機不會暫存或自動補送。', 'error');
    return;
  }
  if (!client || submitting || !form.reportValidity()) return;
  const values = new FormData(form);
  // 明確列出可新增欄位，不傳送 status、id 或 created_at。
  const payload = Object.fromEntries(['reporter_name', 'location', 'category', 'description', 'urgency'].map(key => [key, String(values.get(key) || '').trim()]));
  if (Object.values(payload).some(value => !value)) {
    message(formMessage, '請填寫所有欄位，內容不能只有空白。', 'error');
    return;
  }
  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = '送出中…';
  message(formMessage, '正在送出，請稍候。');
  try {
    const { error } = await client.from('repair_requests').insert(payload);
    if (error) throw error;
    form.reset();
    message(formMessage, '報修已成功送出！初始狀態為待處理。', 'success');
    // 若手動重新整理正在進行，完成後仍重新取得新增後的清單。
    while (loading) await new Promise(resolve => setTimeout(resolve, 50));
    await loadRequests();
  } catch (error) {
    message(formMessage, `未能確認送出成功，輸入內容已保留；請先查看清單再決定是否重試，避免重複登記。（${error.message || '連線失敗'}）`, 'error');
  } finally {
    submitting = false;
    submitButton.disabled = !navigator.onLine;
    submitButton.textContent = '送出報修';
  }
});

refreshButton.addEventListener('click', loadRequests);
function updateConnection() {
  submitButton.disabled = !client || submitting || !navigator.onLine;
  refreshButton.disabled = !client || loading || !navigator.onLine;
  if (!navigator.onLine) {
    message(listMessage, '目前離線，無法更新清單；若下方有資料，僅為本次開啟時讀取的舊資料。', 'error');
  }
}
window.addEventListener('offline', updateConnection);
window.addEventListener('online', () => {
  updateConnection();
  if (client) loadRequests();
});
try {
  const config = window.REPAIR_CONFIG;
  if (!window.supabase?.createClient || !config?.url || !config?.publishableKey) throw new Error('連線設定或 Supabase 程式庫未載入，請重新整理頁面。');
  client = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  updateConnection();
  loadRequests();
} catch (error) {
  message(formMessage, error.message, 'error');
  message(listMessage, '目前無法載入清單。', 'error');
}
