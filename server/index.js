// Точка входа сервера: HTTP-статика + WebSocket, маршрутизация сообщений.
import http from 'http';
import fs from 'fs';
import os from 'os';
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
// Раздаём только эти каталоги (защита от обхода путей: ../data/profiles.json и т.п.).
const STATIC_DIRS = ['client', 'shared'].map(d => path.join(ROOT, d) + path.sep);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
// Лимиты против флуда подключениями. За обратным прокси (Render, nginx) включите TRUST_PROXY=1.
const MAX_CONN_PER_IP = +(process.env.WF_MAX_CONN_PER_IP || 24);
const CONN_RATE = +(process.env.WF_CONN_RATE || 40);         // новых подключений с IP за 10 с
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RECONNECT_GRACE_MS = +(process.env.WF_RECONNECT_GRACE_MS || 30000);
const TEST_HOOKS = process.env.WF_TEST_HOOKS === '1';
// Эмуляция сети для тестов: WF_NETSIM="lat=150,jitter=30,loss=0.05" — задержка в одну сторону (мс), джиттер,
// доля «потерянных» пакетов. Поверх TCP потеря = повторная передача (+250 мс) с задержкой всех следующих.
const NETSIM = (() => {
  const v = process.env.WF_NETSIM; if (!v) return null;
  const o = Object.fromEntries(v.split(',').map(kv => kv.split('=')).map(([k, x]) => [k.trim(), +x]));
  return { lat: o.lat || 0, jitter: o.jitter || 0, loss: o.loss || 0 };
})();
function netDelay(state) {
  const now = Date.now();
  let at = now + NETSIM.lat + Math.random() * NETSIM.jitter + (Math.random() < NETSIM.loss ? 250 : 0);
  at = Math.max(at, state.last || 0);          // TCP не переупорядочивает
  state.last = at;
  return at - now;
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'planes.json'), 'utf8'));
const profiles = new ProfileStore(data);
const rooms = new RoomManager(data, profiles);
const stats = { bytesOut: 0, msgsOut: 0, bytesIn: 0 };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { send(res, 400, 'bad request'); return; }
  if (url.includes('\0')) { send(res, 400, 'bad request'); return; }
  if (url === '/' || url === '/index.html') url = '/client/index.html';
  if (url === '/health') { send(res, 200, 'ok', 'text/plain'); return; }
  if (url === '/metrics' && process.env.WF_METRICS === '1') {
    const mem = process.memoryUsage(), cpu = process.cpuUsage();
    send(res, 200, JSON.stringify({
      uptime: process.uptime(), rssMB: mem.rss / 1048576, heapMB: mem.heapUsed / 1048576, cpuUserS: cpu.user / 1e6, cpuSysS: cpu.system / 1e6,
      clients: wss.clients.size, rooms: rooms.rooms.size, bytesOut: stats.bytesOut, msgsOut: stats.msgsOut, bytesIn: stats.bytesIn,
      games: [...rooms.rooms.values()].filter(r => r.game).map(r => ({ code: r.code, humans: r.players.size, ...r.game.tickStats() })),
    }), 'application/json');
    return;
  }
  // нормализуем путь (убираем «..») и проверяем, что файл лежит внутри разрешённого каталога
  const file = path.resolve(ROOT, '.' + path.posix.normalize('/' + url));
  if (!STATIC_DIRS.some(d => file.startsWith(d))) { send(res, 404, 'not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { send(res, 404, 'not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(buf);
  });
});
function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
let idSeq = 1;
const ipConns = new Map();     // ip -> число открытых соединений
const ipRecent = new Map();    // ip -> время последних подключений
const byToken = new Map();     // хеш токена -> Client (для переподключения и запрета двух вкладок)

class Client {
  constructor(ws, ip) {
    this.ws = ws; this.ip = ip;
    this.id = 'p' + (idSeq++);
    this.name = 'Пилот';
    this.profile = null; this.tokenHash = null; this.guest = true; this.hello = false;
    this.room = null;
    this.team = 0; this.planeId = null; this.ready = false;
    this.limiter = new RateLimiter();
    this.disconnected = false; this.graceTimer = null;
    this.lastCreate = 0;
  }
  get level() { return this.profile ? levelFromXp(this.profile.xp) : 1; }
  send(m) { this.sendRaw(JSON.stringify(m)); }
  sendRaw(s) {
    if (this.ws.readyState !== 1) return;
    stats.bytesOut += Buffer.byteLength(s); stats.msgsOut++;
    if (NETSIM) { const ws = this.ws; setTimeout(() => { if (ws.readyState === 1) ws.send(s); }, netDelay(this.netOut || (this.netOut = {}))); return; }
    this.ws.send(s);
  }
  error(msg, extra) { this.send({ t: 'err', msg, ...extra }); }
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (ipRecent.get(ip) || []).filter(t => now - t < 10000);
  recent.push(now); ipRecent.set(ip, recent);
  const open = ipConns.get(ip) || 0;
  if (open >= MAX_CONN_PER_IP || recent.length > CONN_RATE) { ws.close(1013, 'too many connections'); return; }
  ipConns.set(ip, open + 1);
  ws.client = new Client(ws, ip);
  const netIn = {};
  ws.on('message', raw => {
    if (NETSIM) { setTimeout(() => onMessage(ws, raw), netDelay(netIn)); return; }
    onMessage(ws, raw);
  });
  function onMessage(ws, raw) {
    const c = ws.client;
    if (!c) return;
    const t = Date.now();
    stats.bytesIn += raw.length;
    if (!c.limiter.allow(t)) { if (c.limiter.abusive) ws.close(4000, 'flood'); return; }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(ws, ws.client, m, t); } catch (e) { console.error('Ошибка обработки', m.t, e); }
  }
  ws.on('close', code => {
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
    const c = ws.client;
    if (!c || c.ws !== ws) return;           // соединение уже передано новому подключению
    // 1006 — обрыв без закрывающего кадра (пропал интернет, уснул телефон): ждём переподключения.
    // Штатное закрытие (вкладку закрыли, ушли со страницы) — выходим сразу.
    onDisconnect(c, code === 1006);
  });
  ws.on('error', () => {});
});

// Обрыв связи: участник остаётся в комнате/матче RECONNECT_GRACE_MS, затем выходит.
function onDisconnect(c, abnormal) {
  const forget = () => { if (c.tokenHash && byToken.get(c.tokenHash) === c) byToken.delete(c.tokenHash); };
  if (!c.room) { forget(); return; }
  if (!abnormal || c.guest || RECONNECT_GRACE_MS <= 0) { c.room.leave(c); forget(); return; }
  c.disconnected = true;
  c.room.away(c);
  clearTimeout(c.graceTimer);
  c.graceTimer = setTimeout(() => {
    c.disconnected = false;
    if (c.room) c.room.leave(c);
    if (byToken.get(c.tokenHash) === c) byToken.delete(c.tokenHash);
  }, RECONNECT_GRACE_MS);
}

// Переносит соединение на существующего клиента (переподключение или вход с другой вкладки).
function resume(ws, old, fresh) {
  if (old.ws !== ws && old.ws.readyState === 1) { old.ws.client = null; old.ws.close(4001, 'Вход с другого устройства'); }
  clearTimeout(old.graceTimer); old.graceTimer = null;
  old.disconnected = false;
  old.ws = ws; ws.client = old;
  old.limiter = fresh.limiter;
  old.send({ t: 'welcome', id: old.id, profile: profiles.view(old.profile), tickRate: TICK_RATE, resumed: !!old.room });
  if (old.room) old.room.resume(old);
}

function handle(ws, c, m, now) {
  if (m.t === 'ping') { c.send({ t: 'pong', c: m.c, s: now }); return; }
  if (m.t === 'hello') {
    if (!c.limiter.allowHello(now)) return;
    const name = sanitizeName(m.name);
    if (!c.hello) {
      const { profile, hash, guest } = profiles.login(m.token, name, c.ip);
      if (hash) {
        const old = byToken.get(hash);
        if (old && old !== c) { old.name = name; resume(ws, old, c); return; }
        byToken.set(hash, c);
      }
      c.profile = profile; c.tokenHash = hash; c.guest = guest; c.hello = true;
    }
    c.name = name;
    if (c.room) c.room.rename(c, name);
    c.send({ t: 'welcome', id: c.id, profile: profiles.view(c.profile), tickRate: TICK_RATE, resumed: false, guest: c.guest });
    return;
  }
  // всё остальное — только после представления
  if (!c.hello) { c.error('Сначала представьтесь (hello)'); return; }
  switch (m.t) {
    case 'rename': {
      c.name = sanitizeName(m.name);
      if (c.profile && !c.guest) profiles.rename(c.profile, c.name);
      if (c.room) c.room.rename(c, c.name);
      return;
    }
    case 'list': c.send({ t: 'rooms', list: rooms.list() }); return;
    case 'create': case 'quick': {
      if (now - c.lastCreate < 2000) return c.error('Слишком часто');
      c.lastCreate = now;
      if (m.t === 'quick') { rooms.quick(c); return; }
      const err = rooms.create(c, m.settings && typeof m.settings === 'object' ? m.settings : {});
      if (typeof err === 'string') c.error(err);
      return;
    }
    case 'join': {
      if (typeof m.code !== 'string') return c.error('Неверный код');
      const r = rooms.rooms.get(m.code.toUpperCase().trim());
      if (!r) return c.error('Лобби с таким кодом не найдено');
      const err = r.join(c, typeof m.password === 'string' ? m.password : '');
      if (err) c.error(err, { needPassword: err === 'Неверный пароль', code: r.code });
      return;
    }
    case 'leave': if (c.room) c.room.leave(c); return;
    case 'unlock': case 'upgrade': {
      if (c.guest) return c.error('Прогресс доступен только с сохранённым профилем');
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
    case '__end':
      // тестовый хук: мгновенно завершить матч (только при WF_TEST_HOOKS=1)
      if (TEST_HOOKS && c.room && c.room.game) c.room.game.finish({ winnerTeam: null, reason: 'Тест' });
      return;
    default:
      if (c.room) c.room.handle(c, m);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Warflight запущен: http://localhost:${PORT}`);
  const nets = Object.values(os.networkInterfaces()).flat();
  for (const n of nets) if (n && n.family === 'IPv4' && !n.internal) console.log(`  в локальной сети: http://${n.address}:${PORT}`);
});

function shutdown() { profiles.flush(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Необработанная ошибка не должна молча терять прогресс: сохраняем профили и пишем в лог.
process.on('uncaughtException', e => { console.error('Необработанная ошибка:', e); profiles.flush(); });
process.on('unhandledRejection', e => { console.error('Необработанный промис:', e); });
