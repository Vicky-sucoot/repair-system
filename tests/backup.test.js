import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, parseBackup, restoreBackup, backupFileName } from '../src/backup.js';

// 與 localStorage 相同介面的測試用儲存區
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

test('匯出只包含本 App 的紀錄，匯入後還原', () => {
  const source = memoryStorage({
    'dca-tracker-plans-v2': '[{"symbol":"0050.TW"}]',
    'dca-tracker-plans-v2-person2': '[]',
    'dca-tracker-people': '{"names":["爸爸","媽媽","人名3"],"current":1}',
    'other-app': 'x',
  });
  const backup = buildBackup(source, new Date('2026-11-19T00:00:00Z'));
  assert.equal(backup.app, '錢進梁家');
  assert.deepEqual(Object.keys(backup.data).sort(), ['dca-tracker-people', 'dca-tracker-plans-v2', 'dca-tracker-plans-v2-person2']);

  const { exportedAt, entries } = parseBackup(JSON.stringify(backup));
  assert.equal(exportedAt, '2026-11-19T00:00:00.000Z');
  // 新手機上有一筆舊紀錄與其他 App 的資料：舊紀錄被取代、其他 App 不受影響
  const target = memoryStorage({ 'dca-tracker-plans-v2-person3': '[{"symbol":"VOO"}]', 'other-app': 'keep' });
  restoreBackup(target, entries);
  assert.deepEqual(target.dump(), { 'other-app': 'keep', ...backup.data });
});

test('拒絕格式不符的檔案', () => {
  assert.throws(() => parseBackup('not json'), /不是有效的備份檔/);
  assert.throws(() => parseBackup('{"app":"別的App","version":1,"data":{}}'), /不是「錢進梁家」的備份檔/);
  assert.throws(() => parseBackup('{"app":"錢進梁家","version":2,"data":{"dca-tracker-x":"1"}}'), /版本不支援/);
  assert.throws(() => parseBackup('{"app":"錢進梁家","version":1,"data":{"evil":"1","dca-tracker-x":2}}'), /沒有任何紀錄/);
});

test('檔名使用台灣日期', () => {
  assert.equal(backupFileName(new Date('2026-11-18T17:00:00Z')), 'qianjin-backup-2026-11-19.json');
});
