// Device-local browser storage. This origin can read its keys; the server cannot.
async function store(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('relay-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function load(): Promise<string | null> {
  const db = await store();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('session');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function save(value: string): Promise<void> {
  const db = await store();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(value, 'session');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function copy(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}
