import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { keyCode, type PC98 } from '@pc98-web/core';
import { encodePng } from './png.js';
import { encodeWav } from './wav.js';
import { FRAME_HZ, Session, type DriveId } from './session.js';

const INSTRUCTIONS = `You control an emulated NEC PC-9801 (Japanese 1980s-90s personal computer) running at 640x400.
The machine only advances when you call a tool: time is frozen between calls, so take as long as you need to think.

How to work:
- See the screen with \`screenshot\`. Many games, especially visual novels, draw text as graphics, so text only shows up in screenshots.
- \`read_text\` returns the text-mode screen (DOS prompts, menus, some games) as Unicode. It is cheap: try it before a screenshot.
- Input tools (\`press_key\`, \`type_text\`, \`mouse\`) deliver the input and then let a little time pass (\`wait_seconds\`).
- \`run\` lets time pass: a fixed time, or until some text appears (\`until_text\`) or the picture stops changing (\`until_stable_seconds\`).
- Disks: \`list_disks\` shows the local library; \`insert_disk\` mounts one. The guest's writes (game saves) are kept in a save overlay, never written to the original image.
- Save states (\`save_state\` / \`load_state\`) snapshot the whole machine. Save one before risky choices.
Visual novels on PC-98 usually advance with RETURN or SPACE, use the arrow keys or the numeric keypad to move between choices, and ESC or the right mouse button for menus.`;

const DRIVE = z.enum(['fdd1', 'fdd2', 'hdd1', 'hdd2']);

type Content = CallToolResult['content'];

function text(s: string): Content[number] {
  return { type: 'text', text: s };
}

function screenshotContent(pc: PC98, crt = false): Content[number] {
  const { width, height, rgba } = pc.screen();
  return { type: 'image', mimeType: 'image/png', data: encodePng(width, height, rgba, crt ? 1.2 : 1).toString('base64') };
}

function hashScreen(pc: PC98): number {
  const { rgba } = pc.screen();
  let h = 0x811c9dc5;
  for (let i = 0; i < rgba.length; i += 4) {
    h ^= rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function secondsToFrames(s: number): number {
  return Math.max(1, Math.round(s * FRAME_HZ));
}

/** Delivers queued input, then lets `waitSeconds` of emulated time pass. */
function settle(pc: PC98, waitSeconds: number): void {
  let guard = secondsToFrames(30);
  while (pc.pendingInput > 0 && guard-- > 0 && pc.runFrame(false));
  pc.runFrames(secondsToFrames(waitSeconds));
}

function trimText(screen: string): string {
  return screen.replace(/\n+$/, '');
}

export function createServer(session: Session): McpServer {
  const server = new McpServer({ name: 'pc98', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  /** Wraps a tool: flushes disk writes afterwards and turns errors into tool errors. */
  const tool = <A>(fn: (args: A) => Promise<Content> | Content) => async (args: A): Promise<CallToolResult> => {
    try {
      const content = await fn(args);
      const saved = session.flush();
      if (saved.length) content.push(text(`(saved guest writes to: ${saved.join(', ')})`));
      if (!session.machine.isPowered) content.push(text('The machine is powered off. Call `reset` or `power_on` to start it again.'));
      return { content };
    } catch (e) {
      return { content: [text(e instanceof Error ? e.message : String(e))], isError: true };
    }
  };

  const afterInput = (args: { wait_seconds?: number; screenshot?: boolean }): Content => {
    const pc = session.machine;
    settle(pc, args.wait_seconds ?? 0.5);
    const out: Content = [text(`t=${(pc.elapsedMs / 1000).toFixed(2)}s`)];
    const screen = trimText(pc.textScreen());
    if (screen.trim()) out.push(text(`Text screen:\n${screen}`));
    if (args.screenshot) out.push(screenshotContent(pc));
    return out;
  };

  const inputOpts = {
    wait_seconds: z.number().min(0).max(30).optional().describe('Emulated seconds to let pass after the input is delivered. Default 0.5.'),
    screenshot: z.boolean().optional().describe('Also return a screenshot afterwards. Default false.'),
  };

  server.registerTool('screenshot', {
    title: 'Screenshot',
    description: 'Returns the current screen as a PNG (640x400, or 640x480 with crt=true to match the 4:3 monitor). Does not advance time.',
    inputSchema: { crt: z.boolean().optional().describe('Stretch to 4:3 like a real monitor. Default false.') },
  }, tool(({ crt }) => [screenshotContent(session.machine, crt), text(`t=${(session.machine.elapsedMs / 1000).toFixed(2)}s, frame ${session.machine.frames}`)]));

  server.registerTool('read_text', {
    title: 'Read text screen',
    description: 'Returns the text-mode layer (80x25, Japanese included) as Unicode lines. Graphics-mode text (most visual novel dialogue) is not included: use screenshot for that. Does not advance time.',
    inputSchema: {},
  }, tool(() => {
    const screen = trimText(session.machine.textScreen());
    return [text(screen.trim() ? screen : '(the text layer is empty: the screen content is graphics, use screenshot)')];
  }));

  server.registerTool('press_key', {
    title: 'Press a key',
    description: 'Presses and releases one PC-98 key, optionally with SHIFT/CTRL/GRPH held. Key names: RETURN, SPACE, ESC, BS, TAB, UP, DOWN, LEFT, RIGHT, F1-F10, VF1-VF5, ROLLUP, ROLLDOWN, INS, DEL, HOME (CLR), HELP, STOP, COPY, XFER, NFER, KANA, CAPS, NUM0-NUM9, letters A-Z, digits 0-9.',
    inputSchema: {
      key: z.string().describe('Key name, e.g. "RETURN", "SPACE", "DOWN", "F1", "Y".'),
      shift: z.boolean().optional(),
      ctrl: z.boolean().optional(),
      grph: z.boolean().optional().describe('GRPH is the PC-98 Alt key.'),
      times: z.number().int().min(1).max(50).optional().describe('Press it this many times. Default 1.'),
      ...inputOpts,
    },
  }, tool((a) => {
    const code = keyCode(a.key);
    if (code === undefined) throw new Error(`Unknown key "${a.key}". See the tool description for key names.`);
    for (let i = 0; i < (a.times ?? 1); i++) session.machine.pressKey(code, { shift: a.shift, ctrl: a.ctrl, grph: a.grph });
    return afterInput(a);
  }));

  server.registerTool('type_text', {
    title: 'Type text',
    description: 'Types ASCII text on the PC-98 JIS keyboard layout. "\\n" presses RETURN. Use for DOS commands and names; use press_key for special keys.',
    inputSchema: { text: z.string().max(2000), ...inputOpts },
  }, tool((a) => {
    session.machine.typeText(a.text);
    return afterInput(a);
  }));

  server.registerTool('mouse', {
    title: 'Mouse',
    description: 'Moves the PC-98 bus mouse by a relative amount (in mickeys, roughly pixels) and/or clicks. The guest decides where its cursor is, so move, take a screenshot, and adjust.',
    inputSchema: {
      dx: z.number().int().min(-640).max(640).optional(),
      dy: z.number().int().min(-400).max(400).optional(),
      button: z.enum(['left', 'right']).optional(),
      action: z.enum(['move', 'click', 'down', 'up']).optional().describe('Default: click if button is given, otherwise move.'),
      ...inputOpts,
    },
  }, tool((a) => {
    const pc = session.machine;
    const action = a.action ?? (a.button ? 'click' : 'move');
    // Spread the motion over a few frames: games poll the mouse once per frame.
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const dx = Math.trunc(((a.dx ?? 0) * (i + 1)) / steps) - Math.trunc(((a.dx ?? 0) * i) / steps);
      const dy = Math.trunc(((a.dy ?? 0) * (i + 1)) / steps) - Math.trunc(((a.dy ?? 0) * i) / steps);
      pc.schedule(i, () => pc.mouseMove(dx, dy));
    }
    const left = a.button === 'left';
    const right = a.button === 'right';
    if (action === 'click') {
      pc.schedule(steps + 1, () => pc.mouseButtons(left, right));
      pc.schedule(steps + 5, () => pc.mouseButtons(false, false));
    } else if (action === 'down') {
      pc.schedule(steps + 1, () => pc.mouseButtons(left, right));
    } else if (action === 'up') {
      pc.schedule(steps + 1, () => pc.mouseButtons(false, false));
    }
    pc.schedule(steps + 7, () => {});
    return afterInput(a);
  }));

  server.registerTool('run', {
    title: 'Let time pass',
    description: 'Runs the machine. Without conditions it runs `seconds`. With until_text it stops as soon as the text screen matches; with until_stable_seconds it stops once the picture has not changed for that long. Runs much faster than real time.',
    inputSchema: {
      seconds: z.number().min(0).max(600).optional().describe('Emulated seconds to run when no condition is given, or the timeout when one is. Default 1 (or 60 with a condition).'),
      until_text: z.string().optional().describe('JavaScript regular expression tested against the text screen.'),
      until_stable_seconds: z.number().min(0.1).max(30).optional().describe('Stop when the screen has not changed for this long.'),
      screenshot: z.boolean().optional().describe('Return a screenshot at the end. Default true.'),
    },
  }, tool((a) => {
    const pc = session.machine;
    const conditional = a.until_text !== undefined || a.until_stable_seconds !== undefined;
    const maxFrames = secondsToFrames(a.seconds ?? (conditional ? 60 : 1));
    const re = a.until_text !== undefined ? new RegExp(a.until_text, 'm') : undefined;
    const stableFrames = a.until_stable_seconds !== undefined ? secondsToFrames(a.until_stable_seconds) : 0;
    const start = pc.elapsedMs;
    let outcome = 'ran for the full time';
    let lastHash = -1;
    let sameFor = 0;
    for (let i = 0; i < maxFrames; i++) {
      if (!pc.runFrame(true)) { outcome = 'machine powered off'; break; }
      if (re && re.test(pc.textScreen())) { outcome = `text matched ${re}`; break; }
      if (stableFrames && i % 4 === 3) {
        const h = hashScreen(pc);
        sameFor = h === lastHash ? sameFor + 4 : 0;
        lastHash = h;
        if (sameFor >= stableFrames) { outcome = 'screen is stable'; break; }
      }
      if (conditional && i === maxFrames - 1) outcome = 'timed out before the condition was met';
    }
    const out: Content = [text(`${outcome} after ${((pc.elapsedMs - start) / 1000).toFixed(2)}s (t=${(pc.elapsedMs / 1000).toFixed(2)}s)`)];
    if (a.screenshot ?? true) out.push(screenshotContent(pc));
    return out;
  }));

  server.registerTool('list_disks', {
    title: 'List disk images',
    description: 'Lists disk images in the local library (FDD: .fdi .d88 .hdm .xdf .nfd; HDD: .hdi .nhd .thd) and which drives they are in.',
    inputSchema: {},
  }, tool(() => {
    const disks = session.listDisks();
    const mounted = session.mountedDisks();
    const where = (name: string) => Object.entries(mounted).filter(([, n]) => n === name).map(([d]) => d).join(',');
    const lines = disks.map((d) => `${d.name}  [${d.kind}, ${(d.bytes / 1024).toFixed(0)} KB${d.hasSaves ? ', has saves' : ''}${where(d.name) ? `, in ${where(d.name)}` : ''}]`);
    return [text(lines.length ? lines.join('\n') : `No disk images. Add some to ${session.diskDirs[0]}`)];
  }));

  server.registerTool('insert_disk', {
    title: 'Insert disk',
    description: 'Inserts a library image (name from list_disks) into a drive. Floppies can be swapped while running, which multi-disk games ask for; 0.5 s then passes so the drive notices the new disk before you confirm in the game. Hard disks take effect after a reset, which this tool performs.',
    inputSchema: { drive: DRIVE, name: z.string().describe('Image name exactly as list_disks shows it.') },
  }, tool((a) => {
    const entry = session.insertDisk(a.drive as DriveId, a.name);
    if (entry.kind === 'hdd') session.machine.reset();
    else session.machine.runFrames(secondsToFrames(0.5));
    return [text(`${entry.name} is in ${a.drive}${entry.hasSaves ? ' (with its saved writes)' : ''}${entry.kind === 'hdd' ? '; the machine was reset' : ''}.`)];
  }));

  server.registerTool('eject_disk', {
    title: 'Eject disk',
    description: 'Removes the image from a drive.',
    inputSchema: { drive: DRIVE },
  }, tool((a) => {
    session.ejectDisk(a.drive as DriveId);
    return [text(`${a.drive} is empty.`)];
  }));

  server.registerTool('discard_disk_saves', {
    title: 'Discard disk saves',
    description: "Deletes what the guest has written to an image (its save overlay) so it starts pristine the next time it is inserted. Destroys in-game saves on that disk.",
    inputSchema: { name: z.string() },
  }, tool((a) => [text(session.discardSaves(a.name) ? `Discarded saves of ${a.name}.` : `${a.name} had no saves.`)]));

  server.registerTool('reset', {
    title: 'Reset',
    description: 'Presses the reset button (warm reboot with the same disks).',
    inputSchema: {},
  }, tool(() => {
    session.machine.reset();
    return [text('Reset.')];
  }));

  server.registerTool('power_on', {
    title: 'Power on with settings',
    description: 'Builds a fresh machine with new hardware settings and boots it with the disks currently inserted. Use only to change hardware; use reset to reboot.',
    inputSchema: {
      cpu: z.enum(['i386', 'i286']).optional(),
      clock_multiple: z.number().int().min(1).max(32).optional().describe('CPU MHz = 2.4576 * this. Default 8 (~20 MHz).'),
      ext_memory_mb: z.number().int().min(0).max(13).optional(),
      sound_board: z.enum(['none', '14', '26k', '86', '26k+86', '86+chibi', '118', 'spb']).optional().describe('Default 86 (PC-9801-86, YM2608).'),
      epoch: z.string().optional().describe('ISO date-time for the emulated clock at power-on, e.g. "1996-01-26T12:00:00".'),
    },
  }, tool(async (a) => {
    const epochMs = a.epoch ? Date.parse(`${a.epoch.replace(/Z$/, '')}Z`) : undefined;
    if (a.epoch && Number.isNaN(epochMs)) throw new Error(`Bad epoch "${a.epoch}"`);
    await session.powerOn({
      ...(a.cpu && { cpu: a.cpu }),
      ...(a.clock_multiple && { clockMultiple: a.clock_multiple }),
      ...(a.ext_memory_mb !== undefined && { extMemoryMB: a.ext_memory_mb }),
      ...(a.sound_board && { soundBoard: a.sound_board }),
    }, epochMs);
    return [text(`Powered on: ${JSON.stringify(session.status().config)}`)];
  }));

  server.registerTool('save_state', {
    title: 'Save state',
    description: 'Snapshots the whole machine (CPU, memory, devices, disk contents in use) under a name, overwriting a state with the same name.',
    inputSchema: { name: z.string().describe('Letters, digits, space, dot, dash, underscore.') },
  }, tool((a) => [text(`Saved state "${a.name}" to ${session.saveState(a.name)}`)]));

  server.registerTool('load_state', {
    title: 'Load state',
    description: 'Restores a named save state, re-inserting the disks it was saved with.',
    inputSchema: { name: z.string() },
  }, tool((a) => {
    session.loadState(a.name);
    session.machine.runFrames(1);
    return [text(`Loaded "${a.name}" (t=${(session.machine.elapsedMs / 1000).toFixed(2)}s).`), screenshotContent(session.machine)];
  }));

  server.registerTool('list_states', {
    title: 'List save states',
    description: 'Lists named save states, newest first.',
    inputSchema: {},
  }, tool(() => {
    const states = session.listStates();
    return [text(states.length ? states.map((s) => `${s.name}  (${s.savedAt}; ${Object.entries(s.disks).map(([d, n]) => `${d}=${n}`).join(' ') || 'no disks'})`).join('\n') : 'No save states yet.')];
  }));

  server.registerTool('status', {
    title: 'Machine status',
    description: 'Hardware settings, emulated time, mounted disks and ROMs in use.',
    inputSchema: {},
  }, tool(() => [text(JSON.stringify(session.status(), null, 2))]));

  server.registerTool('read_memory', {
    title: 'Read memory',
    description: 'Hex dump of guest physical memory within the first 2 MB (A0000h text VRAM, A8000h-BFFFFh and E0000h graphics planes, etc.). For debugging and game-state inspection.',
    inputSchema: {
      address: z.union([z.number().int(), z.string()]).describe('Number or hex string like "0xA0000".'),
      length: z.number().int().min(1).max(4096),
    },
  }, tool((a) => {
    const addr = typeof a.address === 'string' ? parseInt(a.address, 16) : a.address;
    const bytes = session.machine.readMemory(addr, a.length);
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = bytes.subarray(i, i + 16);
      const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${(addr + i).toString(16).padStart(5, '0')}: ${hex.padEnd(47)}  ${ascii}`);
    }
    return [text(lines.join('\n'))];
  }));

  server.registerTool('write_memory', {
    title: 'Write memory',
    description: 'Writes bytes to guest physical memory within the first 2 MB. Can crash the guest; save a state first.',
    inputSchema: {
      address: z.union([z.number().int(), z.string()]),
      hex: z.string().describe('Bytes as hex, e.g. "90 90" or "9090".'),
    },
  }, tool((a) => {
    const addr = typeof a.address === 'string' ? parseInt(a.address, 16) : a.address;
    const clean = a.hex.replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2) throw new Error('Odd number of hex digits');
    const bytes = Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
    session.machine.writeMemory(addr, bytes);
    return [text(`Wrote ${bytes.length} bytes at ${addr.toString(16)}h.`)];
  }));

  server.registerTool('record_audio', {
    title: 'Record audio',
    description: 'Runs the machine for `seconds` while recording its sound to a WAV file in the recordings folder. Returns the file path.',
    inputSchema: {
      seconds: z.number().min(0.1).max(300),
      name: z.string().describe('File name without extension.'),
    },
  }, tool((a) => {
    const pc = session.machine;
    const chunks: Int16Array[] = [];
    let total = 0;
    pc.drainAudio();
    const frames = secondsToFrames(a.seconds);
    for (let i = 0; i < frames; i++) {
      if (!pc.runFrame(i === frames - 1)) break;
      const pcm = pc.drainAudio();
      chunks.push(pcm);
      total += pcm.length;
    }
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    const path = session.recordingPath(a.name);
    writeFileSync(path, encodeWav(pcm, pc.sampleRate));
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    return [text(`Recorded ${(total / 2 / pc.sampleRate).toFixed(2)}s to ${path} (peak ${(20 * Math.log10(Math.max(peak, 1) / 32768)).toFixed(1)} dBFS${peak === 0 ? ', silent' : ''}).`)];
  }));

  return server;
}
