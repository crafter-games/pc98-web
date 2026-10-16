import { AgentOps, steppedClock, secondsToFrames, type AdvanceOptions, type MachineConfig, type RunOptions } from '@pc98-web/core';
import type { Session } from '../session.js';
import type { Backend, DriveId, InputOp } from './types.js';

/** The server's own machine: stepped, deterministic, faster than real time. */
export class LocalBackend implements Backend {
  readonly kind = 'headless' as const;
  readonly label = 'headless machine (time only passes inside tool calls)';
  private readonly ops: AgentOps;

  constructor(readonly session: Session) {
    this.ops = new AgentOps(() => session.machine, steppedClock(() => session.machine));
  }

  async clock() {
    const pc = this.session.machine;
    return { seconds: pc.elapsedMs / 1000, frames: pc.frames, powered: pc.isPowered };
  }

  async screenshot() {
    const { width, height, rgba } = this.session.machine.screen();
    return { width, height, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
  }

  async readText() { return this.ops.readText(); }

  async input(op: InputOp, waitSeconds: number) {
    if (op.type === 'key') this.ops.pressKey(op.key, op.opts);
    else if (op.type === 'text') this.ops.typeText(op.text);
    else this.ops.mouse(op.opts);
    await this.ops.settle(waitSeconds);
  }

  async run(opts: RunOptions) { return this.ops.run(opts); }

  async advance(opts: AdvanceOptions) {
    return (await this.ops.advance(opts)).map((st) => ({
      seconds: st.seconds,
      settled: st.settled,
      unchanged: st.unchanged,
      text: st.text,
      screen: { width: st.screen.width, height: st.screen.height, rgba: new Uint8Array(st.screen.rgba.buffer, st.screen.rgba.byteOffset, st.screen.rgba.byteLength) },
    }));
  }

  async listDisks() {
    const mounted = this.session.mountedDisks();
    return this.session.listDisks().map((d) => ({
      name: d.name,
      kind: d.kind,
      bytes: d.bytes,
      hasSaves: d.hasSaves,
      drives: (Object.entries(mounted) as [DriveId, string][]).filter(([, n]) => n === d.name).map(([k]) => k),
    }));
  }

  async insertDisk(drive: DriveId, name: string) {
    const entry = this.session.insertDisk(drive, name);
    if (entry.kind === 'hdd') this.session.machine.reset();
    else this.session.machine.runFrames(secondsToFrames(0.5));
    return { name: entry.name, kind: entry.kind, hasSaves: entry.hasSaves };
  }

  async ejectDisk(drive: DriveId) { this.session.ejectDisk(drive); }
  async discardSaves(name: string) { return this.session.discardSaves(name); }
  async reset() { this.session.machine.reset(); }

  async powerOn(config: Partial<MachineConfig>, epochMs?: number) {
    await this.session.powerOn(config, epochMs);
    return this.session.machine.config;
  }

  async saveState(name: string) { return `saved to ${this.session.saveState(name)}`; }

  async loadState(name: string) {
    this.session.loadState(name);
    this.session.machine.runFrames(1);
  }

  async listStates() { return this.session.listStates(); }
  async status() { return { mode: this.label, ...this.session.status() }; }
  async readMemory(address: number, length: number) { return this.session.machine.readMemory(address, length); }
  async writeMemory(address: number, bytes: Uint8Array) { this.session.machine.writeMemory(address, bytes); }

  async recordAudio(seconds: number) {
    return { pcm: await this.ops.recordAudio(seconds), sampleRate: this.session.machine.sampleRate };
  }

  async flush() { return this.session.flush(); }
}
