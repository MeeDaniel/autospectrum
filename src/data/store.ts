import type { AdminSnapshot } from '../domain/admin';

export interface DemoStore {
  read(): Promise<AdminSnapshot>;
  update<T>(change: (snapshot: AdminSnapshot) => T): Promise<T>;
  subscribe(listener: () => void): () => void;
}

export function seedSnapshot(): AdminSnapshot {
  return {
    categories: [{ id: 'general', name: 'Общие работы', lineCount: 2, archived: false, revision: 1 }],
    services: [
      { id: 'diagnostics', categoryId: 'general', name: 'Диагностика', priceFrom: 1200, durationMinutes: 30, archived: false, revision: 1 },
      { id: 'oil', categoryId: 'general', name: 'Замена масла', priceFrom: 1500, durationMinutes: 45, archived: false, revision: 1 },
      { id: 'tires', categoryId: 'general', name: 'Шиномонтаж', priceFrom: 1800, durationMinutes: 60, archived: false, revision: 1 },
    ],
    bookings: [],
    settings: { workStart: 540, workEnd: 1080, breaks: [{ start: 720, end: 750 }], revision: 1 },
  };
}

// The persisted model contains only JSON-compatible plain data. JSON copying
// also works in Safari 14 and Chromium 90, which lack structuredClone.
export const copyDemoValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryDemoStore implements DemoStore {
  private snapshot = seedSnapshot();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  read(): Promise<AdminSnapshot> { return Promise.resolve(copyDemoValue(this.snapshot)); }
  update<T>(change: (snapshot: AdminSnapshot) => T): Promise<T> {
    const work = this.queue.then(() => {
      const next = copyDemoValue(this.snapshot);
      const result = change(next);
      this.snapshot = next;
      this.listeners.forEach(listener => listener());
      return result;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}

export class IndexedDbDemoStore implements DemoStore {
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private readonly signalKey = 'autospectrum-demo-changed';
  private storageListening = false;
  private onStorage = (event: StorageEvent) => { if (event.key === this.signalKey) this.notify(); };
  private database: Promise<IDBDatabase> | null = null;
  private getDb(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('Хранилище недоступно')); return; }
      const open = indexedDB.open('autospectrum-demo', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('state'); };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.database;
  }
  private notify(): void { this.listeners.forEach(listener => listener()); }
  private broadcast(): void {
    this.notify();
    if (this.channel) this.channel.postMessage('changed');
    else {
      try { localStorage.setItem(this.signalKey, `${Date.now()}-${Math.random()}`); } catch { /* Visibility refresh remains available. */ }
    }
  }
  async read(): Promise<AdminSnapshot> {
    const db = await this.getDb();
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const existing = await request(store.get('snapshot')) as AdminSnapshot | undefined;
    if (existing) return copyDemoValue(existing);
    const seed = seedSnapshot();
    store.put(seed, 'snapshot');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });
    return copyDemoValue(seed);
  }
  async update<T>(change: (snapshot: AdminSnapshot) => T): Promise<T> {
    const db = await this.getDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const objectStore = tx.objectStore('state');
      let result: T;
      const get = objectStore.get('snapshot');
      get.onsuccess = () => {
        try {
          const snapshot = copyDemoValue((get.result as AdminSnapshot | undefined) ?? seedSnapshot());
          result = change(snapshot);
          objectStore.put(snapshot, 'snapshot');
        } catch (error) { tx.abort(); reject(error); }
      };
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => { this.broadcast(); resolve(result); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('autospectrum-demo');
      this.channel.onmessage = () => this.notify();
    }
    if (!this.channel && !this.storageListening && typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorage);
      this.storageListening = true;
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.storageListening) {
        window.removeEventListener('storage', this.onStorage);
        this.storageListening = false;
      }
    };
  }
}
