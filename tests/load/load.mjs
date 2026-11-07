// Нагрузочный тест: комната из 16 «живых» клиентов + комната 2 клиента + 14 ботов.
// Замер: длительность тика (avg/p95/p99/max), реальная частота тиков, CPU, память, трафик на игрока.
// Запуск: LOAD_MINUTES=10 node tests/load/load.mjs   (результат печатается JSON-ом в конце)
import { startServer, TestClient, makeToken, wait } from '../helpers.js';

const MIN = +(process.env.LOAD_MINUTES || 10);
const HUMANS_A = +(process.env.LOAD_HUMANS || 16);

async function join(srv, name, code, settings) {
  const c = new TestClient(srv.ws);
  await c.opened;
  c.send({ t: 'hello', name, token: makeToken('load') });
  await c.next('welcome', 5000);
  if (!code) { c.send({ t: 'create', settings }); }
  else c.send({ t: 'join', code });
  const r = await c.next(m => m.t === 'room', 5000);
  c.code = r.room.code;
  return c;
}

function drive(c, seed) {
  let s = 1, t = 0;
  return setInterval(() => {
    t++;
    const ph = (t + seed * 37) / 30;
    c.send({ t: 'in', s: s++, p: Math.sin(ph * 0.9 + seed) * 0.8, th: 0, ta: 1, f: (t + seed) % 60 < 25 ? 1 : 0,
      b: t % 400 === seed % 400 ? 1 : 0, r: t % 250 === seed % 250 ? 1 : 0, fl: t % 300 === 5 ? 1 : 0, bo: (t % 200) < 40 ? 1 : 0,
      e: t % 1800 === (seed * 97) % 1800 ? 1 : 0, mx: Math.sign(Math.sin(ph)), j: t % 90 === 0 ? 1 : 0, aim: ph % 6 - 3 });
  }, 1000 / 30);
}

const srv = await startServer({ WF_METRICS: '1', WF_MAX_CONN_PER_IP: '100', WF_CONN_RATE: '1000' });
const metrics = async () => (await fetch(srv.url + '/metrics')).json();
const clients = [];
const timers = [];

// комната A: 16 людей
const hostA = await join(srv, 'LoadA0', null, { name: 'Load A', mode: 'tdm', map: 'plains', maxPlayers: 16, bots: false, timeLimit: 30, scoreLimit: 200 });
clients.push(hostA);
for (let i = 1; i < HUMANS_A; i++) clients.push(await join(srv, 'LoadA' + i, hostA.code));
for (const c of clients.slice(1)) c.send({ t: 'ready', ready: true });
await wait(200);
hostA.send({ t: 'start' });
// комната B: 2 человека + 14 ботов
const hostB = await join(srv, 'LoadB0', null, { name: 'Load B', mode: 'base', map: 'mountains', maxPlayers: 16, bots: true, botCount: 14, botDifficulty: 2, timeLimit: 30 });
const b1 = await join(srv, 'LoadB1', hostB.code);
b1.send({ t: 'ready', ready: true });
await wait(200);
hostB.send({ t: 'start' });
clients.push(hostB, b1);
await wait(1000);
clients.forEach((c, i) => timers.push(drive(c, i)));

const t0 = Date.now();
const samples = [];
const m0 = await metrics();
let prev = { t: Date.now(), cpu: m0.cpuUserS + m0.cpuSysS, out: m0.bytesOut };
const bytes0 = clients.map(c => c.bytes);
while (Date.now() - t0 < MIN * 60000) {
  await wait(Math.min(30000, MIN * 60000 - (Date.now() - t0)));
  const m = await metrics();
  const now = Date.now();
  const cpu = m.cpuUserS + m.cpuSysS;
  const row = {
    t: Math.round((now - t0) / 1000), rssMB: +m.rssMB.toFixed(1), heapMB: +m.heapMB.toFixed(1),
    cpuPct: +(100 * (cpu - prev.cpu) / ((now - prev.t) / 1000)).toFixed(1),
    outKBs: +((m.bytesOut - prev.out) / 1024 / ((now - prev.t) / 1000)).toFixed(1),
    games: m.games.map(g => ({ code: g.code, users: g.users, avg: +g.avgMs.toFixed(3), p95: +g.p95.toFixed(3), p99: +g.p99.toFixed(3), max: +g.maxMs.toFixed(2), hz: +g.actualHz.toFixed(2), planes: g.planes, bullets: g.bullets })),
    alive: srv.alive(), closed: clients.filter(c => c.closed).length,
  };
  samples.push(row);
  prev = { t: now, cpu, out: m.bytesOut };
  console.log(JSON.stringify(row));
}
const dur = (Date.now() - t0) / 1000;
const perClient = clients.map((c, i) => (c.bytes - bytes0[i]) / dur / 1024);
timers.forEach(clearInterval);
const mEnd = await metrics();
const summary = {
  minutes: MIN, durationS: Math.round(dur), humans: clients.length,
  rssMB: { first: samples[0]?.rssMB, last: samples.at(-1)?.rssMB, max: Math.max(...samples.map(s => s.rssMB)) },
  heapMB: { first: samples[0]?.heapMB, last: samples.at(-1)?.heapMB, max: Math.max(...samples.map(s => s.heapMB)) },
  cpuPctAvg: +(samples.reduce((a, s) => a + s.cpuPct, 0) / samples.length).toFixed(1),
  games: mEnd.games.map(g => ({ code: g.code, users: g.users, avgMs: +g.avgMs.toFixed(3), p95: +g.p95.toFixed(3), p99: +g.p99.toFixed(3), maxMs: +g.maxMs.toFixed(2), actualHz: +g.actualHz.toFixed(3) })),
  downKBsPerClient: { avg: +(perClient.reduce((a, b) => a + b, 0) / perClient.length).toFixed(1), max: +Math.max(...perClient).toFixed(1) },
  upKBsPerClient: +((mEnd.bytesIn - m0.bytesIn) / dur / 1024 / clients.length).toFixed(2),
  serverAlive: srv.alive(), clientsClosed: clients.filter(c => c.closed).length,
  stderr: srv.logs.err.slice(0, 2000),
};
console.log('SUMMARY ' + JSON.stringify(summary, null, 1));
clients.forEach(c => c.close());
await srv.stop();
process.exit(0);
