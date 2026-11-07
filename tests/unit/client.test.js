// Клиентский сетевой код без браузера: интерполяция при дрейфе часов и джиттере, упреждение, лента убийств.
import { describe, it, expect } from 'vitest';
import { DT, TICK_RATE, SNAPSHOT_EVERY, wrapAngle } from '../../shared/constants.js';
import { NetGame } from '../../client/netgame.js';
import { DATA } from '../helpers.js';

globalThis.Path2D = globalThis.Path2D || class Path2D { constructor() {} };

// Заглушка canvas-контекста: любые методы — no-op.
function stubCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k in t) return t[k];
      return () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function stubApp() {
  const r = {
    W: 1280, H: 720, dpr: 1, ctx: stubCtx(), cam: { x: 0, y: 0, z: 1 }, time: 0, particles: [], tracers: [],
    setTerrain() {}, follow(x, y) { this.cam.x = x; this.cam.y = y; }, update() {}, draw(view) { this.lastView = view; }, planeFx() {},
    sx(x) { return (x - this.cam.x) + 640; }, sy(y) { return 360 - (y - this.cam.y); }, wx(sx) { return sx - 640 + this.cam.x; }, wy(sy) { return 360 - sy + this.cam.y; },
    visible() { return true; }, addTracer() { this.tracerCount = (this.tracerCount || 0) + 1; }, spark() {}, explode() {}, flak() {}, splash() {}, addParticle() {}, smoke() {},
  };
  const input = { touch: false, planeInput: () => ({ p: 0, t: 0 }), pilotInput: () => ({ mx: 0 }), setTouchMode() {}, setTouchInfo() {} };
  const sent = [];
  return { renderer: r, input, net: { send: m => sent.push(m) }, data: DATA, profileUpgrades: () => ({}), toast() {}, addIngameChat() {}, sent };
}
function matchMsg() {
  return { t: 'match', map: 'plains', mode: 'tdm', settings: { respawnMode: 'timer', respawnTime: 5 },
    roster: [{ id: 'me', name: 'Me', team: 0, color: '#00f', planeId: 'us_f1' }, { id: 'en', name: 'Enemy', team: 1, color: '#f00', planeId: 'de_f1' }],
    ground: [], you: 'me', tick: 0 };
}
// Снапшот с одним чужим самолётом, летящим равномерно.
function snap(k, x) {
  return { t: 's', k, tl: 300, ts: [0, 0], P: [[7, 'en', 'de_f1', x, 1500, 0, 1, 300, 0, 1, 0, 100, 1, 1, 1, 1, 0, 0]], C: [], R: [], G: [], z: null, x: null, sc: [], E: [],
    me: { s: 'dead', seq: 0, rt: 3 } };
}

// Прогон: сервер тикает с частотой serverHz, снапшот каждые SNAPSHOT_EVERY тиков, доставка с джиттером.
function runInterp(serverHz, jitterMs, seconds = 40, fps = 60) {
  const app = stubApp();
  const g = new NetGame(app, matchMsg());
  let t = 0;
  g.now = () => t * TICK_RATE;                 // управляемые часы клиента
  const deliveries = [];
  const V = 300; // ед/с
  for (let k = SNAPSHOT_EVERY, i = 0; k / serverHz < seconds; k += SNAPSHOT_EVERY, i++) {
    const sendT = k / serverHz;
    const j = jitterMs ? (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * jitterMs : 0;
    deliveries.push({ at: sendT + 0.05 + j / 1000, s: snap(k, 1000 + V * k / serverHz) });
  }
  deliveries.sort((a, b) => a.at - b.at);
  let di = 0, prevX = null, maxJump = 0, freezes = 0, frames = 0, back = 0;
  const dt = 1 / fps;
  while (t < seconds - 1) {
    t += dt;
    while (di < deliveries.length && deliveries[di].at <= t) g.onSnapshot(deliveries[di++].s);
    if (!g.latest) continue;
    g.frame(dt);
    const pl = app.renderer.lastView.planes.find(p => p.owner === 'en');
    if (!pl) continue;
    frames++;
    if (prevX !== null && t > 3) {
      const d = pl.x - prevX;
      maxJump = Math.max(maxJump, Math.abs(d));
      if (Math.abs(d) < 0.01) freezes++;
      if (d < -0.01) back++;
    }
    prevX = pl.x;
  }
  return { maxJump, freezes, back, frames, expectedStep: V * dt };
}

describe('интерполяция чужих самолётов', () => {
  it.each([[30, 0], [29.7, 0], [30.3, 0], [30, 30], [30, 60], [29.8, 40]])('сервер %f Гц, джиттер %i мс: движение плавное, без замираний и рывков', (hz, jit) => {
    const r = runInterp(hz, jit);
    expect(r.freezes, JSON.stringify(r)).toBeLessThan(r.frames * 0.01);
    expect(r.back, 'движение назад').toBe(0);
    expect(r.maxJump, JSON.stringify(r)).toBeLessThan(r.expectedStep * 3);
  });
});

describe('индикатор упреждения', () => {
  it('пуля, выпущенная в точку упреждения, проходит через цель', () => {
    const app = stubApp();
    const g = new NetGame(app, matchMsg());
    const st = g.myStats;
    const w = st.guns[0].wd;
    for (const [tx, ty, tvx, tvy, ovx, ovy] of [[400, 100, 0, 250, 300, 0], [600, -50, -200, 120, 280, 30], [300, 200, 250, -100, 250, 0]]) {
      const p = { x: 0, y: 0, a: 0, vx: ovx, vy: ovy };
      const view = { planes: [{ owner: 'en', x: tx, y: ty, vx: tvx, vy: tvy, dead: false, cloud: false }] };
      const info = {};
      g.leadIndicator(info, view, p, st);
      expect(info.lead).toBeTruthy();
      // точка упреждения в мировых координатах
      const lx = app.renderer.wx(info.lead.x), ly = app.renderer.wy(info.lead.y);
      const aim = Math.atan2(ly - p.y, lx - p.x);
      // летим пулей (с гравитацией пуль) и ищем минимальное расстояние до цели
      let bx = p.x, by = p.y, bvx = p.vx + Math.cos(aim) * w.speed, bvy = p.vy + Math.sin(aim) * w.speed, best = 1e9;
      let cx = tx, cy = ty;
      // мелкий шаг: сервер проверяет попадание по отрезку траектории, а не только в узлах тика
      const h = DT / 20;
      for (let i = 0; i < 60 * 20; i++) {
        bvy -= 30 * h; bx += bvx * h; by += bvy * h; cx += tvx * h; cy += tvy * h;
        best = Math.min(best, Math.hypot(bx - cx, by - cy));
      }
      expect(best).toBeLessThan(6);
    }
  });
});

describe('лента убийств и эффекты', () => {
  it('смерть от зоны/суицида не подписывается «ПВО»', () => {
    const app = stubApp();
    const g = new NetGame(app, matchMsg());
    g.onEvent(['kill', '', 'en', 'zone']);
    g.onEvent(['kill', '', 'en', 'suicide']);
    for (const k of g.killfeed) expect(k.killer).not.toBe('ПВО');
    g.onEvent(['kill', '', 'en', 'flak']);
    expect(g.killfeed[0].killer).toBe('ПВО');
  });

  it('выстрелы собственных бортовых стрелков отображаются', () => {
    const app = stubApp();
    const g = new NetGame(app, { ...matchMsg(), roster: [{ id: 'me', name: 'Me', team: 0, color: '#00f', planeId: 'us_b3' }] });
    g.predKind = 'plane'; g.predEid = 5;
    const before = app.renderer.tracerCount || 0;
    g.onEvent(['shot', 5, 0, 0, 100, 0, 'hmg', 0.5, 1]);   // последний флаг — стрелок
    expect((app.renderer.tracerCount || 0) - before).toBe(1);
  });
});
