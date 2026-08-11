/**
 * 翻译结果的持久缓存。
 *
 * 一小时视频的译文大约 200~400 KB，chrome.storage.local 放几十个视频就满了，
 * 所以用 IndexedDB。缓存命中意味着第二次看同一个视频零延迟、零成本。
 */

import type { RenderLine } from '../translate/types.ts';

const DB_NAME = 'yt-bilingual';
const DB_VERSION = 1;
const STORE = 'translations';

export interface CachedTranslation {
  /** 见 cacheKey()。 */
  key: string;
  videoId: string;
  lines: RenderLine[];
  /** partial 表示只翻了一部分，下次打开要接着翻。 */
  status: 'partial' | 'complete';
  model: string;
  promptVersion: number;
  updatedAt: number;
}

/**
 * 缓存 key 带上模型和提示词版本。
 *
 * 换了模型或改了提示词之后，旧结果就不该再用了 —— 否则调完提示词
 * 还在拿旧译文，会以为改动没生效。
 */
export function cacheKey(parts: {
  videoId: string;
  trackId: string;
  targetLang: string;
  model: string;
  promptVersion: number;
}): string {
  return [
    parts.videoId,
    parts.trackId,
    parts.targetLang,
    parts.model,
    `p${parts.promptVersion}`,
  ].join('|');
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        // 按更新时间清理旧条目时要用
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function readCache(key: string): Promise<CachedTranslation | null> {
  try {
    return (await tx('readonly', (s) => s.get(key))) ?? null;
  } catch {
    // 缓存坏了不该让翻译整个失败，重新翻一遍就是了
    return null;
  }
}

export async function writeCache(entry: CachedTranslation): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(entry) as IDBRequest<unknown>);
  } catch {
    // 同上：写不进去也只是下次要重翻
  }
}

export async function clearCache(): Promise<void> {
  await tx('readwrite', (s) => s.clear() as IDBRequest<unknown>);
}

/** 缓存条目数与占用估算，给设置页显示。 */
export async function cacheStats(): Promise<{ count: number }> {
  try {
    return { count: await tx('readonly', (s) => s.count()) };
  } catch {
    return { count: 0 };
  }
}
