// Самопроверка: поднимает сервер, подключает тестового клиента, играет матч с ботами в каждом режиме.
import { spawn } from 'child_process';
import WebSocket from 'ws';

const PORT = 3999;
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, PROFILES_FILE: '/tmp/wf-selftest-profiles.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
let errOut = '';
srv.stderr.on('data', d => { errOut += d; process.stderr.write(d); });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function runMode(mode, map) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const stats = { snaps: 0, kills: 0, shots: 0, booms: 0, end: null, me: null };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 's') {
      stats.snaps++; stats.me = m.me.s;
      for (const e of m.E) { if (e[0] === 'kill') stats.kills++; if (e[0] === 'shot') stats.shots++; if (e[0] === 'boom') stats.booms++; }
    }
    if (m.t === 'end') stats.end = m.reason;
  });
  ws.send(JSON.stringify({ t: 'hello', name: 'Tester', token: 'selftest-token-123456' }));
  ws.send(JSON.stringify({ t: 'create', settings: { mode, map, bots: true, botCount: 7, botDifficulty: 2, timeLimit: 2, maxPlayers: 8 } }));
  await wait(200);
  ws.send(JSON.stringify({ t: 'start' }));
  let seq = 1;
  const iv = setInterval(() => ws.send(JSON.stringify({ t: 'in', s: seq++, p: Math.sin(seq / 20), t: 1, f: 1, b: seq % 50 === 0 ? 1 : 0 })), 33);
  await wait(15000);
  clearInterval(iv);
  ws.close();
  console.log(mode, map, JSON.stringify(stats));
  return stats;
}

(async () => {
  await wait(800);
  let ok = true;
  for (const [mode, map] of [['tdm', 'islands'], ['dm', 'plains'], ['base', 'plains'], ['br', 'mountains']]) {
    const s = await runMode(mode, map);
    if (s.snaps < 50 || s.shots < 10) ok = false;
  }
  srv.kill();
  if (errOut.includes('Ошибка')) ok = false;
  console.log(ok ? 'SELFTEST OK' : 'SELFTEST FAILED');
  process.exit(ok ? 0 : 1);
})();
