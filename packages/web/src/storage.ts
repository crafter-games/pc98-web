/**
 * Local persistence for the web app. Nothing leaves the browser.
 *
 * Blobs (disk images, save overlays, save states) live in the Origin Private
 * File System when the browser can write to it, otherwise in IndexedDB.
 * Metadata (library, states, settings) lives in IndexedDB.
 */
import type { DriveKind, MachineConfig } from '@pc98-web/core';

export interface DiskRecord {
  id: string;
  name: string;
  kind: DriveKind;
  bytes: number;
  addedAt: number;
  lastUsedAt?: number;
  /** The guest has written to it: a save overlay exists. */
  hasSaves: boolean;
  /** Screenshot used as the library cover. */
  cover?: Blob;
}

export interface StateRecord {
  id: string;
  name: string;
  createdAt: number;
  /** Drive slot ("fdd0", "hdd0"...) -> disk id, as inserted when saved. */
  disks: Record<string, string>;
  config: MachineConfig;
  /** Small PNG preview. */
  thumbnail?: Blob;
}

export interface DisplaySettings {
  /** Scale the 640x400 picture by whole multiples only. */
  integerScale: boolean;
  /** Scanline overlay. */
  crt: boolean;
  /** 0..1 */
  volume: number;
}

export const DEFAULT_DISPLAY: DisplaySettings = { integerScale: false, crt: false, volume: 0.8 };

/** Optional real ROM and sample files the user can provide. */
export const ROM_FILES = ['bios.rom', 'font.rom', 'sound.rom', 'itf.rom', 'bios9821.rom', 'd8000.rom',
  '2608_bd.wav', '2608_sd.wav', '2608_top.wav', '2608_hh.wav', '2608_tom.wav', '2608_rim.wav'] as const;

export interface Settings {
  config?: Partial<MachineConfig>;
  display?: Partial<DisplaySettings>;
  /** Drive slot -> disk id inserted in the last session. */
  lastDisks?: Record<string, string>;
}

// ---- blob stores

export interface BlobStore {
  readonly kind: 'opfs' | 'idb';
  get(path: string): Promise<Uint8Array | undefined>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

class OpfsStore implements BlobStore {
  readonly kind = 'opfs' as const;
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async dir(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string]> {
    const parts = path.split('/').filter(Boolean);
    const file = parts.pop()!;
    let dir = this.root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return [dir, file];
  }

  async get(path: string) {
    try {
      const [dir, name] = await this.dir(path, false);
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return undefined;
      throw e;
    }
  }

  async put(path: string, bytes: Uint8Array) {
    const [dir, name] = await this.dir(path, true);
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
  }

  async delete(path: string) {
    try {
      const [dir, name] = await this.dir(path, false);
      await dir.removeEntry(name);
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  }

  async list(prefix: string) {
    try {
      const [dir] = await this.dir(`${prefix}/x`, false);
      const out: string[] = [];
      for await (const name of (dir as any).keys() as AsyncIterable<string>) out.push(`${prefix}/${name}`);
      return out;
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return [];
      throw e;
    }
  }

  /** OPFS exists in all modern browsers, but createWritable() is missing in some (older Safari). */
  static async open(): Promise<OpfsStore | undefined> {
    try {
      const root = await navigator.storage?.getDirectory?.();
      if (!root) return undefined;
      const probe = await root.getFileHandle('.probe', { create: true });
      if (typeof (probe as any).createWritable !== 'function') return undefined;
      const w = await probe.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
      await root.removeEntry('.probe');
      return new OpfsStore(root);
    } catch {
      return undefined;
    }
  }
}

// ---- IndexedDB

const DB_NAME = 'pc98-web';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const r = factory.open(DB_NAME, DB_VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('disks', { keyPath: 'id' });
    db.createObjectStore('states', { keyPath: 'id' });
    db.createObjectStore('settings');
    db.createObjectStore('blobs');
  };
  return req(r);
}

class IdbStore implements BlobStore {
  readonly kind = 'idb' as const;
  constructor(private readonly db: IDBDatabase) {}
  private store(mode: IDBTransactionMode) {
    return this.db.transaction('blobs', mode).objectStore('blobs');
  }
  async get(path: string) {
    const v = await req(this.store('readonly').get(path));
    return v ? new Uint8Array(v as ArrayBuffer) : undefined;
  }
  async put(path: string, bytes: Uint8Array) {
    await req(this.store('readwrite').put(bytes.slice().buffer, path));
  }
  async delete(path: string) {
    await req(this.store('readwrite').delete(path));
  }
  async list(prefix: string) {
    const keys = await req(this.store('readonly').getAllKeys());
    return (keys as string[]).filter((k) => k.startsWith(`${prefix}/`));
  }
}

/**
 * Images (covers, thumbnails) are stored as bytes, not Blobs: WebKit cannot
 * put Blobs in IndexedDB in ephemeral contexts such as Safari private browsing.
 */
interface StoredImage { mime: string; bytes: ArrayBuffer }
const IMAGE_FIELDS = ['cover', 'thumbnail'] as const;

async function toStored<T extends object>(rec: T): Promise<T> {
  const out = { ...rec } as Record<string, unknown>;
  for (const f of IMAGE_FIELDS) {
    const v = out[f];
    if (v instanceof Blob) out[f] = { mime: v.type || 'image/png', bytes: await v.arrayBuffer() } satisfies StoredImage;
  }
  return out as T;
}

function fromStored<T>(rec: T): T {
  if (!rec) return rec;
  const out: Record<string, unknown> = { ...(rec as object) };
  for (const f of IMAGE_FIELDS) {
    const v = out[f] as StoredImage | Blob | undefined;
    if (v && !(v instanceof Blob) && v.bytes) out[f] = new Blob([v.bytes], { type: v.mime });
  }
  return out as T;
}

const HDD_EXT = /\.(hdi|nhd|thd|hdd|vhd)$/i;
export const DISK_EXT = /\.(fdi|d88|88d|d98|98d|hdm|xdf|dup|nfd|img|ima|hdi|nhd|thd|hdd)$/i;

export function diskKind(name: string): DriveKind {
  return HDD_EXT.test(name) ? 'hdd' : 'fdd';
}

function newId(): string {
  return crypto.randomUUID();
}

/** Everything the app persists, behind one object. */
export class Storage {
  private constructor(private readonly db: IDBDatabase, readonly blobs: BlobStore) {}

  static async open(opts: { idb?: IDBFactory; blobs?: BlobStore } = {}): Promise<Storage> {
    const db = await openDb(opts.idb ?? indexedDB);
    const blobs = opts.blobs ?? (await OpfsStore.open()) ?? new IdbStore(db);
    return new Storage(db, blobs);
  }

  /** Asks the browser not to evict our data under storage pressure. */
  static async requestPersistence(): Promise<boolean> {
    try {
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  }

  private tx(store: string, mode: IDBTransactionMode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  // ---- disks

  async listDisks(): Promise<DiskRecord[]> {
    const all = ((await req(this.tx('disks').getAll())) as DiskRecord[]).map(fromStored);
    return all.sort((a, b) => (b.lastUsedAt ?? b.addedAt) - (a.lastUsedAt ?? a.addedAt));
  }

  async getDisk(id: string): Promise<DiskRecord | undefined> {
    return fromStored(await req(this.tx('disks').get(id)));
  }

  async addDisk(name: string, bytes: Uint8Array): Promise<DiskRecord> {
    const rec: DiskRecord = { id: newId(), name, kind: diskKind(name), bytes: bytes.length, addedAt: Date.now(), hasSaves: false };
    await this.blobs.put(`disks/${rec.id}`, bytes);
    // Convert before opening the transaction: awaiting inside one lets it auto-commit.
    const stored = await toStored(rec);
    await req(this.tx('disks', 'readwrite').put(stored));
    return rec;
  }

  /** Current contents: the save overlay if the guest wrote to it, otherwise the original. */
  async readDisk(id: string): Promise<Uint8Array> {
    const bytes = (await this.blobs.get(`saves/${id}`)) ?? (await this.blobs.get(`disks/${id}`));
    if (!bytes) throw new Error(`Disk ${id} is missing from storage`);
    return bytes;
  }

  async readOriginal(id: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(`disks/${id}`);
  }

  async writeSaves(id: string, bytes: Uint8Array): Promise<void> {
    await this.blobs.put(`saves/${id}`, bytes);
    await this.patchDisk(id, { hasSaves: true });
  }

  async discardSaves(id: string): Promise<void> {
    await this.blobs.delete(`saves/${id}`);
    await this.patchDisk(id, { hasSaves: false });
  }

  async setCover(id: string, cover: Blob): Promise<void> {
    await this.patchDisk(id, { cover });
  }

  async touchDisk(id: string): Promise<void> {
    await this.patchDisk(id, { lastUsedAt: Date.now() });
  }

  async renameDisk(id: string, name: string): Promise<void> {
    await this.patchDisk(id, { name });
  }

  private async patchDisk(id: string, patch: Partial<DiskRecord>): Promise<void> {
    const rec = await this.getDisk(id);
    if (rec) {
      const stored = await toStored({ ...rec, ...patch });
      await req(this.tx('disks', 'readwrite').put(stored));
    }
  }

  async deleteDisk(id: string): Promise<void> {
    await this.blobs.delete(`disks/${id}`);
    await this.blobs.delete(`saves/${id}`);
    await req(this.tx('disks', 'readwrite').delete(id));
  }

  // ---- save states

  async listStates(): Promise<StateRecord[]> {
    const all = ((await req(this.tx('states').getAll())) as StateRecord[]).map(fromStored);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Saves a state. Passing the id of an existing state overwrites it (quick-save slots). */
  async saveState(rec: Omit<StateRecord, 'id' | 'createdAt'> & { id?: string }, bytes: Uint8Array): Promise<StateRecord> {
    const full: StateRecord = { ...rec, id: rec.id ?? newId(), createdAt: Date.now() };
    await this.blobs.put(`states/${full.id}`, bytes);
    const stored = await toStored(full);
    await req(this.tx('states', 'readwrite').put(stored));
    return full;
  }

  async readState(id: string): Promise<Uint8Array> {
    const bytes = await this.blobs.get(`states/${id}`);
    if (!bytes) throw new Error(`State ${id} is missing from storage`);
    return bytes;
  }

  async deleteState(id: string): Promise<void> {
    await this.blobs.delete(`states/${id}`);
    await req(this.tx('states', 'readwrite').delete(id));
  }

  // ---- ROMs

  async listRoms(): Promise<string[]> {
    return (await this.blobs.list('rom')).map((p) => p.slice(4)).filter((n) => (ROM_FILES as readonly string[]).includes(n));
  }

  async readRoms(): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = {};
    for (const name of await this.listRoms()) out[name] = (await this.blobs.get(`rom/${name}`))!;
    return out;
  }

  async putRom(name: string, bytes: Uint8Array): Promise<void> {
    if (!(ROM_FILES as readonly string[]).includes(name.toLowerCase())) throw new Error(`${name} is not a ROM file NP2 uses`);
    await this.blobs.put(`rom/${name.toLowerCase()}`, bytes);
  }

  async deleteRom(name: string): Promise<void> {
    await this.blobs.delete(`rom/${name}`);
  }

  // ---- settings

  async getSettings(): Promise<Settings> {
    return ((await req(this.tx('settings').get('settings'))) as Settings | undefined) ?? {};
  }

  async patchSettings(patch: Partial<Settings>): Promise<void> {
    const cur = await this.getSettings();
    await req(this.tx('settings', 'readwrite').put({ ...cur, ...patch }, 'settings'));
  }

  // ---- backup

  /** Every record and blob, for export. */
  async dump(): Promise<{ meta: { disks: Omit<DiskRecord, 'cover'>[]; states: Omit<StateRecord, 'thumbnail'>[]; settings: Settings }; files: Record<string, Uint8Array> }> {
    const disks = await this.listDisks();
    const states = await this.listStates();
    const files: Record<string, Uint8Array> = {};
    for (const name of await this.listRoms()) files[`rom/${name}`] = (await this.blobs.get(`rom/${name}`))!;
    for (const d of disks) {
      if (d.cover) files[`covers/${d.id}.png`] = new Uint8Array(await d.cover.arrayBuffer());
      files[`disks/${d.id}`] = (await this.blobs.get(`disks/${d.id}`))!;
      const saves = await this.blobs.get(`saves/${d.id}`);
      if (saves) files[`saves/${d.id}`] = saves;
    }
    for (const s of states) {
      files[`states/${s.id}`] = await this.readState(s.id);
      if (s.thumbnail) files[`thumbs/${s.id}.png`] = new Uint8Array(await s.thumbnail.arrayBuffer());
    }
    return {
      meta: { disks: disks.map(({ cover: _c, ...d }) => d), states: states.map(({ thumbnail: _t, ...s }) => s), settings: await this.getSettings() },
      files,
    };
  }

  /** Merges an export into this storage. Existing records with the same id are replaced. */
  async restore(data: Awaited<ReturnType<Storage['dump']>>): Promise<{ disks: number; states: number }> {
    for (const d of data.meta.disks) {
      const original = data.files[`disks/${d.id}`];
      if (!original) continue;
      await this.blobs.put(`disks/${d.id}`, original);
      const saves = data.files[`saves/${d.id}`];
      if (saves) await this.blobs.put(`saves/${d.id}`, saves);
      else await this.blobs.delete(`saves/${d.id}`);
      const cover = data.files[`covers/${d.id}.png`];
      const rec = await toStored({ ...d, hasSaves: !!saves, cover: cover ? new Blob([cover as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : undefined });
      await req(this.tx('disks', 'readwrite').put(rec));
    }
    for (const [path, bytes] of Object.entries(data.files)) {
      if (path.startsWith('rom/')) await this.blobs.put(path, bytes);
    }
    let states = 0;
    for (const s of data.meta.states) {
      const bytes = data.files[`states/${s.id}`];
      if (!bytes) continue;
      const thumb = data.files[`thumbs/${s.id}.png`];
      await this.blobs.put(`states/${s.id}`, bytes);
      const rec = await toStored({ ...s, thumbnail: thumb ? new Blob([thumb as Uint8Array<ArrayBuffer>], { type: 'image/png' }) : undefined });
      await req(this.tx('states', 'readwrite').put(rec));
      states++;
    }
    if (data.meta.settings) await this.patchSettings(data.meta.settings);
    return { disks: data.meta.disks.length, states };
  }
}
