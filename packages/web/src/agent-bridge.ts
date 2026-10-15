import { AgentOps, type MachineConfig } from '@pc98-web/core';
import type { Machine, SlotId } from './machine';
import type { Runner } from './runner';

type DriveId = 'fdd1' | 'fdd2' | 'hdd1' | 'hdd2';
const SLOT_OF: Partial<Record<DriveId, SlotId>> = { fdd1: 'fdd0', fdd2: 'fdd1', hdd1: 'hdd0' };
const DRIVE_OF: Record<SlotId, DriveId> = { fdd0: 'fdd1', fdd1: 'fdd2', hdd0: 'hdd1' };

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type BridgeState = 'connecting' | 'attached' | 'closed';

/** Parses what pc98-mcp hands out: ws://127.0.0.1:PORT/TOKEN */
export function parsePairing(input: string): { url: string; token: string } {
  const m = /^ws:\/\/(127\.0\.0\.1|localhost):(\d+)\/([A-Za-z0-9_-]{16,})$/.exec(input.trim());
  if (!m) throw new Error('Pega el enlace ws://127.0.0.1:PUERTO/TOKEN que te dio el agente');
  return { url: `ws://${m[1]}:${m[2]}/`, token: m[3] };
}

/**
 * Serves an MCP agent from this tab: the agent's tools run on the machine the
 * user is watching, in real time, with this browser's library and states.
 */
export class AgentBridge {
  private ws?: WebSocket;
  private readonly ops: AgentOps;
  onState?: (state: BridgeState, detail?: string) => void;
  /** Called with a short description of each agent action, for the UI. */
  onActivity?: (what: string) => void;

  constructor(private readonly machine: Machine, private readonly runner: Runner) {
    this.ops = new AgentOps(() => machine.pc, {
      advance: async (frames) => {
        if (!runner.isRunning) {
          await runner.enableAudio().catch(() => {});
          runner.start();
        }
        return runner.waitFrames(frames);
      },
    });
  }

  connect(pairing: string): void {
    const { url, token } = parsePairing(pairing);
    this.close();
    const ws = new WebSocket(url);
    this.ws = ws;
    this.onState?.('connecting');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, client: 'pc98-web' }));
    ws.onmessage = (e) => void this.onMessage(String(e.data));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.onState?.('closed', e.reason || (e.code === 1006 ? 'no se pudo conectar (¿está pc98-mcp en marcha?)' : undefined));
    };
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000, 'closed by the user');
  }

  private async onMessage(data: string) {
    const msg = JSON.parse(data);
    if (msg.type === 'welcome') {
      this.onState?.('attached');
      return;
    }
    if (typeof msg.id !== 'number') return;
    try {
      this.onActivity?.(msg.method);
      const result = await this.handle(msg.method, msg.params ?? {});
      this.ws?.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      this.ws?.send(JSON.stringify({ id: msg.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  private async diskByName(name: string) {
    const disks = await this.machine.storage.listDisks();
    const d = disks.find((x) => x.name === name);
    if (!d) throw new Error(`No disk image named "${name}" in this browser. Available: ${disks.map((x) => x.name).join(', ') || '(none)'}`);
    return d;
  }

  private async stateByName(name: string) {
    const states = await this.machine.storage.listStates();
    const s = states.find((x) => x.name === name);
    if (!s) throw new Error(`No state named "${name}". Available: ${states.map((x) => x.name).join(', ') || '(none)'}`);
    return s;
  }

  private async handle(method: string, p: any): Promise<unknown> {
    const m = this.machine;
    const pc = m.pc;
    switch (method) {
      case 'clock':
        return { seconds: pc.elapsedMs / 1000, frames: pc.frames, powered: pc.isPowered };
      case 'screenshot': {
        const { width, height, rgba } = pc.screen();
        return { width, height, rgba: b64(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)) };
      }
      case 'readText':
        return this.ops.readText();
      case 'input': {
        const op = p.op;
        if (op.type === 'key') this.ops.pressKey(op.key, op.opts ?? {});
        else if (op.type === 'text') this.ops.typeText(op.text);
        else this.ops.mouse(op.opts ?? {});
        await this.ops.settle(p.waitSeconds ?? 0.5);
        return null;
      }
      case 'run':
        return this.ops.run(p);
      case 'listDisks': {
        const mounted = [...m.mounted].map(([slot, id]) => [DRIVE_OF[slot], id] as const);
        return (await m.storage.listDisks()).map((d) => ({
          name: d.name, kind: d.kind, bytes: d.bytes, hasSaves: d.hasSaves,
          drives: mounted.filter(([, id]) => id === d.id).map(([drive]) => drive),
        }));
      }
      case 'insertDisk': {
        const slot = SLOT_OF[p.drive as DriveId];
        if (!slot) throw new Error(`The web app has no ${p.drive}; use fdd1, fdd2 or hdd1`);
        const d = await this.diskByName(p.name);
        await m.insert(slot, d.id);
        if (d.kind === 'fdd') await this.ops.settle(0.5);
        return { name: d.name, kind: d.kind, hasSaves: d.hasSaves };
      }
      case 'ejectDisk': {
        const slot = SLOT_OF[p.drive as DriveId];
        if (slot) await m.eject(slot);
        return null;
      }
      case 'discardSaves': {
        const d = await this.diskByName(p.name);
        if ([...m.mounted.values()].includes(d.id)) throw new Error(`${d.name} is inserted; eject it first`);
        const had = d.hasSaves;
        await m.storage.discardSaves(d.id);
        m.refresh();
        return had;
      }
      case 'reset':
        pc.reset();
        this.runner.invalidate();
        return null;
      case 'powerOn':
        await m.boot({ ...pc.config, ...(p.config as Partial<MachineConfig>) });
        this.runner.invalidate();
        return m.pc.config;
      case 'saveState': {
        const existing = (await m.storage.listStates()).find((s) => s.name === p.name);
        await m.saveState(p.name, await this.runner.thumbnail(), existing?.id);
        return 'saved in the browser (it appears in the page\'s state list)';
      }
      case 'loadState': {
        const s = await this.stateByName(p.name);
        await m.loadState(s.id);
        this.runner.invalidate();
        return null;
      }
      case 'listStates': {
        const disks = await m.storage.listDisks();
        const nameOf = (id: string) => disks.find((d) => d.id === id)?.name ?? '(deleted disk)';
        return (await m.storage.listStates()).map((s) => ({
          name: s.name,
          savedAt: new Date(s.createdAt).toISOString(),
          disks: Object.fromEntries(Object.entries(s.disks).map(([slot, id]) => [DRIVE_OF[slot as SlotId], nameOf(id)])),
        }));
      }
      case 'status': {
        const disks = await m.storage.listDisks();
        return {
          powered: pc.isPowered,
          running: this.runner.isRunning,
          frames: pc.frames,
          emulatedSeconds: +(pc.elapsedMs / 1000).toFixed(2),
          config: pc.config,
          disks: Object.fromEntries([...m.mounted].map(([slot, id]) => [DRIVE_OF[slot], disks.find((d) => d.id === id)?.name])),
          storage: m.storage.blobs.kind,
        };
      }
      case 'readMemory':
        return b64(pc.readMemory(p.address, p.length));
      case 'writeMemory':
        pc.writeMemory(p.address, unb64(p.bytes));
        return null;
      case 'flush':
        await m.flush();
        return [];
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }
}
