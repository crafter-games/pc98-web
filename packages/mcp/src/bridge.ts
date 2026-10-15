import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { RemoteBackend } from './backends/remote.js';

const PAIRING_TTL_MS = 10 * 60_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export const DEFAULT_ALLOWED_ORIGINS = ['https://pc98.crafter.games', 'http://localhost', 'http://127.0.0.1'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.bmp': 'image/bmp', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

export interface BridgeOptions {
  port: number;
  /** Built web app to serve on the bridge port, so a same-origin tab can attach without local-network prompts. */
  appDir?: string;
  /** Origins allowed to attach. "http://localhost" matches any port. */
  allowedOrigins?: string[];
  /** Web app URL the pairing link points to. */
  appUrl?: string;
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.some((a) => origin === a || origin.startsWith(`${a}:`));
}

/**
 * Lets one browser tab attach to the MCP server over a WebSocket on
 * 127.0.0.1. Pairing uses a one-time token handed to the user by the agent.
 */
export class BrowserBridge {
  private http?: Server;
  private wss?: WebSocketServer;
  private port = 0;
  private token?: { value: Buffer; expires: number };
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  backend?: RemoteBackend;
  onChange?: () => void;

  constructor(private readonly opts: BridgeOptions) {}

  get attached(): boolean { return !!this.backend; }

  private async listen(): Promise<number> {
    if (this.http) return this.port;
    const http = createServer((req, res) => this.serveApp(req, res));
    const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });
    wss.on('connection', (ws, req) => this.accept(ws, req.headers.origin));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
    this.http = http;
    this.wss = wss;
    this.port = (http.address() as { port: number }).port;
    return this.port;
  }

  /** Static files of the web app, confined to appDir. */
  private serveApp(req: IncomingMessage, res: ServerResponse) {
    const root = this.opts.appDir;
    if (!root || req.method !== 'GET') {
      res.writeHead(404).end('pc98-mcp bridge');
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = resolve(join(root, path));
    if (file !== resolve(root) && !file.startsWith(resolve(root) + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(file));
  }

  /** Creates a fresh one-time token and returns the links that attach a tab. */
  async pair(): Promise<{ url: string; localUrl?: string; wsUrl: string; expiresInMinutes: number }> {
    const port = await this.listen();
    const value = randomBytes(18);
    this.token = { value, expires: Date.now() + PAIRING_TTL_MS };
    const wsUrl = `ws://127.0.0.1:${port}/${value.toString('base64url')}`;
    const app = this.opts.appUrl ?? 'https://pc98.crafter.games/';
    const hash = `#agent=${encodeURIComponent(wsUrl)}`;
    return {
      url: `${app}${hash}`,
      localUrl: this.opts.appDir ? `http://127.0.0.1:${port}/${hash}` : undefined,
      wsUrl,
      expiresInMinutes: PAIRING_TTL_MS / 60_000,
    };
  }

  private takeToken(presented: string): boolean {
    const t = this.token;
    if (!t || Date.now() > t.expires) return false;
    const given = Buffer.from(presented, 'base64url');
    if (given.length !== t.value.length || !timingSafeEqual(given, t.value)) return false;
    this.token = undefined; // one use only
    return true;
  }

  private accept(ws: WebSocket, origin: string | undefined) {
    const allowed = this.opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
    if (!originAllowed(origin, allowed)) {
      ws.close(4003, 'origin not allowed');
      return;
    }
    const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 5000);
    ws.once('message', (raw) => {
      clearTimeout(helloTimer);
      let hello: { type?: string; token?: string };
      try { hello = JSON.parse(String(raw)); } catch { hello = {}; }
      if (hello.type !== 'hello' || typeof hello.token !== 'string' || !this.takeToken(hello.token)) {
        ws.close(4001, 'bad or expired pairing token');
        return;
      }
      this.socket?.close(4000, 'replaced by a new tab');
      this.socket = ws;
      this.backend = new RemoteBackend((m, p, t) => this.call(m, p, t), origin!);
      ws.send(JSON.stringify({ type: 'welcome' }));
      ws.on('message', (data) => this.onMessage(String(data)));
      ws.on('close', () => {
        if (this.socket !== ws) return;
        this.socket = undefined;
        this.backend = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The browser tab disconnected')); }
        this.pending.clear();
        this.onChange?.();
      });
      this.onChange?.();
    });
  }

  private onMessage(data: string) {
    let msg: { id?: number; result?: unknown; error?: string };
    try { msg = JSON.parse(data); } catch { return; }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error)); else p.resolve(msg.result);
  }

  private call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const ws = this.socket;
    if (!ws) return Promise.reject(new Error('No browser tab is attached'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser tab did not answer ${method} in time (is it in the background or paused?)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  detach() {
    this.socket?.close(4000, 'detached by the agent');
  }

  async close() {
    this.detach();
    this.wss?.close();
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }
}
