// Сеть с задержкой, джиттером и потерями (эмуляция на сервере WF_NETSIM): свой самолёт без телепортов,
// чужие движутся плавно. Метрики печатаются в консоль (для отчёта).
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { chromium } from 'playwright';
import { startServer, wait } from '../helpers.js';

let browser;
beforeAll(async () => { browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}); });
afterAll(async () => { await browser?.close(); });

async function measure(netsim) {
  const srv = await startServer({ WF_NETSIM: netsim, WF_MAX_CONN_PER_IP: '64' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(srv.url + '/');
  await pg.waitForFunction(() => window.app && window.app.myId, null, { timeout: 15000 });
  await pg.fill('#nick', 'Net');
  await pg.click('#btn-create');
  await pg.fill('#s-botcount', '5');
  await pg.click('#s-classes input[value="bomber"]');   // убираем медленные бомбардировщики
  await pg.click('#btn-create-ok');
  await pg.waitForSelector('#lobby:not(.hidden)');
  await pg.click('#btn-start');
  await pg.waitForFunction(() => app.game && app.game.predKind === 'plane', null, { timeout: 15000 });
  await pg.keyboard.down('KeyW');
  await wait(2500);
  await pg.keyboard.down('KeyA');
  const r = await pg.evaluate(() => new Promise(res => {
    const R = app.renderer, orig = R.draw.bind(R);
    const prev = new Map(); let prevMe = null, prevT = performance.now();
    const st = { frames: 0, remoteFrames: 0, freeze: 0, jump: 0, back: 0, maxCorr: 0, meJump: 0 };
    R.draw = view => {
      const t = performance.now(), dt = (t - prevT) / 1000; prevT = t;
      orig(view);
      st.frames++;
      st.maxCorr = Math.max(st.maxCorr, Math.hypot(app.game.smooth.x, app.game.smooth.y));
      for (const p of view.planes) {
        if (p.isMe) {
          if (prevMe && dt > 0) { const d = Math.hypot(p.x - prevMe.x, p.y - prevMe.y), e = Math.hypot(p.vx, p.vy) * dt; if (d > e * 3 + 8) st.meJump++; }
          prevMe = { x: p.x, y: p.y }; continue;
        }
        if (p.dead) continue;
        const q = prev.get(p.id);
        const v = Math.hypot(p.vx, p.vy);
        if (q && dt > 0 && v > 60) {
          st.remoteFrames++;
          const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy), e = v * dt;
          if (d < e * 0.05) st.freeze++;
          if (d > e * 3 + 6) st.jump++;
          if ((dx * p.vx + dy * p.vy) < -0.2 * e * v) st.back++;
        }
        prev.set(p.id, { x: p.x, y: p.y });
      }
    };
    setTimeout(() => { R.draw = orig; res({ ...st, delay: app.game.delayTicks, rtt: app.net.rtt }); }, 6000);
  }));
  await pg.keyboard.up('KeyA'); await pg.keyboard.up('KeyW');
  await ctx.close();
  await srv.stop();
  return { ...r, errs };
}

describe('сеть с задержкой, джиттером и потерями', () => {
  it.each([
    ['пинг 50 мс, джиттер 15', 'lat=25,jitter=15,loss=0'],
    ['пинг 150 мс, джиттер 30, потери 5%', 'lat=75,jitter=30,loss=0.05'],
    ['пинг 300 мс, джиттер 30, потери 5%', 'lat=150,jitter=30,loss=0.05'],
    ['пинг 150 мс, джиттер 40, потери 10%', 'lat=75,jitter=40,loss=0.1'],
  ])('%s: без телепортов своего самолёта и рывков чужих', async (label, netsim) => {
    const r = await measure(netsim);
    console.log(`[netsim] ${label}: ` + JSON.stringify({ frames: r.frames, remoteFrames: r.remoteFrames, freezePct: +(100 * r.freeze / Math.max(1, r.remoteFrames)).toFixed(1),
      jumpPct: +(100 * r.jump / Math.max(1, r.remoteFrames)).toFixed(2), back: r.back, maxCorr: +r.maxCorr.toFixed(1), meJump: r.meJump, delayTicks: +r.delay.toFixed(1), rttMs: Math.round(r.rtt) }));
    expect(r.errs).toEqual([]);
    expect(r.meJump, 'телепорты своего самолёта').toBeLessThanOrEqual(2);
    expect(r.maxCorr, 'поправки предсказания').toBeLessThan(60);
    expect(r.remoteFrames).toBeGreaterThan(100);
    expect(r.jump / r.remoteFrames, 'рывки чужих самолётов').toBeLessThan(0.03);
    expect(r.freeze / r.remoteFrames, 'замирания чужих самолётов').toBeLessThan(0.08);
  });
});
