#!/usr/bin/env node
// Dev tool: runs pc98-mcp over stdio and exposes its tools over local HTTP so
// shell-based agents and scripts can play without an MCP client.
//   node packages/mcp/scripts/http-shim.mjs --port 8099 --shots /tmp/shots -- <pc98-mcp args>
//   curl -s localhost:8099/tool/screenshot -d '{}'
// Responses are plain text; images are written to --shots and their paths listed.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep < 0 ? argv : argv.slice(0, sep);
const serverArgs = sep < 0 ? [] : argv.slice(sep + 1);
const opt = (name, def) => {
  const i = own.indexOf(name);
  return i < 0 ? def : own[i + 1];
};
const port = Number(opt('--port', 8099));
const shots = opt('--shots', join(process.cwd(), 'shots'));
mkdirSync(shots, { recursive: true });

const client = new Client({ name: 'http-shim', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...serverArgs],
  stderr: 'inherit',
}));
let n = 0;

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/tools') {
    const { tools } = await client.listTools();
    res.end(tools.map((t) => `${t.name}: ${t.description}\n  args: ${JSON.stringify(t.inputSchema.properties ?? {})}`).join('\n\n'));
    return;
  }
  const m = /^\/tool\/(\w+)$/.exec(req.url ?? '');
  if (req.method !== 'POST' || !m) {
    res.writeHead(404).end('POST /tool/<name> with JSON args, or GET /tools');
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  try {
    const result = await client.callTool({ name: m[1], arguments: body ? JSON.parse(body) : {} });
    const out = [];
    if (result.isError) out.push('ERROR:');
    for (const c of result.content) {
      if (c.type === 'text') out.push(c.text);
      if (c.type === 'image') {
        const file = join(shots, `${String(++n).padStart(4, '0')}-${m[1]}.png`);
        writeFileSync(file, Buffer.from(c.data, 'base64'));
        out.push(`[screenshot saved: ${file}]`);
      }
    }
    res.end(out.join('\n'));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, '127.0.0.1', () => process.stderr.write(`http-shim on http://127.0.0.1:${port}\n`));
