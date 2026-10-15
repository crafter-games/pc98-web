# PC-98 Web

A PC-9801 emulator for the browser, built on [Neko Project II](http://www.yui.ne.jp/np2/)
compiled to WebAssembly, and designed to be driven by AI agents as well as people.

- **Runs in the browser.** Disk images, saves and states stay on your machine.
- **Runs headless in Node.** The same WebAssembly core runs frame by frame,
  deterministic and faster than real time, for tests and agents.
- **Agent-ready.** An MCP server (in progress) lets agents see the screen, read
  the text VRAM as Unicode, type, click and manage disks and save states.

No BIOS or font ROMs are needed: NP2's built-in BIOS and a font built from the
free Shinonome bitmaps are used by default. Real ROMs can be supplied optionally.

## Layout

| Path | What |
|---|---|
| `native/` | NP2 C sources (from np2-wasm) plus `native/src/wasm/`, an SDL-free host layer driven through the `np2w_*` API |
| `packages/core` | `@pc98-web/core`: TypeScript API over the WASM core for browsers and Node |
| `packages/web` | The web app (Vite + Preact) |
| `packages/mcp` | The MCP server for agents (planned) |
| `fixtures/` | Test images: public ones are downloaded, private ones never leave your disk |

## Development

Requires Node 22+, pnpm, Emscripten, CMake and Ninja (`brew install emscripten cmake ninja`).

```sh
pnpm install
pnpm build          # WASM cores + font + all packages
pnpm fixtures       # downloads FreeDOS(98) for the tests
pnpm test
pnpm --filter @pc98-web/web dev
```

Enable the hook that keeps disk images and ROMs out of git:

```sh
git config core.hooksPath .githooks
```

## Headless use

```js
import { PC98 } from '@pc98-web/core';

const pc = await PC98.create({ config: { cpu: 'i386', soundBoard: '86' }, epochMs: Date.UTC(1996, 0, 1) });
pc.insertDisk('fdd', 0, 'freedos.hdm', bytes);
pc.reset();
pc.runUntil((p) => /A:\\>/.test(p.textScreen()), 56 * 60);
pc.typeText('dir\n');
pc.runFrames(120);
console.log(pc.textScreen());
```

## Legal

This project contains no commercial software and no ROM dumps. Use your own
legally obtained disk images. See `fixtures/README.md`.
