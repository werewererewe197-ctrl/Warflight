// Точка входа сервера: HTTP-статика + WebSocket, маршрутизация сообщений.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { ProfileStore } from './profiles.js';
import { RateLimiter, sanitizeInput, sanitizeName } from './anticheat.js';
import { levelFromXp, TICK_RATE } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'planes.json'), 'utf8'));
const profiles = new ProfileStore(data);
const rooms = new RoomManager(data, profiles);

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  if (url === '/' || url === '/index.html') url = '/client/index.html';
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/metrics' && process.env.WF_METRICS === '1') {
    const mem = process.memoryUsage(), cpu = process.cpuUsage();
    const body = {
      uptime: process.uptime(), rssMB: mem.rss / 1048576, heapMB: mem.heapUsed / 1048576, cpuUserS: cpu.user / 1e6, cpuSysS: cpu.system / 1e6,
      clients: wss.clients.size, rooms: rooms.rooms.size, bytesOut: stats.bytesOut, msgsOut: stats.msgsOut, bytesIn: stats.bytesIn,
      games: [...rooms.rooms.values()].filter(r => r.game).map(r => ({ code: r.code, humans: r.players.size, ...r.game.tickStats() })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  if (!url.startsWith('/client/') && !url.startsWith('/shared/')) { res.writeHead(404); res.end('not found'); return; }
  const file = path.resolve(ROOT, '.' + url);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const stats = { bytesOut: 0, msgsOut: 0, bytesIn: 0 };
let idSeq = 1;

class Client {
  constructor(ws, ip) {
    this.ws = ws; this.ip = ip;
    this.id = 'p' + (idSeq++);
    this.name = 'Пилот';
    this.profile = null;
    this.room = null;
    this.team = 0; this.planeId = null; this.ready = false;
    this.limiter = new RateLimiter();
  }
  get level() { return this.profile ? levelFromXp(this.profile.xp) : 1; }
  send(m) { this.sendRaw(JSON.stringify(m)); }
  sendRaw(s) { if (this.ws.readyState === 1) { stats.bytesOut += Buffer.byteLength(s); stats.msgsOut++; this.ws.send(s); } }
  error(msg) { this.send({ t: 'err', msg }); }
}

wss.on('connection', (ws, req) => {
  const c = new Client(ws, req.socket.remoteAddress);
  ws.on('message', raw => {
    const now = Date.now();
    stats.bytesIn += raw.length;
    if (!c.limiter.allow(now)) { if (c.limiter.abusive) ws.close(4000, 'flood'); return; }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(c, m, now); } catch (e) { console.error('Ошибка обработки', m.t, e); }
  });
  ws.on('close', () => { if (c.room) c.room.leave(c); });
  ws.on('error', () => {});
});

function handle(c, m, now) {
  switch (m.t) {
    case 'hello': {
      c.name = sanitizeName(m.name);
      c.profile = profiles.get(m.token, c.name);
      c.send({ t: 'welcome', id: c.id, profile: profiles.view(c.profile), tickRate: TICK_RATE });
      return;
    }
    case 'ping': c.send({ t: 'pong', c: m.c, s: now }); return;
    case 'rename':
      c.name = sanitizeName(m.name);
      if (c.profile) c.profile.name = c.name;
      if (c.room) c.room.update();
      return;
    case 'list': c.send({ t: 'rooms', list: rooms.list() }); return;
    case 'create': {
      const r = rooms.create(c, m.settings);
      return;
    }
    case 'join': {
      const r = rooms.rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return c.error('Лобби с таким кодом не найдено');
      const err = r.join(c, typeof m.password === 'string' ? m.password : '');
      if (err) c.send({ t: 'err', msg: err, needPassword: err === 'Неверный пароль', code: r.code });
      return;
    }
    case 'quick': rooms.quick(c); return;
    case 'leave': if (c.room) c.room.leave(c); return;
    case 'unlock': case 'upgrade': {
      if (!c.profile) return c.error('Профиль не загружен');
      const err = m.t === 'unlock' ? profiles.unlock(c.profile, m.planeId) : profiles.upgrade(c.profile, m.planeId, m.track);
      if (err) return c.error(err);
      c.send({ t: 'profile', profile: profiles.view(c.profile) });
      return;
    }
    case 'in': {
      if (!c.room || !c.room.game) return;
      c.limiter.countInput(now, TICK_RATE);
      const inp = sanitizeInput(m);
      if (inp) c.room.game.handleInput(c.id, inp);
      return;
    }
    default:
      if (c.room) c.room.handle(c, m);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Warflight запущен: http://localhost:${PORT}`);
  const nets = (() => { try { return Object.values(require_os().networkInterfaces()).flat(); } catch { return []; } })();
  for (const n of nets) if (n && n.family === 'IPv4' && !n.internal) console.log(`  в локальной сети: http://${n.address}:${PORT}`);
});

import os from 'os';
function require_os() { return os; }

process.on('SIGINT', () => { profiles.flush(); process.exit(0); });
process.on('SIGTERM', () => { profiles.flush(); process.exit(0); });
