// Браузерные тесты (Playwright + Chromium): консоль без ошибок, XSS, HUD, телефон (мультитач, экраны),
// фоновая вкладка, независимость от FPS, фокус чата.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, devices } from 'playwright';
import { startServer, wait } from '../helpers.js';

let srv, browser;
const errors = [];
beforeAll(async () => {
  srv = await startServer({ WF_MAX_CONN_PER_IP: '64' });
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
});
afterAll(async () => { await browser?.close(); await srv?.stop(); });

async function page(opts = {}, initScript) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  const pg = await ctx.newPage();
  if (initScript) await pg.addInitScript(initScript);
  pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(e.message));
  pg.on('console', m => { if (m.type() === 'error') pg.errs.push(m.text()); });
  await pg.goto(srv.url + '/');
  await pg.waitForFunction(() => window.app && window.app.myId, null, { timeout: 10000 });
  return pg;
}
async function createAndStart(pg, nick, settings = {}) {
  await pg.fill('#nick', nick);
  await pg.click('#btn-create');
  for (const [k, v] of Object.entries(settings)) await pg.selectOption('#s-' + k, v).catch(async () => pg.fill('#s-' + k, String(v)));
  await pg.click('#btn-create-ok');
  await pg.waitForSelector('#lobby:not(.hidden)');
}
async function startGame(pg) {
  await pg.click('#btn-start');
  await pg.waitForFunction(() => app.game && app.game.predKind === 'plane', null, { timeout: 10000 });
}

describe('браузер: базовый сценарий', () => {
  it('меню → лобби → бой → выход без ошибок в консоли', async () => {
    const pg = await page();
    await createAndStart(pg, 'Clean');
    await startGame(pg);
    await pg.keyboard.down('KeyW'); await pg.keyboard.down('Space');
    await wait(2500);
    await pg.keyboard.up('Space'); await pg.keyboard.up('KeyW');
    await pg.keyboard.press('Escape');
    await pg.click('#btn-quit');
    await pg.waitForSelector('#menu:not(.hidden)');
    expect(pg.errs).toEqual([]);
    await pg.context().close();
  });

  it('XSS: HTML в чате и названии лобби не исполняется и показывается как текст', async () => {
    const a = await page(), b = await page();
    await a.fill('#nick', 'Alice');
    await a.click('#btn-create');
    await a.fill('#s-name', '<img src=x onerror="window.__xss=1">');
    await a.click('#btn-create-ok');
    await a.waitForSelector('#lobby:not(.hidden)');
    const code = await a.textContent('#lobby-code');
    await b.fill('#nick', 'Bob');
    await b.click('#btn-browse');
    await b.waitForSelector('#room-list tr[data-code]');
    await b.fill('#join-code', code).catch(() => {});
    await b.click('[data-back]').catch(() => {});
    await b.fill('#join-code', code);
    await b.click('#btn-join-code');
    await b.waitForSelector('#lobby:not(.hidden)');
    await b.fill('#lobby-chat-input', '<img src=x onerror="window.__xss=2"><script>window.__xss=3</script>');
    await b.press('#lobby-chat-input', 'Enter');
    await wait(500);
    expect(await a.evaluate(() => window.__xss)).toBeUndefined();
    expect(await b.evaluate(() => window.__xss)).toBeUndefined();
    expect(await a.textContent('#lobby-chat')).toContain('<img');
    expect(await a.locator('#lobby-chat img').count()).toBe(0);
    await a.context().close(); await b.context().close();
  });

  it('HUD показывает значения, совпадающие с сервером (скорость, боезапас, прочность)', async () => {
    const pg = await page();
    await createAndStart(pg, 'Hud');
    await startGame(pg);
    await pg.keyboard.down('Space'); await wait(1500); await pg.keyboard.up('Space'); await wait(600);
    const r = await pg.evaluate(() => {
      const g = app.game, info = g.lastHudInfo, me = g.lastMe;
      return info && { speed: info.me.speed, srvSpeed: Math.hypot(me.pl[2], me.pl[3]), ammo: info.me.weapons[0].n, srvAmmo: me.am[0], hp: info.me.hpFrac, srvHp: me.hp / me.mhp };
    });
    expect(r, 'NetGame не сохраняет последние данные HUD (lastHudInfo)').toBeTruthy();
    expect(Math.abs(r.speed - r.srvSpeed) / r.srvSpeed).toBeLessThan(0.1);
    expect(r.ammo).toBe(r.srvAmmo);
    expect(r.hp).toBeCloseTo(r.srvHp, 3);
    await pg.context().close();
  });

  it('открытый чат перехватывает клавиши, после закрытия клавиши не залипают', async () => {
    const pg = await page();
    await createAndStart(pg, 'Chat');
    await startGame(pg);
    await pg.keyboard.down('KeyD');
    await pg.keyboard.press('Enter');
    await pg.keyboard.type('wasd test');
    expect(await pg.evaluate(() => app.input.keys.size)).toBe(0);
    await pg.keyboard.press('Escape');
    await pg.keyboard.up('KeyD');
    await wait(100);
    expect(await pg.evaluate(() => app.input.enabled)).toBe(true);
    expect(await pg.evaluate(() => app.input.keys.size)).toBe(0);
    await pg.context().close();
  });
});

describe('браузер: FPS и фоновая вкладка', () => {
  const fpsScript = fps => `(() => { let last = 0; window.requestAnimationFrame = cb => setTimeout(() => { last += 1000 / ${fps}; cb(performance.now()); }, 1000 / ${fps}); })()`;
  it.each([30, 60, 144])('%i FPS: клиент шлёт 30 вводов/с и предсказание не расходится с сервером', async fps => {
    const pg = await page({}, fpsScript(fps));
    await createAndStart(pg, 'Fps' + fps);
    await startGame(pg);
    await wait(1000);
    const s0 = await pg.evaluate(() => app.game.seq);
    await pg.keyboard.down('KeyA');
    await wait(3000);
    await pg.keyboard.up('KeyA');
    const s1 = await pg.evaluate(() => app.game.seq);
    const rate = (s1 - s0) / 3;
    expect(rate).toBeGreaterThan(27); expect(rate).toBeLessThan(33);
    const err = await pg.evaluate(() => Math.hypot(app.game.smooth.x, app.game.smooth.y));
    expect(err).toBeLessThan(30);
    await pg.context().close();
  });

  it('фоновая вкладка: сервер не продолжает бесконечно стрелять последним вводом', async () => {
    const pg = await page();
    await createAndStart(pg, 'Bg');
    await startGame(pg);
    await pg.keyboard.down('Space');
    await wait(500);
    // имитируем уход вкладки в фон: rAF перестаёт вызываться, document.hidden = true
    await pg.evaluate(() => {
      window.__rafStop = true;
      const orig = window.requestAnimationFrame;
      window.requestAnimationFrame = cb => (window.__rafStop ? setTimeout(() => window.requestAnimationFrame(cb), 50) : orig(cb));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(600);
    const a0 = await pg.evaluate(() => app.game.lastMe.am[0]);
    await wait(2500);
    const a1 = await pg.evaluate(() => app.game.lastMe.am[0]);
    expect(a0 - a1, 'в фоне сервер продолжает стрелять').toBeLessThan(3);
    await pg.keyboard.up('Space');
    await pg.context().close();
  });
});

describe('браузер: телефон', () => {
  const layouts = [
    ['iPhone SE landscape', { ...devices['iPhone SE'], viewport: { width: 568, height: 320 } }],
    ['iPhone 13 landscape', devices['iPhone 13 landscape']],
    ['Pixel 7 landscape', devices['Pixel 7 landscape']],
    ['iPad landscape', devices['iPad (gen 7) landscape']],
  ];
  it.each(layouts)('%s: кнопки в пределах экрана и не перекрываются', async (_, dev) => {
    const pg = await page(dev);
    await createAndStart(pg, 'Mob');
    await startGame(pg);
    await wait(500);
    const boxes = await pg.evaluate(() => [...document.querySelectorAll('#touch .rb, #touch .stick, #touch .throttle')].filter(e => e.offsetParent !== null && getComputedStyle(e).display !== 'none')
      .map(e => { const r = e.getBoundingClientRect(); return { n: e.className, x: r.left, y: r.top, w: r.width, h: r.height }; }));
    const vw = await pg.evaluate(() => [innerWidth, innerHeight]);
    for (const b of boxes) {
      expect(b.x >= -1 && b.y >= -1 && b.x + b.w <= vw[0] + 1 && b.y + b.h <= vw[1] + 1, `${b.n} вне экрана`).toBe(true);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ov = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      expect(ov, `${a.n} перекрывает ${b.n}`).toBeLessThan(4);
    }
    await pg.context().close();
  });

  it('портретная ориентация: игра просит повернуть экран или раскладка не ломается', async () => {
    const pg = await page(devices['iPhone 13']);
    await createAndStart(pg, 'Port');
    await startGame(pg);
    const hint = await pg.evaluate(() => { const e = document.getElementById('rotate-hint'); return !!e && getComputedStyle(e).display !== 'none'; });
    expect(hint, 'нет подсказки «поверните устройство» в портретной ориентации').toBe(true);
    await pg.context().close();
  });

  it('мультитач: одновременно рулить джойстиком и стрелять', async () => {
    const pg = await page(devices['iPhone 13 landscape']);
    await createAndStart(pg, 'Touch');
    await startGame(pg);
    await wait(800);
    const cdp = await pg.context().newCDPSession(pg);
    const c = async sel => pg.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const st = await c('.stick.move'), fire = await c('.rb.fire');
    const a0 = await pg.evaluate(() => ({ am: app.game.lastMe.am[0], a: app.game.pred.a }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: st.x, y: st.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: st.x, y: st.y, id: 1 }, { x: fire.x, y: fire.y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: st.x, y: st.y - 45, id: 1 }, { x: fire.x, y: fire.y, id: 2 }] });
    await wait(1500);
    const a1 = await pg.evaluate(() => ({ am: app.game.lastMe.am[0], a: app.game.pred.a }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(a0.am - a1.am, 'не стреляет').toBeGreaterThan(5);
    // джойстик вверх — нос задирается (угол к π/2)
    expect(Math.abs(a1.a - Math.PI / 2)).toBeLessThan(Math.abs(a0.a - Math.PI / 2));
    await pg.context().close();
  });

  it('пилот: два джойстика — движение и направление стрельбы одновременно', async () => {
    const pg = await page(devices['iPhone 13 landscape']);
    await createAndStart(pg, 'Pilot');
    await startGame(pg);
    await wait(500);
    const cdp = await pg.context().newCDPSession(pg);
    const c = async sel => pg.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const ej = await c('.rb.eject');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ej.x, y: ej.y, id: 1 }] });
    await wait(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pg.waitForFunction(() => app.game.predKind === 'pilot', null, { timeout: 5000 });
    const mv = await c('.stick.move'), aim = await c('.stick.aim');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mv.x, y: mv.y, id: 1 }, { x: aim.x, y: aim.y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mv.x + 40, y: mv.y, id: 1 }, { x: aim.x - 35, y: aim.y - 35, id: 2 }] });
    await wait(700);
    const s = await pg.evaluate(() => ({ aim: app.game.pred.aim, vx: app.game.pred.vx, tr: app.renderer.tracers.length }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(s.aim).toBeCloseTo(3 * Math.PI / 4, 1);
    expect(s.vx).toBeGreaterThan(10);
    expect(s.tr).toBeGreaterThan(0);
    await pg.context().close();
  });
});
