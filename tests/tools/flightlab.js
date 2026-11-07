// «Лётная лаборатория»: детерминированные замеры лётных характеристик по общей модели полёта.
// Используется тестами реалистичности и скриптом отчёта (tests/tools/flight-report.mjs).
import fs from 'fs';
import { DT, PHYS_SUBSTEPS, GRAVITY, clamp, wrapAngle } from '../../shared/constants.js';
import { buildStats, createPlane, tickPlane } from '../../shared/physics.js';

export const DATA = JSON.parse(fs.readFileSync(new URL('../../shared/planes.json', import.meta.url), 'utf8'));
export const MAXUP = { engine: 3, armor: 3, damage: 3, ammo: 3, accuracy: 3 };
// Бесконечно высокое небо без земли — для замеров в воздухе.
export const SKY = { ground: () => -1e7, water: () => false, raw: () => -1e7 };

export function def(id) { return DATA.planes.find(p => p.id === id); }
export function stats(id, ups = {}) { return buildStats(def(id), ups, DATA); }

const speed = p => Math.hypot(p.vx, p.vy);
const path = p => Math.atan2(p.vy, p.vx);

// Держим высоту/эшелон между 800 и 2200, не меняя скорость (поправка за потолок не нужна).
function keepBand(p) { if (p.y > 2200) p.y -= 1200; if (p.y < 800) p.y += 1200; }

function step(p, st, inp, terrain = SKY) { tickPlane(p, st, inp, DT, PHYS_SUBSTEPS, terrain); }

// Максимальная скорость в горизонте (полный газ, при желании — форсаж).
export function maxLevelSpeed(st, boost = false, secs = 70) {
  const p = createPlane(st, 0, 1500, 0, st.vmax * 0.9); p.thr = 1;
  let heatGuard = 0;
  for (let i = 0; i < secs / DT; i++) {
    const pitch = clamp(-p.vy * 0.02 + wrapAngle(0 - path(p)) * 2, -1, 1);
    // форсаж ограничен перегревом — для «паспортной» скорости с форсажем охлаждение не моделируем
    if (boost) { p.heat = 0; p.overheat = false; }
    step(p, st, { p: pitch, t: 1, bo: boost ? 1 : 0 });
    keepBand(p); heatGuard++;
  }
  return speed(p);
}

// Установившаяся скороподъёмность при заданной приборной скорости V.
export function climbRateAt(st, V, secs = 45) {
  const p = createPlane(st, 0, 1200, 0.2, V); p.thr = 1;
  let gam = 0.2, sum = 0, n = 0, stalled = false;
  for (let i = 0; i < secs / DT; i++) {
    const v = speed(p);
    gam = clamp(gam + clamp((v - V) * 0.0025, -0.03, 0.03), -0.4, 1.55);
    const pitch = clamp(wrapAngle(gam - path(p)) * 3 + wrapAngle(gam - p.a) * 0.8, -1, 1);
    step(p, st, { p: pitch, t: 1 });
    if (p.stall) stalled = true;
    keepBand(p);
    if (i * DT > secs - 12) { sum += p.vy; n++; }
  }
  return { vy: sum / n, stalled, gamma: gam };
}

// Лучшая скороподъёмность по сетке скоростей.
export function bestClimb(st) {
  let best = { vy: -1e9, V: 0 };
  for (let k = 1.15; k <= 3.2; k += 0.15) {
    const V = st.vstall * k;
    if (V > st.vmax * 0.95) break;
    const r = climbRateAt(st, V);
    if (!r.stalled && r.vy > best.vy) best = { vy: r.vy, V, gamma: r.gamma };
  }
  return best;
}

// Попытка вертикального подъёма: держим нос строго вверх на полном газе (опционально — форсаж без перегрева).
export function verticalClimb(st, secs = 60, boostNoHeat = false) {
  const p = createPlane(st, 0, 1000, Math.PI / 2, st.vmax * 0.9); p.thr = 1;
  let minV = 1e9, stallAt = null, climbed = 0;
  for (let i = 0; i < secs / DT; i++) {
    if (boostNoHeat) { p.heat = 0; p.overheat = false; }
    const pitch = clamp(wrapAngle(Math.PI / 2 - p.a) * 4, -1, 1);
    const y0 = p.y;
    step(p, st, { p: pitch, t: 1, bo: boostNoHeat ? 1 : 0 });
    climbed += p.y - y0;
    keepBand(p);
    const v = speed(p);
    if (i * DT > 2) minV = Math.min(minV, v);
    if (p.stall && stallAt === null) stallAt = i * DT;
  }
  return { finalV: speed(p), minV, stallAt, climbed, finalStall: !!p.stall };
}

// Пикирование отвесно: установившаяся скорость.
export function diveSpeed(st, throttle = 1, secs = 25) {
  const p = createPlane(st, 0, 2000, -Math.PI / 2, st.vmax * 0.8); p.thr = throttle;
  for (let i = 0; i < secs / DT; i++) {
    const pitch = clamp(wrapAngle(-Math.PI / 2 - p.a) * 4, -1, 1);
    step(p, st, { p: pitch, ta: throttle });
    keepBand(p);
  }
  return speed(p);
}

// Время полного круга (петли в вертикальной плоскости) при полной ручке со скорости V.
export function loopTime(st, V, secs = 30) {
  const p = createPlane(st, 0, 1500, 0, V); p.thr = 1;
  let turned = 0, prev = path(p), minV = 1e9;
  for (let i = 0; i < secs / DT; i++) {
    step(p, st, { p: 1, t: 1 });
    keepBand(p);
    const g = path(p);
    turned += wrapAngle(g - prev); prev = g;
    minV = Math.min(minV, speed(p));
    if (Math.abs(turned) >= Math.PI * 2) return { time: (i + 1) * DT, minV, finalV: speed(p), stalled: !!p.stall };
  }
  return { time: Infinity, minV, finalV: speed(p), stalled: !!p.stall };
}

// Лучшее время петли по сетке начальных скоростей.
export function bestLoop(st) {
  let best = { time: Infinity, V: 0 };
  for (let k = 1.3; k <= 3.4; k += 0.15) {
    const V = st.vstall * k;
    if (V > st.vmax * 1.05) break;
    const r = loopTime(st, V);
    if (r.time < best.time) best = { ...r, V };
  }
  return best;
}

// Угловая скорость разворота траектории в первые 1.5 с полной ручки на скорости V (рад/с).
export function turnRateAt(st, V) {
  const p = createPlane(st, 0, 1500, 0, V); p.thr = 1;
  // компенсируем гравитацию: меряем на «нулевой» перегрузке Земли (горизонтальный вираж в 2D невозможен)
  const g0 = path(p);
  const N = Math.round(1.5 / DT);
  let turned = 0, prev = g0;
  for (let i = 0; i < N; i++) {
    step(p, st, { p: 1, t: 1 });
    const g = path(p); turned += wrapAngle(g - prev); prev = g;
  }
  return turned / (N * DT);
}

// Время разгона в горизонте от v0 до v1 (полный газ).
export function accelTime(st, v0k = 0.5, v1k = 0.9, boost = false) {
  const p = createPlane(st, 0, 1500, 0, st.vmax * v0k); p.thr = 1;
  for (let i = 0; i < 120 / DT; i++) {
    const pitch = clamp(-p.vy * 0.02 + wrapAngle(0 - path(p)) * 2, -1, 1);
    if (boost) { p.heat = 0; p.overheat = false; }
    step(p, st, { p: pitch, t: 1, bo: boost ? 1 : 0 });
    keepBand(p);
    if (speed(p) >= st.vmax * v1k) return (i + 1) * DT;
  }
  return Infinity;
}

// Скорость, при которой наступает сваливание при плавном торможении в горизонте (газ 0).
export function stallSpeed(st) {
  const p = createPlane(st, 0, 1500, 0, st.vstall * 1.6); p.thr = 0;
  for (let i = 0; i < 60 / DT; i++) {
    const pitch = clamp(-p.vy * 0.03 + wrapAngle(0 - path(p)) * 2, -1, 1);
    const v = speed(p);
    step(p, st, { p: pitch, ta: 0 });
    keepBand(p);
    if (p.stall) return v;
  }
  return null;
}

export { speed, path, step, GRAVITY };
