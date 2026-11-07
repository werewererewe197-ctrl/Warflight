// Общие помощники тестов: запуск сервера, WS-клиенты, игра без сети.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'planes.json'), 'utf8'));
export const wait = ms => new Promise(r => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

export function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  return path.join(dir, name);
}

// Запускает сервер отдельным процессом. Возвращает { port, url, proc, logs, stop }.
export async function startServer(env = {}) {
  const port = await freePort();
  const profiles = env.PROFILES_FILE || tmpFile('profiles.json');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PROFILES_FILE: profiles, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { out: '', err: '' };
  proc.stdout.on('data', d => { logs.out += d; });
  proc.stderr.on('data', d => { logs.err += d; });
  const t0 = Date.now();
  while (!logs.out.includes('запущен')) {
    if (proc.exitCode !== null) throw new Error('server exited: ' + logs.err);
    if (Date.now() - t0 > 8000) throw new Error('server start timeout: ' + logs.out + logs.err);
    await wait(30);
  }
  return {
    port, url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, proc, logs, profiles,
    alive: () => proc.exitCode === null,
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode !== null) return;
      proc.kill(signal);
      await new Promise(r => { proc.once('exit', r); setTimeout(r, 3000); });
    },
  };
}

// WS-клиент с очередью сообщений.
export class TestClient {
  constructor(url, opts = {}) {
    this.url = url;
    this.msgs = [];
    this.waiters = [];
    this.bytes = 0;
    this.closed = false;
    this.ws = new WebSocket(url, opts);
    this.opened = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', raw => {
      this.bytes += raw.length;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 's') { this.lastSnap = m; this.snapCount = (this.snapCount || 0) + 1; if (this.onSnap) this.onSnap(m); }
      this.log = this.log || [];
      if (m.t !== 's') this.log.push(m);
      const w = this.waiters.find(w => w.pred(m));
      if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); return; }
      if (m.t !== 's') this.msgs.push(m);
    });
    this.ws.on('close', (code, reason) => { this.closed = true; this.closeCode = code; this.closeReason = String(reason); });
    this.ws.on('error', () => {});
  }
  send(m) { if (this.ws.readyState === 1) this.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); }
  sendRaw(b) { if (this.ws.readyState === 1) this.ws.send(b); }
  // Ждёт сообщение (уже полученное или будущее), удовлетворяющее условию.
  next(pred, timeout = 3000) {
    if (typeof pred === 'string') { const t = pred; pred = m => m.t === t; }
    const i = this.msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) { this.waiters.splice(k, 1); rej(new Error('timeout waiting message')); } }, timeout);
    });
  }
  // Ждёт будущее сообщение, не заглядывая в уже полученные.
  future(pred, timeout = 3000) {
    if (typeof pred === 'string') { const t = pred; pred = m => m.t === t; }
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) { this.waiters.splice(k, 1); rej(new Error('timeout waiting message')); } }, timeout);
    });
  }
  async snapshot(pred = () => true, timeout = 4000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.onSnap = null; rej(new Error('timeout waiting snapshot')); }, timeout);
      this.onSnap = s => { if (pred(s)) { clearTimeout(t); this.onSnap = null; res(s); } };
    });
  }
  clear() { this.msgs = []; }
  close() { try { this.ws.close(); } catch {} }
  terminate() { try { this.ws.terminate(); } catch {} }
}

let tokenSeq = 0;
export function makeToken(prefix = 'tok') { return `${prefix}_${Date.now().toString(36)}_${(tokenSeq++).toString(36)}_xxxxxxxx`.slice(0, 60); }

// Подключается и представляется. Возвращает клиента с полем id.
export async function connect(srv, name = 'Tester', token = makeToken()) {
  const c = new TestClient(srv.ws);
  await c.opened;
  c.token = token;
  c.send({ t: 'hello', name, token });
  const w = await c.next('welcome');
  c.id = w.id; c.profile = w.profile;
  return c;
}

export async function createRoom(c, settings = {}) {
  c.send({ t: 'create', settings: { bots: false, ...settings } });
  const r = await c.next(m => m.t === 'room');
  return r.room;
}

// Отправка ввода с корректной нумерацией.
export function inputStream(c, fn, hz = 30) {
  let s = 1;
  const iv = setInterval(() => c.send({ t: 'in', s: s++, ...fn(s) }), 1000 / hz);
  return () => clearInterval(iv);
}

// ---------- игра без сети ----------
import { Game } from '../server/game.js';
import { DEFAULT_SETTINGS } from '../shared/constants.js';

export function fakeClient(id, opts = {}) {
  return {
    id, name: opts.name || id, team: opts.team ?? 0, planeId: opts.planeId || 'us_f1', ready: true,
    profile: opts.profile === undefined ? { unlocked: DATA.planes.map(p => p.id), upgrades: {} } : opts.profile,
    sent: [], send(m) { this.sent.push(m); }, sendRaw(s) { this.sent.push(JSON.parse(s)); },
  };
}

// Создаёт игру без таймера (тики вызываются вручную).
export function makeGame(settings = {}, clients = [fakeClient('h1')]) {
  const room = { settings: { ...DEFAULT_SETTINGS, bots: false, ...settings }, players: new Map(clients.map(c => [c.id, c])) };
  let result = null;
  const g = new Game(room, DATA, r => { result = r; }, { manual: true });
  if (g.timer) clearInterval(g.timer);
  g.result = () => result;
  return g;
}

export function ticks(g, n, each) { for (let i = 0; i < n; i++) { if (each) each(i); g.tick(); if (g.ended) break; } }

// Все самолёты, кроме сбитых, данного участника.
export function planeOf(g, uid) { const u = g.users.get(uid); return u && u.planeEid ? g.planes.get(u.planeEid) : null; }

// Ставит самолёт участника в нужную точку (для детерминированных сценариев).
export function placePlane(g, uid, x, y, a = 0, v = 250) {
  const u = g.users.get(uid);
  if (u.state !== 'plane') g.spawnPlane(u);
  const pl = g.planes.get(u.planeEid);
  Object.assign(pl.p, { x, y, a, vx: Math.cos(a) * v, vy: Math.sin(a) * v, roll: Math.cos(a) >= 0 ? 1 : -1, rollT: Math.cos(a) >= 0 ? 1 : -1, ground: false, stall: 0, spin: 0 });
  pl.protect = 0;
  return pl;
}

// Отправляет ввод участнику (как будто от клиента).
let seqs = {};
export function feed(g, uid, inp) { seqs[uid] = (seqs[uid] || 0) + 1; g.handleInput(uid, { s: seqs[uid], p: 0, t: 0, ...inp }); }
