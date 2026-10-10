// 截图结果存放在 IndexedDB 中，Service Worker 与结果页共用。
const DB_NAME = 'scroll-shot';
const STORE = 'shots';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const saveShot = (shot) => withStore('readwrite', (s) => { s.put(shot); });

export const getShot = (id) => withStore('readonly', (s) => s.get(id));

export async function pruneShots(keep) {
  const all = await withStore('readonly', (s) => s.getAll());
  const stale = all.sort((a, b) => b.createdAt - a.createdAt).slice(keep);
  if (!stale.length) return;
  await withStore('readwrite', (s) => stale.forEach((shot) => s.delete(shot.id)));
}
