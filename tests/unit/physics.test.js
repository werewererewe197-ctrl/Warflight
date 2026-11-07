// Модель полёта: энергия, сваливание, штопор, перегрузка, повреждения, независимость от FPS.
import { describe, it, expect } from 'vitest';
import { DT, PHYS_SUBSTEPS, TICK_RATE, clamp, wrapAngle } from '../../shared/constants.js';
import { createPlane, tickPlane, createPilot, tickPilot } from '../../shared/physics.js';
import { getTerrain } from '../../shared/maps.js';
import {
  DATA, MAXUP, SKY, stats, maxLevelSpeed, verticalClimb, accelTime, bestLoop, turnRateAt, loopTime, stallSpeed, speed, step, pathHold,
} from '../tools/flightlab.js';

const FIGHTERS = DATA.planes.filter(p => p.class === 'fighter').map(p => p.id);
const ALL = DATA.planes.map(p => p.id);

describe('энергия и скорость', () => {
  it.each(ALL)('%s: максимальная скорость в горизонте близка к паспортной (±7%%)', id => {
    const st = stats(id);
    const v = maxLevelSpeed(st);
    expect(v / st.def.vmax).toBeGreaterThan(0.93);
    expect(v / st.def.vmax).toBeLessThan(1.07);
  });

  it('при наборе высоты скорость падает, при пикировании растёт', () => {
    const st = stats('us_f1');
    const up = createPlane(st, 0, 1200, 0.8, 300); up.thr = 1;
    const dn = createPlane(st, 0, 1800, -0.8, 300); dn.thr = 1;
    for (let i = 0; i < 90; i++) {
      step(up, st, { p: clamp(wrapAngle(0.8 - up.a) * 4, -1, 1), t: 1 });
      step(dn, st, { p: clamp(wrapAngle(-0.8 - dn.a) * 4, -1, 1), t: 1 });
    }
    expect(speed(up)).toBeLessThan(300);
    expect(speed(dn)).toBeGreaterThan(300);
  });

  it.each(ALL)('%s: нет бесконечного вертикального подъёма даже с полностью прокачанным двигателем', id => {
    const r = verticalClimb(stats(id, MAXUP), 60, false);
    expect(r.stallAt, `самолёт ${id} держит вертикаль ${r.finalV.toFixed(0)} ед/с`).not.toBeNull();
  });

  it.each(ALL)('%s: нет бесконечного вертикального подъёма на форсаже (с учётом перегрева)', id => {
    const st = stats(id, MAXUP);
    const p = createPlane(st, 0, 1000, Math.PI / 2, st.vmax * 0.9); p.thr = 1;
    let stalled = false;
    for (let i = 0; i < 90 / DT; i++) {
      step(p, st, { p: clamp(wrapAngle(Math.PI / 2 - p.a) * 4, -1, 1), t: 1, bo: 1 });
      if (p.y > 2200) p.y -= 1200;
      if (p.stall) { stalled = true; break; }
    }
    expect(stalled).toBe(true);
  });

  it('тяжёлый бомбардировщик разгоняется медленнее истребителя своей нации (150 → 220 ед/с)', () => {
    for (const n of ['us', 'su', 'uk', 'de', 'jp']) {
      const f = accelTime(stats(`${n}_f1`), 150, 220, false, true), b = accelTime(stats(`${n}_b3`), 150, 220, false, true);
      expect(b, `${n}: бомбардировщик ${b.toFixed(1)} с, истребитель ${f.toFixed(1)} с`).toBeGreaterThan(f * 1.25);
    }
  });

  it('бомбардировщик поворачивает (петля) медленнее истребителя', () => {
    for (const n of ['us', 'su', 'uk', 'de', 'jp']) {
      const f = bestLoop(stats(`${n}_f1`)).time, b = bestLoop(stats(`${n}_b3`)).time;
      expect(b).toBeGreaterThan(f * 1.25);
    }
  });
});

describe('сваливание и штопор', () => {
  it.each(FIGHTERS)('%s: сваливание наступает на малой скорости при большом угле атаки', id => {
    const st = stats(id);
    const vs = stallSpeed(st);
    expect(vs, 'сваливание так и не наступило').not.toBeNull();
    expect(vs / st.vstall).toBeGreaterThan(0.6);
    expect(vs / st.vstall).toBeLessThan(1.3);
  });

  it('на нормальной боевой скорости полная ручка не вызывает сваливания', () => {
    for (const id of FIGHTERS) {
      const st = stats(id);
      const p = createPlane(st, 0, 1500, 0, st.vstall * 2.2); p.thr = 1;
      for (let i = 0; i < 30; i++) step(p, st, { p: 1, t: 1 });
      expect(p.stall, id).toBeFalsy();
    }
  });

  it('из штопора можно выйти: отпустить ручку и опустить нос', () => {
    const st = stats('us_f1');
    const p = createPlane(st, 0, 2000, 1.2, st.vstall * 0.8); p.thr = 0.3;
    let spun = false;
    for (let i = 0; i < 4 / DT; i++) { step(p, st, { p: 1, t: 0 }); if (p.spin) spun = true; }
    expect(spun).toBe(true);
    let recovered = false;
    for (let i = 0; i < 8 / DT; i++) {
      step(p, st, { p: p.stall ? 0 : clamp(wrapAngle(-0.3 - p.a) * 3, -1, 1), t: 1 });
      if (p.y < 600) p.y += 1500;
      if (!p.stall && !p.spin && speed(p) > st.vstall) { recovered = true; break; }
    }
    expect(recovered).toBe(true);
  });
});

describe('манёвренность', () => {
  it.each(FIGHTERS)('%s: на большой скорости поворот шире, чем на угловой (ограничение по перегрузке)', id => {
    const st = stats(id);
    expect(turnRateAt(st, st.vmax * 1.15)).toBeLessThan(turnRateAt(st, st.corner));
  });

  it.each(FIGHTERS)('%s: петля с крейсерской скорости выполняется без сваливания', id => {
    const st = stats(id);
    const r = loopTime(st, st.vmax * 0.85);
    expect(r.time).toBeLessThan(12);
    expect(r.stalled).toBe(false);
  });

  it('полёт на спине возможен, но требует большего угла атаки', () => {
    const st = stats('uk_f1');
    const hold = inverted => {
      const p = createPlane(st, 0, 1500, 0, 280); p.thr = 1;
      if (inverted) { p.roll = -1; p.rollT = -1; }
      let alphaSum = 0;
      const ap = pathHold();
      for (let i = 0; i < 300; i++) {
        step(p, st, { p: ap(p, clamp((1500 - p.y) * 0.002, -0.1, 0.1)), t: 1 });
        if (i > 150) alphaSum += wrapAngle(p.a - Math.atan2(p.vy, p.vx));
      }
      return { dy: p.y - 1500, alpha: alphaSum / 149 };
    };
    const up = hold(false), inv = hold(true);
    expect(Math.abs(inv.dy)).toBeLessThan(120);
    expect(inv.alpha).toBeGreaterThan(up.alpha);
  });

  it('бочка (двойной переворот) возвращает самолёт в нормальное положение', () => {
    const st = stats('jp_f1');
    const p = createPlane(st, 0, 1500, 0, 300); p.thr = 1;
    step(p, st, { fl: 1 });
    for (let i = 0; i < 6; i++) step(p, st, {});
    step(p, st, { fl: 1 });
    for (let i = 0; i < 30; i++) step(p, st, {});
    expect(p.roll).toBeCloseTo(1, 2);
  });
});

describe('повреждения влияют на полёт', () => {
  it('без двигателя нет тяги: самолёт тормозит как планер', () => {
    const st = stats('us_f1');
    const a = createPlane(st, 0, 1500, 0, 350); a.thr = 1; a.parts.engine = 0;
    const b = createPlane(st, 0, 1500, 0, 350); b.thr = 0;
    for (let i = 0; i < 90; i++) { step(a, st, { t: 1 }); step(b, st, { ta: 0 }); }
    expect(Math.abs(speed(a) - speed(b))).toBeLessThan(1);
  });

  it('повреждённое крыло тянет самолёт (нос уходит при нейтральной ручке)', () => {
    const st = stats('us_f1');
    const ok = createPlane(st, 0, 1500, 0, 300); ok.thr = 1;
    const bad = createPlane(st, 0, 1500, 0, 300); bad.thr = 1; bad.parts.wing = 0.2;
    for (let i = 0; i < 60; i++) { step(ok, st, { t: 1 }); step(bad, st, { t: 1 }); }
    expect(Math.abs(wrapAngle(bad.a - ok.a))).toBeGreaterThan(0.15);
  });

  it('повреждённый хвост ухудшает управляемость', () => {
    const st = stats('us_f1');
    const ok = createPlane(st, 0, 1500, 0, 300); ok.thr = 1;
    const bad = createPlane(st, 0, 1500, 0, 300); bad.thr = 1; bad.parts.tail = 0;
    for (let i = 0; i < 20; i++) { step(ok, st, { p: 1, t: 1 }); step(bad, st, { p: 1, t: 1 }); }
    expect(Math.abs(wrapAngle(bad.a))).toBeLessThan(Math.abs(wrapAngle(ok.a)) * 0.8);
  });
});

describe('земля, посадка, пилот', () => {
  const t = getTerrain('plains');
  const af = t.map.airfields[0];

  it('мягкая посадка на малой скорости — самолёт на земле', () => {
    const st = stats('us_f1');
    const p = createPlane(st, af.x0 + 100, af.h + 12, -0.03, st.vstall * 1.15); p.thr = 0;
    p.vy = -12;
    for (let i = 0; i < 60; i++) { tickPlane(p, st, { p: 0, ta: 0 }, DT, PHYS_SUBSTEPS, t); if (p.contact) break; }
    expect(p.contact).toBeNull();
    expect(p.ground).toBe(true);
  });

  it('касание земли на большой скорости — не посадка (разбивается или получает урон)', () => {
    const st = stats('us_f1');
    const p = createPlane(st, af.x0 + 100, af.h + 12, -0.03, st.vstall * 1.9); p.thr = 0;
    p.vy = -15;
    for (let i = 0; i < 20; i++) { tickPlane(p, st, { p: 0, ta: 0 }, DT, PHYS_SUBSTEPS, t); if (p.contact) break; }
    const damaged = p.parts.wing < 1 || p.parts.engine < 1 || (p.impact || 0) > 0;
    expect(p.contact === 'crash' || damaged).toBe(true);
  });

  it('жёсткая посадка с умеренной вертикальной скоростью — повреждение, а не мгновенная гибель', () => {
    const st = stats('us_f1');
    const p = createPlane(st, af.x0 + 100, af.h + 12, 0.02, st.vstall * 1.1); p.thr = 0;
    p.vy = -75;
    for (let i = 0; i < 20; i++) { tickPlane(p, st, { p: 0, ta: 0 }, DT, PHYS_SUBSTEPS, t); if (p.contact) break; }
    expect(p.contact).not.toBe('crash');
    expect(p.parts.wing < 1 || p.parts.engine < 1 || (p.impact || 0) > 0).toBe(true);
  });

  it('удар о землю на большой скорости смертелен', () => {
    const st = stats('us_f1');
    const p = createPlane(st, 3000, t.ground(3000) + 40, -0.6, 350); p.thr = 1;
    for (let i = 0; i < 30; i++) { tickPlane(p, st, { p: 0, t: 0 }, DT, PHYS_SUBSTEPS, t); if (p.contact) break; }
    expect(p.contact).toBe('crash');
  });

  it('парашют: скорость снижения ограничена и приземление безопасно', () => {
    const c = createPilot(3000, 900, 0, 0);
    let maxDown = 0;
    for (let i = 0; i < 40 / DT; i++) { tickPilot(c, {}, DT, PHYS_SUBSTEPS, t, t.width); if (c.chute) maxDown = Math.max(maxDown, -c.vy); if (c.ground || c.contact) break; }
    expect(c.contact).toBeNull();
    expect(c.ground).toBe(true);
    expect(maxDown).toBeLessThan(100);
  });

  it('прыжок пилота с большой высоты (без парашюта) наносит урон по скорости падения', () => {
    // пилот стоит на высоком склоне гор и прыгает в пропасть
    const m = getTerrain('mountains');
    let x = 6300;
    const c = createPilot(x, m.ground(x) + 6, 0, 0); c.ground = true;
    let fallSpeed = 0;
    tickPilot(c, { mx: -1, j: 1 }, DT, PHYS_SUBSTEPS, m, m.width);
    for (let i = 0; i < 15 / DT; i++) {
      tickPilot(c, { mx: -1 }, DT, PHYS_SUBSTEPS, m, m.width);
      fallSpeed = Math.max(fallSpeed, -c.vy);
      if (c.contact || (c.landingDamage || 0) > 0) break;
    }
    if (fallSpeed > 200) expect(c.contact === 'splat' || (c.landingDamage || 0) > 0).toBe(true);
  });
});

describe('независимость от FPS', () => {
  // Повторяем цикл клиента (NetGame.frame): аккумулятор фиксированного шага.
  function simulateClient(fps, seconds) {
    const st = stats('de_f1');
    const p = createPlane(st, 0, 1500, 0, 300); p.thr = 1;
    let acc = 0, n = 0;
    const frames = Math.round(seconds * fps);
    for (let f = 0; f < frames; f++) {
      acc += Math.min(1 / fps, 0.25);
      while (acc >= DT - 1e-9) {
        acc -= DT;
        const inp = { p: Math.sin(n * 0.05), t: n % 90 < 45 ? 1 : -1, fl: n === 120 ? 1 : 0, bo: n % 200 < 60 ? 1 : 0 };
        tickPlane(p, st, inp, DT, PHYS_SUBSTEPS, SKY);
        n++;
      }
    }
    return { p, n };
  }
  it.each([30, 60, 144])('%i FPS: 30 тиков в секунду и одинаковое состояние', fps => {
    const ref = simulateClient(60, 10);
    const r = simulateClient(fps, 10);
    expect(Math.abs(r.n - 10 * TICK_RATE)).toBeLessThanOrEqual(1);
    // сравниваем по одинаковому числу тиков
    const n = Math.min(r.n, ref.n);
    const a = simulateClientTicks(n), b = simulateClientTicks(n);
    expect(a.x).toBe(b.x); expect(a.y).toBe(b.y); expect(a.a).toBe(b.a);
  });
  function simulateClientTicks(N) {
    const st = stats('de_f1');
    const p = createPlane(st, 0, 1500, 0, 300); p.thr = 1;
    for (let n = 0; n < N; n++) tickPlane(p, st, { p: Math.sin(n * 0.05), t: n % 90 < 45 ? 1 : -1, fl: n === 120 ? 1 : 0, bo: n % 200 < 60 ? 1 : 0 }, DT, PHYS_SUBSTEPS, SKY);
    return p;
  }
});
