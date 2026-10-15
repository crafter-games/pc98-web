import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { PC98, type DriveKind, type MachineConfig } from '@pc98-web/core';

export const FRAME_HZ = 56.42;

const DISK_EXTS = new Set(['.fdi', '.d88', '.88d', '.d98', '.98d', '.hdm', '.xdf', '.dup', '.nfd', '.img', '.ima', '.hdi', '.nhd', '.thd']);
const HDD_EXTS = new Set(['.hdi', '.nhd', '.thd']);
const ROM_FILES = ['bios.rom', 'font.rom', 'sound.rom', 'itf.rom', 'bios9821.rom', 'd8000.rom',
  '2608_bd.wav', '2608_sd.wav', '2608_top.wav', '2608_hh.wav', '2608_tom.wav', '2608_rim.wav'];

export type DriveId = 'fdd1' | 'fdd2' | 'hdd1' | 'hdd2';
export const DRIVES: Record<DriveId, { kind: DriveKind; index: number }> = {
  fdd1: { kind: 'fdd', index: 0 },
  fdd2: { kind: 'fdd', index: 1 },
  hdd1: { kind: 'hdd', index: 0 },
  hdd2: { kind: 'hdd', index: 1 },
};

export interface DiskEntry {
  /** Name agents use to refer to the image. Unique across library roots. */
  name: string;
  path: string;
  bytes: number;
  kind: DriveKind;
  /** True when the guest has written to it before (a saved overlay exists). */
  hasSaves: boolean;
}

export interface SessionOptions {
  /** Data directory. Default ~/.pc98 */
  home?: string;
  /** Extra read-only directories to list disk images from. */
  diskDirs?: string[];
  config?: Partial<MachineConfig>;
  /** Fixed emulated clock at power-on for reproducible runs. Default: host clock. */
  epochMs?: number;
}

/**
 * One emulated PC-98 plus its local storage: a read-only disk library,
 * per-image save overlays (the guest's writes), save states and recordings.
 */
export class Session {
  readonly home: string;
  readonly diskDirs: string[];
  private pc!: PC98;
  private config: Partial<MachineConfig>;
  private epochMs?: number;
  private readonly mounted = new Map<DriveId, DiskEntry>();
  private readonly dirty = new Set<string>();

  private constructor(opts: SessionOptions) {
    this.home = resolve(opts.home ?? join(homedir(), '.pc98'));
    this.diskDirs = [join(this.home, 'disks'), ...(opts.diskDirs ?? []).map((d) => resolve(d))];
    this.config = opts.config ?? {};
    this.epochMs = opts.epochMs;
    for (const dir of ['disks', 'saves', 'states', 'rom', 'recordings']) {
      mkdirSync(join(this.home, dir), { recursive: true });
    }
  }

  static async create(opts: SessionOptions = {}): Promise<Session> {
    const s = new Session(opts);
    await s.powerOn();
    return s;
  }

  get machine(): PC98 { return this.pc; }

  /** Boots a fresh machine, keeping (and re-inserting) mounted disks unless replaced. */
  async powerOn(config: Partial<MachineConfig> = {}, epochMs?: number): Promise<void> {
    this.flush();
    this.config = { ...this.config, ...config };
    if (epochMs !== undefined) this.epochMs = epochMs;
    this.pc = await PC98.create({
      config: this.config,
      bios: this.loadRoms(),
      epochMs: this.epochMs,
      onDiskChange: (name) => this.dirty.add(name),
    });
    for (const [drive, entry] of this.mounted) this.mountEntry(drive, entry);
    this.pc.reset();
  }

  private loadRoms(): Record<string, Uint8Array> {
    const roms: Record<string, Uint8Array> = {};
    for (const name of ROM_FILES) {
      const path = join(this.home, 'rom', name);
      if (existsSync(path)) roms[name] = new Uint8Array(readFileSync(path));
    }
    return roms;
  }

  romsPresent(): string[] {
    return ROM_FILES.filter((n) => existsSync(join(this.home, 'rom', n)));
  }

  // ---- disk library

  listDisks(): DiskEntry[] {
    const seen = new Map<string, DiskEntry>();
    const walk = (dir: string, prefix: string, depth: number) => {
      if (!existsSync(dir) || depth > 3) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name);
        if (ent.isDirectory()) { walk(path, `${prefix}${ent.name}/`, depth + 1); continue; }
        const ext = extname(ent.name).toLowerCase();
        if (!DISK_EXTS.has(ext)) continue;
        const name = `${prefix}${ent.name}`;
        if (seen.has(name)) continue;
        seen.set(name, {
          name,
          path,
          bytes: statSync(path).size,
          kind: HDD_EXTS.has(ext) ? 'hdd' : 'fdd',
          hasSaves: existsSync(this.overlayPath(name)),
        });
      }
    };
    for (const dir of this.diskDirs) walk(dir, '', 0);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  findDisk(name: string): DiskEntry {
    const disks = this.listDisks();
    const hit = disks.find((d) => d.name === name) ?? disks.find((d) => basename(d.name) === name);
    if (!hit) {
      throw new Error(`No disk image named "${name}". Available: ${disks.map((d) => d.name).join(', ') || '(none; put images in ' + this.diskDirs[0] + ')'}`);
    }
    return hit;
  }

  private overlayPath(name: string): string {
    return join(this.home, 'saves', name.replace(/[\/\\]/g, '__'));
  }

  private imageName(entry: DiskEntry): string {
    return entry.name.replace(/[\/\\]/g, '__');
  }

  /** Inserts a library image. The guest's writes go to a save overlay, never to the original file. */
  insertDisk(drive: DriveId, name: string): DiskEntry {
    const entry = this.findDisk(name);
    const d = DRIVES[drive];
    if (d.kind !== entry.kind) throw new Error(`${entry.name} is a ${entry.kind.toUpperCase()} image; use ${entry.kind}1 or ${entry.kind}2`);
    this.flush();
    this.mounted.set(drive, entry);
    this.mountEntry(drive, entry);
    return entry;
  }

  private mountEntry(drive: DriveId, entry: DiskEntry): void {
    const overlay = this.overlayPath(entry.name);
    const bytes = readFileSync(existsSync(overlay) ? overlay : entry.path);
    const d = DRIVES[drive];
    this.pc.insertDisk(d.kind, d.index, this.imageName(entry), new Uint8Array(bytes));
  }

  ejectDisk(drive: DriveId): void {
    this.flush();
    const d = DRIVES[drive];
    this.pc.ejectDisk(d.kind, d.index);
    this.mounted.delete(drive);
  }

  /** Deletes the save overlay of an image so it boots pristine next time it is inserted. */
  discardSaves(name: string): boolean {
    const entry = this.findDisk(name);
    const overlay = this.overlayPath(entry.name);
    if (!existsSync(overlay)) return false;
    rmSync(overlay);
    return true;
  }

  mountedDisks(): Partial<Record<DriveId, string>> {
    return Object.fromEntries([...this.mounted].map(([k, v]) => [k, v.name]));
  }

  /** Writes images the guest modified to their save overlays. */
  flush(): string[] {
    if (!this.pc || !this.dirty.size) return [];
    const written: string[] = [];
    for (const entry of this.mounted.values()) {
      const image = this.imageName(entry);
      if (!this.dirty.has(image)) continue;
      writeFileSync(this.overlayPath(entry.name), this.pc.readDisk(image));
      written.push(entry.name);
    }
    this.dirty.clear();
    return written;
  }

  // ---- save states

  private statePath(name: string): string {
    if (!/^[\w.\- ]{1,64}$/.test(name)) throw new Error('State names may use letters, digits, space, dot, dash and underscore (max 64)');
    return join(this.home, 'states', `${name}.np2s`);
  }

  saveState(name: string): string {
    const path = this.statePath(name);
    writeFileSync(path, this.pc.saveState());
    writeFileSync(`${path}.json`, JSON.stringify({ disks: this.mountedDisks(), config: this.config, frames: this.pc.frames, savedAt: new Date().toISOString() }, null, 2));
    return path;
  }

  loadState(name: string): void {
    const path = this.statePath(name);
    if (!existsSync(path)) throw new Error(`No state named "${name}". Available: ${this.listStates().map((s) => s.name).join(', ') || '(none)'}`);
    const metaPath = `${path}.json`;
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { disks: Partial<Record<DriveId, string>> };
      for (const [drive, name] of Object.entries(meta.disks) as [DriveId, string][]) {
        if (this.mounted.get(drive)?.name !== name) this.insertDisk(drive, name);
      }
    }
    this.pc.loadState(new Uint8Array(readFileSync(path)));
  }

  listStates(): { name: string; savedAt: string; disks: Partial<Record<DriveId, string>> }[] {
    const dir = join(this.home, 'states');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.np2s'))
      .map((f) => {
        const name = f.slice(0, -5);
        const metaPath = join(dir, `${f}.json`);
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
        return { name, savedAt: meta.savedAt ?? statSync(join(dir, f)).mtime.toISOString(), disks: meta.disks ?? {} };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  recordingPath(name: string): string {
    if (!/^[\w.\- ]{1,64}$/.test(name)) throw new Error('Recording names may use letters, digits, space, dot, dash and underscore (max 64)');
    return join(this.home, 'recordings', `${name}.wav`);
  }

  status() {
    const pc = this.pc;
    return {
      powered: pc.isPowered,
      frames: pc.frames,
      emulatedSeconds: +(pc.elapsedMs / 1000).toFixed(2),
      config: pc.config,
      disks: this.mountedDisks(),
      roms: this.romsPresent().length ? this.romsPresent() : 'none (built-in BIOS, Shinonome font)',
      home: this.home,
    };
  }
}
