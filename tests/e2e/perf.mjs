// Замер производительности клиента на «слабом устройстве»: замедление CPU через CDP, бой с ботами,
// средний/95-й перцентиль времени кадра, число частиц и трассеров, рост кучи.
// Запуск: node tests/e2e/perf.mjs [замедление CPU, по умолчанию 4]
import { chromium } from 'playwright';
import { startServer, wait } from '../helpers.js';

const THROTTLE = +(process.argv[2] || 4);
const srv = await startServer({ WF_MAX_CONN_PER_IP: '64' });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pg = await ctx.newPage();
await pg.goto(srv.url + '/');
await pg.waitForFunction(() => window.app && window.app.myId);
await pg.fill('#nick', 'Perf');
await pg.click('#btn-create');
await pg.fill('#s-botcount', '11');
await pg.selectOption('#s-botdiff', '2');
await pg.fill('#s-max', '12');
await pg.click('#btn-create-ok');
await pg.waitForSelector('#lobby:not(.hidden)');
await pg.click('#btn-start');
await pg.waitForFunction(() => app.game && app.game.predKind === 'plane');
const cdp = await ctx.newCDPSession(pg);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await pg.keyboard.down('Space');
await wait(4000);
const r = await pg.evaluate(() => new Promise(res => {
  const ft = []; let last = performance.now(); let n = 0; let maxP = 0, maxT = 0;
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  function f(t) {
    ft.push(t - last); last = t; n++;
    maxP = Math.max(maxP, app.renderer.particles.length); maxT = Math.max(maxT, app.renderer.tracers.length);
    if (n < 400) requestAnimationFrame(f);
    else {
      ft.sort((a, b) => a - b);
      res({ avg: ft.reduce((a, b) => a + b, 0) / ft.length, p95: ft[Math.floor(ft.length * 0.95)], max: ft[ft.length - 1], fps: 1000 / (ft.reduce((a, b) => a + b, 0) / ft.length),
        maxParticles: maxP, maxTracers: maxT, heapGrowthMB: performance.memory ? (performance.memory.usedJSHeapSize - heap0) / 1048576 : null });
    }
  }
  requestAnimationFrame(f);
}));
await pg.keyboard.up('Space');
console.log(JSON.stringify({ throttle: THROTTLE, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v])) }));
await browser.close();
await srv.stop();
process.exit(0);
