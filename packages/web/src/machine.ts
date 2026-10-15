import { PC98, type DriveKind, type MachineConfig } from '@pc98-web/core';
import { Storage, type DiskRecord, type StateRecord } from './storage';

export type SlotId = 'fdd0' | 'fdd1' | 'hdd0';
export const SLOTS: { id: SlotId; kind: DriveKind; drive: number; label: string }[] = [
  { id: 'fdd0', kind: 'fdd', drive: 0, label: 'FDD 1' },
  { id: 'fdd1', kind: 'fdd', drive: 1, label: 'FDD 2' },
  { id: 'hdd0', kind: 'hdd', drive: 0, label: 'HDD 1' },
];

const WRITE_BACK_DELAY_MS = 1000;

/**
 * A PC98 bound to local storage: disks come from the library, the guest's
 * writes are saved back (debounced), and states carry the disks they need.
 */
export class Machine {
  readonly storage: Storage;
  pc!: PC98;
  /** Slot -> disk id. */
  readonly mounted = new Map<SlotId, string>();
  private readonly dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();

  private constructor(storage: Storage) {
    this.storage = storage;
  }

  static async create(storage: Storage, config?: Partial<MachineConfig>): Promise<Machine> {
    const m = new Machine(storage);
    await m.boot(config);
    return m;
  }

  /** (Re)creates the emulated machine, keeping the mounted disks. */
  async boot(config?: Partial<MachineConfig>): Promise<void> {
    await this.flush();
    const settings = await this.storage.getSettings();
    this.pc = await PC98.create({
      config: config ?? settings.config,
      onDiskChange: (name) => this.markDirty(name),
    });
    for (const [slot, id] of this.mounted) await this.mountBytes(slot, id);
    this.pc.reset();
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tells the UI that storage changed outside the machine (library edits, imports). */
  refresh(): void {
    this.emit();
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  /** Re-inserts the disks of the previous session without starting the machine. */
  async restoreLastSession(): Promise<void> {
    const { lastDisks } = await this.storage.getSettings();
    for (const [slot, id] of Object.entries(lastDisks ?? {}) as [SlotId, string][]) {
      if (await this.storage.getDisk(id)) await this.insert(slot, id, { reset: false });
    }
    this.pc.reset();
  }

  /** NP2 picks the image format from the file extension, so keep it. */
  private fsName(disk: DiskRecord): string {
    const ext = /\.[^.]+$/.exec(disk.name)?.[0] ?? '';
    return `${disk.id}${ext.toLowerCase()}`;
  }

  private async mountBytes(slot: SlotId, id: string): Promise<DiskRecord> {
    const disk = await this.storage.getDisk(id);
    if (!disk) throw new Error('That disk is no longer in the library');
    const s = SLOTS.find((x) => x.id === slot)!;
    if (s.kind !== disk.kind) throw new Error(`${disk.name} is a ${disk.kind === 'hdd' ? 'hard disk' : 'floppy'} image`);
    this.pc.insertDisk(s.kind, s.drive, this.fsName(disk), await this.storage.readDisk(id));
    return disk;
  }

  async insert(slot: SlotId, id: string, opts: { reset?: boolean } = {}): Promise<void> {
    await this.flush();
    const disk = await this.mountBytes(slot, id);
    this.mounted.set(slot, id);
    await this.storage.touchDisk(id);
    await this.saveMounted();
    if (disk.kind === 'hdd' && opts.reset !== false) this.pc.reset();
    this.emit();
  }

  async eject(slot: SlotId): Promise<void> {
    await this.flush();
    const s = SLOTS.find((x) => x.id === slot)!;
    this.pc.ejectDisk(s.kind, s.drive);
    this.mounted.delete(slot);
    await this.saveMounted();
    this.emit();
  }

  /** Imports files into the library and inserts them: floppies into FDD 1, 2, hard disks into HDD 1. */
  async importFiles(files: File[], opts: { insert: boolean }): Promise<DiskRecord[]> {
    const added: DiskRecord[] = [];
    for (const f of files) added.push(await this.storage.addDisk(f.name, new Uint8Array(await f.arrayBuffer())));
    if (opts.insert) {
      const fdds = added.filter((d) => d.kind === 'fdd').slice(0, 2);
      const hdd = added.find((d) => d.kind === 'hdd');
      for (const [i, d] of fdds.entries()) await this.insert(i === 0 ? 'fdd0' : 'fdd1', d.id, { reset: false });
      if (hdd) await this.insert('hdd0', hdd.id, { reset: false });
    }
    this.emit();
    return added;
  }

  private async saveMounted(): Promise<void> {
    await this.storage.patchSettings({ lastDisks: Object.fromEntries(this.mounted) });
  }

  // ---- write-back

  private markDirty(fsName: string): void {
    this.dirty.add(fsName);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), WRITE_BACK_DELAY_MS);
  }

  /** Persists every image the guest has written to since the last flush. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.dirty.size || !this.pc) return;
    const names = [...this.dirty];
    this.dirty.clear();
    for (const name of names) {
      const id = name.replace(/\.[^.]+$/, '');
      if (![...this.mounted.values()].includes(id)) continue;
      await this.storage.writeSaves(id, this.pc.readDisk(name));
    }
    this.emit();
  }

  // ---- states

  async saveState(name: string, thumbnail?: Blob, id?: string): Promise<StateRecord> {
    await this.flush();
    const rec = await this.storage.saveState(
      { id, name, disks: Object.fromEntries(this.mounted), config: this.pc.config, thumbnail },
      this.pc.saveState(),
    );
    this.emit();
    return rec;
  }

  /** Loads a state, first re-inserting the disks it was saved with. */
  async loadState(id: string): Promise<{ diskChanged: boolean }> {
    await this.flush();
    const rec = (await this.storage.listStates()).find((s) => s.id === id);
    if (!rec) throw new Error('That state no longer exists');
    if (rec.config.cpu !== this.pc.config.cpu) await this.boot({ ...this.pc.config, ...rec.config });
    for (const [slot, diskId] of Object.entries(rec.disks) as [SlotId, string][]) {
      if (this.mounted.get(slot) !== diskId) await this.insert(slot, diskId, { reset: false });
    }
    const result = this.pc.loadState(await this.storage.readState(id));
    this.emit();
    return result;
  }
}
