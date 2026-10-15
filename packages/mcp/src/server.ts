import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RunResult } from '@pc98-web/core';
import { encodePng } from './png.js';
import { encodeWav } from './wav.js';
import type { Session } from './session.js';
import type { Backend, DriveId, InputOp } from './backends/types.js';
import { LocalBackend } from './backends/local.js';
import type { BrowserBridge } from './bridge.js';

const INSTRUCTIONS = `You control an emulated NEC PC-9801 (Japanese 1980s-90s personal computer) running at 640x400.
By default the machine is headless and only advances when you call a tool: time is frozen between calls, so take as long as you need to think.

How to work:
- See the screen with \`screenshot\`. Many games, especially visual novels, draw text as graphics, so text only shows up in screenshots.
- \`read_text\` returns the text-mode screen (DOS prompts, menus, some games' prompts like "insert disk C") as Unicode. It is cheap: try it before a screenshot.
- Input tools (\`press_key\`, \`type_text\`, \`mouse\`) deliver the input and then let a little time pass (\`wait_seconds\`).
- \`run\` lets time pass: a fixed time, or until some text appears (\`until_text\`) or the picture stops changing (\`until_stable_seconds\`).
- Disks: \`list_disks\` shows the local library; \`insert_disk\` mounts one. Multi-disk games ask for disks by letter (A, B, C...) in the text layer; insert the matching image into the drive they read from (usually fdd2) and confirm with RETURN. The guest's writes (game saves) are kept in a save overlay, never written to the original image.
- Save states (\`save_state\` / \`load_state\`) snapshot the whole machine. Save one before risky choices.
- \`pair_browser\` gives the user a link that attaches their browser tab: tools then act on the game they are watching, in real time, until \`detach_browser\`.
Visual novels on PC-98 usually advance with RETURN or SPACE, use the arrow keys or the numeric keypad to move between choices, and ESC or the right mouse button for menus.`;

const DRIVE = z.enum(['fdd1', 'fdd2', 'hdd1', 'hdd2']);

type Content = CallToolResult['content'];

function text(s: string): Content[number] {
  return { type: 'text', text: s };
}

const OUTCOMES: Record<RunResult['outcome'], string> = {
  ran: 'ran for the full time',
  'text-matched': 'the text matched',
  stable: 'the screen is stable',
  timeout: 'timed out before the condition was met',
  'powered-off': 'the machine powered off',
};

export function createServer(session: Session, bridge?: BrowserBridge): McpServer {
  const server = new McpServer({ name: 'pc98', version: '0.2.0' }, { instructions: INSTRUCTIONS });
  const local = new LocalBackend(session);
  const current = (): Backend => bridge?.backend ?? local;

  const screenshotContent = async (b: Backend, crt = false): Promise<Content[number]> => {
    const { width, height, rgba } = await b.screenshot();
    return { type: 'image', mimeType: 'image/png', data: encodePng(width, height, rgba, crt ? 1.2 : 1).toString('base64') };
  };

  const when = async (b: Backend) => {
    const c = await b.clock();
    return `t=${c.seconds.toFixed(2)}s`;
  };

  /** Wraps a tool: flushes disk writes afterwards and turns errors into tool errors. */
  const tool = <A>(fn: (args: A, b: Backend) => Promise<Content>) => async (args: A): Promise<CallToolResult> => {
    const b = current();
    try {
      const content = await fn(args, b);
      const saved = await b.flush();
      if (saved.length) content.push(text(`(saved guest writes to: ${saved.join(', ')})`));
      if (!(await b.clock()).powered) content.push(text('The machine is powered off. Call `reset` or `power_on` to start it again.'));
      return { content };
    } catch (e) {
      return { content: [text(e instanceof Error ? e.message : String(e))], isError: true };
    }
  };

  const afterInput = async (b: Backend, args: { wait_seconds?: number; screenshot?: boolean }, op: InputOp): Promise<Content> => {
    await b.input(op, args.wait_seconds ?? 0.5);
    const out: Content = [text(await when(b))];
    const screen = await b.readText();
    if (screen.trim()) out.push(text(`Text screen:\n${screen}`));
    if (args.screenshot) out.push(await screenshotContent(b));
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
  }, tool(async ({ crt }, b) => [await screenshotContent(b, crt), text(await when(b))]));

  server.registerTool('read_text', {
    title: 'Read text screen',
    description: 'Returns the text-mode layer (80x25, Japanese included) as Unicode lines. Graphics-mode text (most visual novel dialogue) is not included: use screenshot for that. Does not advance time.',
    inputSchema: {},
  }, tool(async (_a, b) => {
    const screen = await b.readText();
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
  }, tool((a, b) => afterInput(b, a, { type: 'key', key: a.key, opts: { shift: a.shift, ctrl: a.ctrl, grph: a.grph, times: a.times } })));

  server.registerTool('type_text', {
    title: 'Type text',
    description: 'Types ASCII text on the PC-98 JIS keyboard layout. "\\n" presses RETURN. Use for DOS commands and names; use press_key for special keys.',
    inputSchema: { text: z.string().max(2000), ...inputOpts },
  }, tool((a, b) => afterInput(b, a, { type: 'text', text: a.text })));

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
  }, tool((a, b) => afterInput(b, a, { type: 'mouse', opts: { dx: a.dx, dy: a.dy, button: a.button, action: a.action } })));

  server.registerTool('run', {
    title: 'Let time pass',
    description: 'Runs the machine. Without conditions it runs `seconds`. With until_text it stops as soon as the text screen matches; with until_stable_seconds it stops once the picture has not changed for that long. Headless it runs much faster than real time.',
    inputSchema: {
      seconds: z.number().min(0).max(600).optional().describe('Emulated seconds to run when no condition is given, or the timeout when one is. Default 1 (or 60 with a condition).'),
      until_text: z.string().optional().describe('JavaScript regular expression tested against the text screen.'),
      until_stable_seconds: z.number().min(0.1).max(30).optional().describe('Stop when the screen has not changed for this long.'),
      screenshot: z.boolean().optional().describe('Return a screenshot at the end. Default true.'),
    },
  }, tool(async (a, b) => {
    if (a.until_text !== undefined) new RegExp(a.until_text); // report bad patterns before running
    const r = await b.run({ seconds: a.seconds, untilText: a.until_text, untilStableSeconds: a.until_stable_seconds });
    const out: Content = [text(`${OUTCOMES[r.outcome]} after ${r.seconds.toFixed(2)}s (${await when(b)})`)];
    if (a.screenshot ?? true) out.push(await screenshotContent(b));
    return out;
  }));

  server.registerTool('list_disks', {
    title: 'List disk images',
    description: 'Lists disk images in the library (FDD: .fdi .d88 .hdm .xdf .nfd; HDD: .hdi .nhd .thd) and which drives they are in. When a browser tab is attached, this is the tab\'s own library.',
    inputSchema: {},
  }, tool(async (_a, b) => {
    const disks = await b.listDisks();
    const lines = disks.map((d) => `${d.name}  [${d.kind}, ${(d.bytes / 1024).toFixed(0)} KB${d.hasSaves ? ', has saves' : ''}${d.drives.length ? `, in ${d.drives.join(',')}` : ''}]`);
    const empty = b.kind === 'headless' ? `No disk images. Add some to ${session.diskDirs[0]}` : 'The tab\'s library is empty: ask the user to drop disk images on the page.';
    return [text(lines.length ? lines.join('\n') : empty)];
  }));

  server.registerTool('insert_disk', {
    title: 'Insert disk',
    description: 'Inserts a library image (name from list_disks) into a drive. Floppies can be swapped while running, which multi-disk games ask for; 0.5 s then passes so the drive notices the new disk before you confirm in the game. Hard disks take effect after a reset, which this tool performs.',
    inputSchema: { drive: DRIVE, name: z.string().describe('Image name exactly as list_disks shows it.') },
  }, tool(async (a, b) => {
    const entry = await b.insertDisk(a.drive as DriveId, a.name);
    return [text(`${entry.name} is in ${a.drive}${entry.hasSaves ? ' (with its saved writes)' : ''}${entry.kind === 'hdd' ? '; the machine was reset' : ''}.`)];
  }));

  server.registerTool('eject_disk', {
    title: 'Eject disk',
    description: 'Removes the image from a drive.',
    inputSchema: { drive: DRIVE },
  }, tool(async (a, b) => {
    await b.ejectDisk(a.drive as DriveId);
    return [text(`${a.drive} is empty.`)];
  }));

  server.registerTool('discard_disk_saves', {
    title: 'Discard disk saves',
    description: 'Deletes what the guest has written to an image (its save overlay) so it starts pristine the next time it is inserted. Destroys in-game saves on that disk.',
    inputSchema: { name: z.string() },
  }, tool(async (a, b) => [text((await b.discardSaves(a.name)) ? `Discarded saves of ${a.name}.` : `${a.name} had no saves.`)]));

  server.registerTool('reset', {
    title: 'Reset',
    description: 'Presses the reset button (warm reboot with the same disks).',
    inputSchema: {},
  }, tool(async (_a, b) => {
    await b.reset();
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
  }, tool(async (a, b) => {
    const epochMs = a.epoch ? Date.parse(`${a.epoch.replace(/Z$/, '')}Z`) : undefined;
    if (a.epoch && Number.isNaN(epochMs)) throw new Error(`Bad epoch "${a.epoch}"`);
    const config = await b.powerOn({
      ...(a.cpu && { cpu: a.cpu }),
      ...(a.clock_multiple && { clockMultiple: a.clock_multiple }),
      ...(a.ext_memory_mb !== undefined && { extMemoryMB: a.ext_memory_mb }),
      ...(a.sound_board && { soundBoard: a.sound_board }),
    }, epochMs);
    return [text(`Powered on: ${JSON.stringify(config)}`)];
  }));

  server.registerTool('save_state', {
    title: 'Save state',
    description: 'Snapshots the whole machine (CPU, memory, devices) under a name, overwriting a state with the same name. Remembers which disks were inserted.',
    inputSchema: { name: z.string().describe('Letters, digits, space, dot, dash, underscore.') },
  }, tool(async (a, b) => [text(`State "${a.name}" ${await b.saveState(a.name)}`)]));

  server.registerTool('load_state', {
    title: 'Load state',
    description: 'Restores a named save state, re-inserting the disks it was saved with.',
    inputSchema: { name: z.string() },
  }, tool(async (a, b) => {
    await b.loadState(a.name);
    return [text(`Loaded "${a.name}" (${await when(b)}).`), await screenshotContent(b)];
  }));

  server.registerTool('list_states', {
    title: 'List save states',
    description: 'Lists named save states, newest first.',
    inputSchema: {},
  }, tool(async (_a, b) => {
    const states = await b.listStates();
    return [text(states.length ? states.map((s) => `${s.name}  (${s.savedAt}; ${Object.entries(s.disks).map(([d, n]) => `${d}=${n}`).join(' ') || 'no disks'})`).join('\n') : 'No save states yet.')];
  }));

  server.registerTool('status', {
    title: 'Machine status',
    description: 'Whether tools act on the headless machine or an attached browser tab, hardware settings, emulated time, mounted disks and ROMs in use.',
    inputSchema: {},
  }, tool(async (_a, b) => [text(JSON.stringify(await b.status(), null, 2))]));

  const parseAddress = (a: number | string) => (typeof a === 'string' ? parseInt(a, 16) : a);

  server.registerTool('read_memory', {
    title: 'Read memory',
    description: 'Hex dump of guest physical memory within the first 2 MB (A0000h text VRAM, A8000h-BFFFFh and E0000h graphics planes, etc.). For debugging and game-state inspection.',
    inputSchema: {
      address: z.union([z.number().int(), z.string()]).describe('Number or hex string like "0xA0000".'),
      length: z.number().int().min(1).max(4096),
    },
  }, tool(async (a, b) => {
    const addr = parseAddress(a.address);
    const bytes = await b.readMemory(addr, a.length);
    const lines: string[] = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = bytes.subarray(i, i + 16);
      const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...row].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
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
  }, tool(async (a, b) => {
    const addr = parseAddress(a.address);
    const clean = a.hex.replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2) throw new Error('Odd number of hex digits');
    const bytes = Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
    await b.writeMemory(addr, bytes);
    return [text(`Wrote ${bytes.length} bytes at ${addr.toString(16)}h.`)];
  }));

  server.registerTool('record_audio', {
    title: 'Record audio',
    description: 'Runs the headless machine for `seconds` while recording its sound to a WAV file in the recordings folder. Returns the file path.',
    inputSchema: {
      seconds: z.number().min(0.1).max(300),
      name: z.string().describe('File name without extension.'),
    },
  }, tool(async (a, b) => {
    const path = session.recordingPath(a.name);
    const { pcm, sampleRate } = await b.recordAudio(a.seconds);
    writeFileSync(path, encodeWav(pcm, sampleRate));
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    return [text(`Recorded ${(pcm.length / 2 / sampleRate).toFixed(2)}s to ${path} (peak ${(20 * Math.log10(Math.max(peak, 1) / 32768)).toFixed(1)} dBFS${peak === 0 ? ', silent' : ''}).`)];
  }));

  if (bridge) {
    server.registerTool('pair_browser', {
      title: 'Attach a browser tab',
      description: 'Returns a one-time link (valid 10 minutes) for the user to open. The tab running PC-98 Web then attaches to this server, and every tool acts on the game they are watching, in real time, with their own disk library and states. Give the user the link and wait for them to open it; `status` shows when it is attached.',
      inputSchema: {},
    }, async () => {
      const p = await bridge.pair();
      return { content: [text(`Ask the user to open this link in the browser where they play (it reuses their library and states there):\n${p.url}\n\nOr, in an open PC-98 Web tab, click "Conectar agente" and paste:\n${p.wsUrl}\n\nThe link works once and expires in ${p.expiresInMinutes} minutes. Only this computer can connect (127.0.0.1).`)] };
    });

    server.registerTool('detach_browser', {
      title: 'Detach the browser tab',
      description: 'Disconnects the attached tab; tools go back to the headless machine.',
      inputSchema: {},
    }, async () => {
      const was = bridge.attached;
      bridge.detach();
      return { content: [text(was ? 'Detached. Tools act on the headless machine again.' : 'No tab was attached.')] };
    });
  }

  return server;
}
