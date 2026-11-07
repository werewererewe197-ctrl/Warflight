// Честность попаданий при задержке: стрелок целится по тому, что видит (интерполяция с задержкой + пинг).
// Сервер должен учитывать, в каком тике клиент видел цель (компенсация лага), иначе «в упор — мимо».
import { describe, it, expect } from 'vitest';
import { INTERP_DELAY_TICKS, TICK_RATE, wrapAngle } from '../../shared/constants.js';
import { makeGame, fakeClient, ticks, placePlane, feed } from '../helpers.js';

export function scenario(pingMs, planeId = 'us_b3') {
  const g = makeGame({ mode: 'tdm' }, [fakeClient('s', { team: 0 }), fakeClient('t', { team: 1, planeId })]);
  ticks(g, 40);
  const oneWay = Math.round(pingMs / 2 / 1000 * TICK_RATE);
  const interp = INTERP_DELAY_TICKS;
  const tg = placePlane(g, 't', 3400, 1500, Math.PI / 2 - 0.25, 260);   // цель пересекает курс снизу вверх
  const sh = placePlane(g, 's', 3000, 1450, 0, 250);
  tg.pc.hp = 1e9; tg.st = { ...tg.st, maxHp: 1e9 };
  const hist = [];          // что сервер «показывает» в каждом тике (позиция цели)
  const pending = [];       // вводы стрелка в пути до сервера
  let hits = 0, shots = 0;
  const muzzle = sh.st.guns[0].wd.speed;
  for (let i = 0; i < 60; i++) {
    const k = g.tickN;
    hist[k] = { x: tg.p.x, y: tg.p.y, vx: tg.p.vx, vy: tg.p.vy };
    // клиент видит цель с задержкой oneWay + интерполяция
    const seen = hist[k - oneWay - interp] || hist[0] || hist[k];
    // упреждение как в клиенте (относительная скорость, скорость пули)
    let rx = seen.x - sh.p.x, ry = seen.y - sh.p.y, t = Math.hypot(rx, ry) / muzzle, ax = rx, ay = ry;
    for (let n = 0; n < 3; n++) { ax = rx + (seen.vx - sh.p.vx) * t; ay = ry + (seen.vy - sh.p.vy) * t; t = Math.hypot(ax, ay) / muzzle; }
    pending.push({ at: k + oneWay, aim: Math.atan2(ay, ax), rt: k - oneWay - interp });
    // ввод доходит до сервера через oneWay тиков
    while (pending.length && pending[0].at <= k) {
      const inp = pending.shift();
      sh.p.a = inp.aim; const v = 250; sh.p.vx = Math.cos(inp.aim) * v; sh.p.vy = Math.sin(inp.aim) * v;
      feed(g, 's', { f: 1, ta: 1, rt: inp.rt });
    }
    feed(g, 't', { ta: 1 });
    // цель летит прямо (без манёвров)
    tg.p.a = Math.atan2(tg.p.vy, tg.p.vx);
    g.tick();
    for (const e of g.events) { if (e[0] === 'shot' && e[1] === sh.eid) shots++; if (e[0] === 'hit' && e[3] === tg.eid) hits++; }
    g.events = [];
  }
  return { hits, shots, ratio: shots ? hits / shots : 0 };
}

describe('компенсация задержки при попаданиях', () => {
  it.each([[0, 'us_b3'], [50, 'us_b3'], [150, 'us_b3'], [300, 'us_b3'], [0, 'jp_f1'], [150, 'jp_f1'], [300, 'jp_f1']])('пинг %i мс, цель %s: прицельная очередь по прямолетящей цели попадает', (ping, target) => {
    const r = scenario(ping, target);
    console.log(`ping=${ping} target=${target} hits=${r.hits}/${r.shots}`);
    expect(r.shots).toBeGreaterThan(8);
    expect(r.ratio, `попаданий ${r.hits} из ${r.shots}`).toBeGreaterThan(0.5);
  });
});
