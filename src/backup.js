// 資料備份與還原：把這台裝置瀏覽器中本 App 的紀錄（三位投資人的投資項目與投入、名稱、自選清單等）
// 匯出成一個 JSON 檔，換手機或清除瀏覽資料後可再匯入還原。

export const BACKUP_APP = '錢進梁家';
export const BACKUP_VERSION = 1;
export const KEY_PREFIX = 'dca-tracker'; // 本 App 在 localStorage 使用的鍵都以此開頭

const ownKey = key => typeof key === 'string' && key.startsWith(KEY_PREFIX);

/** 收集 storage（localStorage 或相同介面的物件）中本 App 的所有紀錄。 */
export function buildBackup(storage, now = new Date()) {
  const data = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (ownKey(key)) data[key] = storage.getItem(key);
  }
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), data };
}

/** 讀取備份檔文字，檢查格式；回傳 { exportedAt, entries: [[鍵, 值]] }，格式不符時拋出錯誤。 */
export function parseBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('檔案不是有效的備份檔。'); }
  if (backup?.app !== BACKUP_APP || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
    throw new Error(`這不是「${BACKUP_APP}」的備份檔。`);
  }
  if (backup.version !== BACKUP_VERSION) throw new Error('備份檔版本不支援，請更新 App 後再試。');
  const entries = Object.entries(backup.data).filter(([key, value]) => ownKey(key) && typeof value === 'string');
  if (!entries.length) throw new Error('備份檔中沒有任何紀錄。');
  return { exportedAt: typeof backup.exportedAt === 'string' ? backup.exportedAt : null, entries };
}

/** 以備份內容取代目前紀錄：先移除本 App 的舊紀錄，再寫入備份。 */
export function restoreBackup(storage, entries) {
  const old = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (ownKey(key)) old.push(key);
  }
  old.forEach(key => storage.removeItem(key));
  for (const [key, value] of entries) storage.setItem(key, value);
}

/** 備份檔名，日期以台灣時間為準。 */
export function backupFileName(now = new Date()) {
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  return `qianjin-backup-${day}.json`; // 英文檔名：部分瀏覽器下載時會丟掉中文檔名
}
