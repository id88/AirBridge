import type { SerializedSession } from "./fountain";

const DB_NAME = "airbridge_sessions_v1";
const STORE_NAME = "sessions";
const MAX_SESSIONS = 6;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sid" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(session: SerializedSession): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Prune oldest sessions if exceeding cap
    const all = await listSessions();
    if (all.length > MAX_SESSIONS) {
      const stale = all.slice(MAX_SESSIONS);
      for (const s of stale) await deleteSession(s.sid);
    }
    db.close();
  } catch {
    // Non-fatal in private mode or restricted environments
  }
}

export async function loadSession(sid: string): Promise<SerializedSession | null> {
  try {
    const db = await openDb();
    const result = await new Promise<SerializedSession | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(sid);
      req.onsuccess = () => resolve((req.result as SerializedSession | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SerializedSession[]> {
  try {
    const db = await openDb();
    const result = await new Promise<SerializedSession[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const items = (req.result as SerializedSession[]) ?? [];
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch {
    return [];
  }
}

export async function deleteSession(sid: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(sid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}
