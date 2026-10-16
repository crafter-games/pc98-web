import type { AdvanceOptions, MachineConfig, RunOptions, RunResult } from '@pc98-web/core';
import type { AdvanceResult, Backend, DiskInfo, DriveId, InputOp, ScreenImage, StateInfo } from './types.js';

/** Sends one RPC to the attached page and resolves with its result. */
export type Rpc = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const timeoutFor = (seconds = 0) => (seconds * 1.5 + 30) * 1000;

/** A browser tab running the emulator in real time, driven over the bridge. */
export class RemoteBackend implements Backend {
  readonly kind = 'browser' as const;
  readonly label: string;

  constructor(private readonly rpc: Rpc, origin: string) {
    this.label = `browser tab at ${origin} (real time: the game keeps running between tool calls)`;
  }

  clock() { return this.rpc('clock', {}, 10_000); }

  async screenshot(): Promise<ScreenImage> {
    const r = await this.rpc('screenshot', {}, 10_000);
    return { width: r.width, height: r.height, rgba: unb64(r.rgba) };
  }

  readText(): Promise<string> { return this.rpc('readText', {}, 10_000); }

  async input(op: InputOp, waitSeconds: number) {
    await this.rpc('input', { op, waitSeconds }, timeoutFor(waitSeconds + 30));
  }

  run(opts: RunOptions): Promise<RunResult> {
    return this.rpc('run', opts as Record<string, unknown>, timeoutFor(opts.seconds ?? 60));
  }

  async advance(opts: AdvanceOptions): Promise<AdvanceResult[]> {
    const steps = await this.rpc('advance', opts as Record<string, unknown>, timeoutFor((opts.presses ?? 1) * (opts.maxWaitSeconds ?? 5)));
    return steps.map((st: any) => ({ ...st, screen: { width: st.screen.width, height: st.screen.height, rgba: unb64(st.screen.rgba) } }));
  }

  listDisks(): Promise<DiskInfo[]> { return this.rpc('listDisks', {}, 10_000); }
  insertDisk(drive: DriveId, name: string) { return this.rpc('insertDisk', { drive, name }, 30_000); }
  async ejectDisk(drive: DriveId) { await this.rpc('ejectDisk', { drive }, 10_000); }
  discardSaves(name: string): Promise<boolean> { return this.rpc('discardSaves', { name }, 10_000); }
  async reset() { await this.rpc('reset', {}, 10_000); }
  powerOn(config: Partial<MachineConfig>, epochMs?: number): Promise<MachineConfig> { return this.rpc('powerOn', { config, epochMs }, 60_000); }
  saveState(name: string): Promise<string> { return this.rpc('saveState', { name }, 30_000); }
  async loadState(name: string) { await this.rpc('loadState', { name }, 30_000); }
  listStates(): Promise<StateInfo[]> { return this.rpc('listStates', {}, 10_000); }
  async status() { return { mode: this.label, ...(await this.rpc('status', {}, 10_000)) }; }

  async readMemory(address: number, length: number) {
    return unb64(await this.rpc('readMemory', { address, length }, 10_000));
  }

  async writeMemory(address: number, bytes: Uint8Array) {
    await this.rpc('writeMemory', { address, bytes: b64(bytes) }, 10_000);
  }

  async recordAudio(): Promise<{ pcm: Int16Array; sampleRate: number }> {
    throw new Error('record_audio only works on the headless machine: in the browser the sound goes to the speakers. Call detach_browser first.');
  }

  flush(): Promise<string[]> { return this.rpc('flush', {}, 30_000); }
}
