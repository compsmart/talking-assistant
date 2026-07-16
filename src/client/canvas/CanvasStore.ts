import type { CanvasDocumentRecord } from './CanvasDocument';

const DATABASE = 'cowork-canvas-v1';
const STORE = 'documents';

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'workspaceId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open Image Editor storage.'));
  });
}

export async function loadCanvasDocument(workspaceId: string) {
  const db = await database();
  try {
    return await new Promise<CanvasDocumentRecord | undefined>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(workspaceId);
      request.onsuccess = () => resolve(request.result as CanvasDocumentRecord | undefined);
      request.onerror = () => reject(request.error || new Error('Could not restore the Image Editor.'));
    });
  } finally { db.close(); }
}

export async function saveCanvasDocument(document: CanvasDocumentRecord) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(document);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the Image Editor.'));
      transaction.onabort = () => reject(transaction.error || new Error('Image Editor save was aborted.'));
    });
  } finally { db.close(); }
}

export async function deleteCanvasDocument(workspaceId: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(workspaceId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not delete the Image Editor document.'));
    });
  } finally { db.close(); }
}
