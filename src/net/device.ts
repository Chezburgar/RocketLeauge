/**
 * Device identity. Browsers can't read hardware IDs or MAC addresses, and IP
 * addresses change with the network – so instead each device generates a random
 * 256-bit key the first time it runs. The key is kept in three places (localStorage,
 * IndexedDB and a long-lived cookie) so it survives normal cache clears, and it can
 * be exported as a backup code from the Profile screen.
 */

const LS_KEY = 'bl.deviceKey';
const COOKIE = 'bl_dk';
const DB = 'boostleague';
const STORE = 'kv';

const isKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

function readCookie(): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([0-9a-f]{64})'));
  return m ? m[1] : null;
}
function writeCookie(k: string) {
  try {
    document.cookie = `${COOKIE}=${k}; max-age=${60 * 60 * 24 * 400}; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch {
    /* ignore */
  }
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

function randomKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

let cached: string | null = null;

export async function getDeviceKey(): Promise<string> {
  if (cached) return cached;
  let key: string | null = null;
  try {
    const ls = localStorage.getItem(LS_KEY);
    if (isKey(ls)) key = ls;
  } catch {
    /* ignore */
  }
  if (!key) {
    const fromDb = await idb<string>('readonly', (s) => s.get(LS_KEY) as IDBRequest<string>);
    if (isKey(fromDb)) key = fromDb;
  }
  if (!key) {
    const c = readCookie();
    if (isKey(c)) key = c;
  }
  if (!key) key = randomKey();
  await persist(key);
  cached = key;
  return key;
}

async function persist(key: string) {
  try {
    localStorage.setItem(LS_KEY, key);
  } catch {
    /* ignore */
  }
  writeCookie(key);
  await idb('readwrite', (s) => s.put(key, LS_KEY));
}

/** Replace this device's key (restoring from a backup code). */
export async function setDeviceKey(code: string): Promise<boolean> {
  const k = code.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (!isKey(k)) return false;
  cached = k;
  await persist(k);
  return true;
}

export function formatBackupCode(key: string) {
  return key.match(/.{1,8}/g)!.join('-').toUpperCase();
}

/** Human readable label so the admin can tell devices apart. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown OS';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const touch = navigator.maxTouchPoints > 1 ? ' · touch' : '';
  return `${os} · ${br}${touch} · ${screen.width}×${screen.height}`;
}
