#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
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

const server = createServer(session);
await server.connect(new StdioServerTransport());
process.stderr.write(`pc98-mcp ready (data: ${session.home})\n`);

const shutdown = () => {
  session.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
