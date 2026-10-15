#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { BrowserBridge, DEFAULT_ALLOWED_ORIGINS } from './bridge.js';
import { Session } from './session.js';

const HELP = `pc98-mcp: MCP server for a PC-9801 emulator (stdio transport)

Usage: pc98-mcp [options]

  --home <dir>        Data directory (disks/, saves/, states/, rom/, recordings/). Default ~/.pc98
  --disks <dir>       Extra read-only folder of disk images (repeatable)
  --fdd1 <name>       Insert this library image into floppy drive 1 at start
  --fdd2 <name>       ... floppy drive 2
  --hdd1 <name>       ... hard disk 1
  --load-state <name> Restore this save state at start
  --cpu <i386|i286>   Default i386
  --epoch <iso>       Fixed emulated clock at power-on (reproducible runs)

Browser attach (the pair_browser tool; nothing listens until it is called):
  --attach-port <n>   127.0.0.1 port for the tab bridge. Default 8098 (0 = any)
  --app-url <url>     Web app the pairing link opens. Default https://pc98.crafter.games/
  --app-dir <dir>     Built web app to also serve on the bridge port (a same-origin
                      fallback without local-network prompts). Default: the
                      monorepo's packages/web/dist when it exists
  --allow-origin <o>  Extra origin allowed to attach (repeatable). Always allowed:
                      ${DEFAULT_ALLOWED_ORIGINS.join(', ')}
  --no-attach         Disable browser attach entirely
  -h, --help
`;

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    disks: { type: 'string', multiple: true },
    fdd1: { type: 'string' },
    fdd2: { type: 'string' },
    hdd1: { type: 'string' },
    'load-state': { type: 'string' },
    cpu: { type: 'string' },
    epoch: { type: 'string' },
    'attach-port': { type: 'string' },
    'app-url': { type: 'string' },
    'app-dir': { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    'no-attach': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const cpu = values.cpu === 'i286' ? 'i286' : 'i386';
const epochMs = values.epoch ? Date.parse(`${values.epoch.replace(/Z$/, '')}Z`) : undefined;
const session = await Session.create({ home: values.home, diskDirs: values.disks, config: { cpu }, epochMs });
for (const drive of ['fdd1', 'fdd2', 'hdd1'] as const) {
  const name = values[drive];
  if (name) session.insertDisk(drive, name);
}
session.machine.reset();
if (values['load-state']) session.loadState(values['load-state']);

const bundledApp = fileURLToPath(new URL('../../web/dist', import.meta.url));
const appDir = values['app-dir'] ?? (existsSync(`${bundledApp}/index.html`) ? bundledApp : undefined);
const bridge = values['no-attach'] ? undefined : new BrowserBridge({
  port: values['attach-port'] !== undefined ? Number(values['attach-port']) : 8098,
  appUrl: values['app-url'],
  appDir,
  allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...(values['allow-origin'] ?? [])],
});
const server = createServer(session, bridge);
if (bridge) {
  bridge.onChange = () => {
    process.stderr.write(bridge.attached ? 'pc98-mcp: browser tab attached\n' : 'pc98-mcp: browser tab detached\n');
  };
}
await server.connect(new StdioServerTransport());
process.stderr.write(`pc98-mcp ready (data: ${session.home})\n`);

const shutdown = () => {
  session.flush();
  void bridge?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
