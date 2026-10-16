#!/usr/bin/env node
// Assembles a self-contained npm package for pc98-mcp in packages/mcp/release:
// the server, the emulator core (JS + WASM + font) and the web app (served
// for same-origin browser attach), with no workspace dependencies.
//   pnpm build && node packages/mcp/scripts/release.mjs && (cd packages/mcp/release && npm pack)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const mcp = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(mcp, '../core');
const web = join(mcp, '../web');
const out = join(mcp, 'release');

for (const required of [join(mcp, 'dist/cli.js'), join(core, 'dist/index.js'), join(core, 'wasm/np21.wasm'), join(web, 'dist/index.html')]) {
  if (!existsSync(required)) throw new Error(`Missing ${relative(mcp, required)}: run \`pnpm build\` first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(mcp, 'dist'), join(out, 'dist'), { recursive: true });
// core/dist/pc98.js loads '../wasm/*', so keep core's dist/wasm layout side by side.
cpSync(join(core, 'dist'), join(out, 'core/dist'), { recursive: true });
cpSync(join(core, 'wasm'), join(out, 'core/wasm'), { recursive: true });
cpSync(join(web, 'dist'), join(out, 'app'), { recursive: true });

// Point the server's imports of the workspace core at the bundled copy.
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk(join(out, 'dist')).filter((f) => /\.(js|d\.ts)$/.test(f))) {
  const rel = relative(dirname(file), join(out, 'core/dist/index.js')).replace(/\\/g, '/');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  const src = readFileSync(file, 'utf8');
  const next = src.replace(/(['"])@pc98-web\/core\1/g, `$1${spec}$1`);
  if (next !== src) writeFileSync(file, next);
}

const pkg = JSON.parse(readFileSync(join(mcp, 'package.json'), 'utf8'));
delete pkg.dependencies['@pc98-web/core'];
delete pkg.devDependencies;
delete pkg.scripts;
pkg.files = ['dist', 'core', 'app', 'README.md', 'LICENSE'];
pkg.repository = { type: 'git', url: 'git+https://github.com/crafter-games/pc98-web.git', directory: 'packages/mcp' };
pkg.homepage = 'https://pc98.crafter.games';
pkg.keywords = ['pc-98', 'pc-9801', 'emulator', 'mcp', 'neko-project-ii', 'agent'];
pkg.engines = { node: '>=20' };
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const license = readFileSync(join(mcp, '../../LICENSE'), 'utf8');
writeFileSync(join(out, 'LICENSE'), `${license}\n---\n\n${readFileSync(join(mcp, '../../native/LICENSE.np2-wasm'), 'utf8')}`);
writeFileSync(join(out, 'README.md'), `# pc98-mcp

An MCP server that lets AI agents play a PC-9801 (NEC PC-98) emulator:
Neko Project II compiled to WebAssembly, running headless in Node.

\`\`\`sh
claude mcp add pc98 -- npx -y pc98-mcp --disks ~/pc98-games
\`\`\`

Agents get tools to see the screen, read the text VRAM as Unicode, type,
advance visual novels page by page, swap disks, and save/load states. Time
only passes inside tool calls, so play is deterministic and as slow as the
agent needs. \`pair_browser\` attaches a tab of https://pc98.crafter.games so
the agent plays the game you are watching.

No ROMs are needed. Bring your own legally obtained disk images.
Data lives in \`~/.pc98\`. See \`pc98-mcp --help\` and
https://github.com/crafter-games/pc98-web.
`);
console.log(`release ready in ${relative(process.cwd(), out)}`);
