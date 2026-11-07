// Модель полёта и пешего пилота. Используется и сервером (авторитетная симуляция),
// и клиентом (предсказание своего самолёта + офлайн-тренировка).
import { GRAVITY, CEILING, clamp, wrapAngle } from './constants.js';

const STALL_ALPHA = 0.3;     // критический угол атаки (рад)
const CAMBER = 0.05;         // «изогнутость» профиля: на спине нужно больше угла атаки

// Эффективные характеристики самолёта с учётом улучшений.
export function buildStats(def, upgrades = {}, data) {
  const u = { engine: 0, armor: 0, damage: 0, ammo: 0, accuracy: 0, ...upgrades };
  const cd0 = def.thrust / (def.vmax * def.vmax);
  const st = {
    id: def.id, def,
    thrust: def.thrust * (1 + 0.06 * u.engine),
    cd0,
    vmax: def.vmax * Math.sqrt(1 + 0.06 * u.engine),
    vstall: def.vstall,
    turn: def.turn,
    corner: def.corner,
    boost: def.boost,
    size: def.size,
    maxHp: Math.round(def.hp * (1 + 0.1 * u.armor)),
    armor: Math.min(0.6, def.armor + 0.04 * u.armor),
    dmgMul: 1 + 0.08 * u.damage,
    ammoMul: 1 + 0.2 * u.ammo,
    spreadMul: 1 - 0.18 * u.accuracy,
    recoilMul: 1 - 0.2 * u.accuracy,
    guns: (def.guns || []).map(g => ({ ...g, ...(data ? { wd: data.weapons[g.w] } : {}) })),
    bombs: def.bombs ? { ...def.bombs, ...(data ? { bd: data.bombs[def.bombs.type] } : {}) } : null,
    rockets: def.rockets ? { ...def.rockets, ...(data ? { rd: data.rockets[def.rockets.type] } : {}) } : null,
    gunners: (def.gunners || []).map(g => ({ ...g, ...(data ? { wd: data.weapons[g.w] } : {}) })),
  };
  return st;
}

export function createPlane(st, x, y, angle, speed, onGround = false) {
  const up = Math.cos(angle) >= 0 ? 1 : -1;
  return {
    x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, a: angle,
    roll: up, rollT: up, thr: onGround ? 0.3 : 0.85, heat: 0, overheat: false, boosting: false,
    stall: 0, spin: 0, stallT: 0, ground: onGround, dead: false, deadSpin: 0,
    parts: { engine: 1, wing: 1, tail: 1, fuel: 1 }, contact: null,
  };
}

// Однократные (фронтовые) действия ввода: переворот.
export function applyPlaneEdges(p, inp) {
  if (inp.fl && !p.dead && !p.ground) p.rollT = p.rollT > 0 ? -1 : 1;
}

// Шаг физики самолёта. h — шаг времени, terrain — {ground(x), water(x)}.
export function stepPlane(p, st, inp, h, terrain) {
  p.contact = null;
  const G = GRAVITY;
  const alive = !p.dead;
  const pitch = alive ? clamp(+inp.p || 0, -1, 1) : p.deadSpin;

  // Газ и форсаж с перегревом.
  if (!alive) p.thr = 0;
  else if (typeof inp.ta === 'number' && isFinite(inp.ta)) p.thr += clamp(clamp(inp.ta, 0, 1) - p.thr, -0.9 * h, 0.9 * h);
  else p.thr = clamp(p.thr + clamp(+inp.t || 0, -1, 1) * 0.7 * h, 0, 1);
  const engineOk = p.parts.engine > 0.02;
  const boosting = alive && !!inp.bo && engineOk && !p.overheat && p.thr > 0.5;
  if (boosting) {
    p.heat += h / 7;
    if (p.heat >= 1) { p.heat = 1; p.overheat = true; }
  } else {
    p.heat = Math.max(0, p.heat - h / (p.overheat ? 9 : 6));
    if (p.overheat && p.heat < 0.35) p.overheat = false;
  }
  p.boosting = boosting;

  // Крен (переворот на спину): roll от -1 до 1, полный переворот ~0.4 с.
  p.roll += clamp(p.rollT - p.roll, -5 * h, 5 * h);
  const up = p.roll >= 0 ? 1 : -1;
  const rollF = Math.abs(p.roll);

  const v = Math.hypot(p.vx, p.vy);
  const gamma = v > 1 ? Math.atan2(p.vy, p.vx) : p.a;
  const alpha = wrapAngle(p.a - gamma);
  const vs = st.vstall;

  // Подъёмная сила: зависит от квадрата скорости и угла атаки; за критическим углом — срыв.
  const ae = alpha + CAMBER * up * rollF;
  const aa = Math.abs(ae);
  let cl = aa <= STALL_ALPHA ? ae / STALL_ALPHA : Math.sign(ae) * Math.max(0.3, 1 - (aa - STALL_ALPHA) * 1.6);
  const wingF = 0.55 + 0.45 * p.parts.wing;
  const liftK = G / (vs * vs);
  let L = liftK * v * v * cl * (0.15 + 0.85 * rollF) * wingF;
  if (p.stall) L *= p.spin ? 0.15 : 0.5;
  L = clamp(L, -9 * G, 9 * G);
  let ax = -Math.sin(gamma) * L, ay = Math.cos(gamma) * L;

  // Сопротивление: паразитное + индуктивное + «плоская пластина» на больших углах.
  const sa = Math.sin(alpha);
  const D = st.cd0 * v * v + 0.2 * Math.abs(L * cl) + liftK * 0.45 * sa * sa * v * v;
  ax -= Math.cos(gamma) * D; ay -= Math.sin(gamma) * D;

  // Тяга (винт эффективнее на малой скорости, падает за потолком).
  let T = 0;
  if (alive && engineOk) {
    T = st.thrust * p.thr * (0.35 + 0.65 * p.parts.engine) * (boosting ? st.boost : 1);
    T *= 1 + 0.35 * Math.max(0, 1 - v / st.vmax);
    if (p.y > CEILING) T *= clamp(1 - (p.y - CEILING) / 500, 0, 1);
  }
  ax += Math.cos(p.a) * T; ay += Math.sin(p.a) * T;
  ay -= G;

  // Вращение: лучший разворот на «угловой» скорости, на большой — хуже, на малой — вяло.
  const ctrl = clamp((v / vs) * (v / vs), 0.12, 1) * (0.35 + 0.65 * p.parts.tail) * (alive ? 1 : 0.3);
  const vc = st.corner;
  const maxRot = st.turn * (v < vc ? 0.4 + 0.6 * v / vc : Math.pow(vc / v, 0.8));
  const align = 1 + 2 * Math.min(v / vs, 2);
  let da = pitch * maxRot * ctrl * (0.4 + 0.6 * rollF) - alpha * align;
  da += -(1 - p.parts.wing) * 0.6 * up;            // повреждённое крыло тянет самолёт
  if (p.stall) {
    if (p.spin) da = p.spin * 4.2;                  // штопор
    else da += clamp(wrapAngle(-Math.PI / 2 - p.a), -1, 1) * 1.4; // нос опускается
  }
  p.a = wrapAngle(p.a + da * h);

  p.vx += ax * h; p.vy += ay * h;
  p.x += p.vx * h; p.y += p.vy * h;

  // Сваливание и штопор.
  if (!p.ground) {
    if (!p.stall && (v < vs * 0.68 || (Math.abs(ae) > 1.0 && v < vs * 1.3))) {
      p.stall = 1; p.stallT = 0;
      p.spin = Math.abs(pitch) > 0.6 ? Math.sign(pitch) : 0;
    } else if (p.stall) {
      p.stallT += h;
      if (p.spin && (p.stallT > 2.5 || (Math.abs(pitch) < 0.2 && v > vs))) p.spin = 0;
      if (!p.spin && v > vs && Math.abs(alpha) < 0.5) p.stall = 0;
    }
  }

  // Контакт с землёй / водой.
  const gy = terrain.ground(p.x);
  const clearance = 5 * st.size;
  if (p.y - clearance <= gy) {
    if (terrain.water(p.x)) { p.contact = 'water'; return; }
    const pa = up > 0 ? p.a : wrapAngle(Math.PI - p.a);   // тангаж относительно горизонта
    const slope = (terrain.ground(p.x + 12) - terrain.ground(p.x - 12)) / 24;
    const facingOk = Math.sign(p.vx || up) === up || v < 20;
    const gentle = alive && facingOk && (p.ground || (p.vy > -55 && v < vs * 2 && pa > -0.22 && pa < 0.5 && rollF > 0.8 && Math.abs(slope) < 0.3));
    if (!gentle) { p.contact = 'crash'; return; }
    p.ground = true;
    p.y = gy + clearance;
    if (p.vy < 0) p.vy = 0;
    const fr = (p.thr < 0.05 ? 110 : 10) * h;
    p.vx = Math.sign(p.vx) * Math.max(0, Math.abs(p.vx) - fr);
    if (pa < 0) p.a = up > 0 ? 0 : Math.PI;
    else if (pa > 0.5) p.a = up > 0 ? 0.5 : Math.PI - 0.5;
    p.stall = 0; p.spin = 0;
    if (Math.abs(slope) > 0.9 && v > 60) p.contact = 'crash';
  } else if (p.y - clearance > gy + 3) {
    p.ground = false;
  }
}

// Полный шаг тика с подшагами.
export function tickPlane(p, st, inp, dt, substeps, terrain) {
  applyPlaneEdges(p, inp);
  const h = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    stepPlane(p, st, inp, h, terrain);
    if (p.contact === 'crash' || p.contact === 'water') break;
  }
}

// ---------- Пеший пилот ----------
export function createPilot(x, y, vx, vy) {
  return { x, y, vx, vy, ground: false, chute: false, chuteT: 0, swim: false, aim: 0, contact: null };
}

export function stepPilot(c, inp, h, terrain) {
  c.contact = null;
  const G = GRAVITY;
  const mx = clamp(+inp.mx || 0, -1, 1);
  if (typeof inp.aim === 'number' && isFinite(inp.aim)) c.aim = wrapAngle(inp.aim);
  const gy = terrain.ground(c.x);
  const water = terrain.water(c.x);
  if (!c.ground && !c.swim) {
    c.chuteT += h;
    if (!c.chute && c.chuteT > 0.6) c.chute = true;
    c.vy -= G * h;
    if (c.chute) {
      c.vy = Math.max(c.vy, -55);
      if (c.vy < -55) c.vy = -55;
      c.vx += (mx * 60 - c.vx) * Math.min(1, 1.2 * h);
    } else {
      c.vy = Math.max(c.vy, -420);
      c.vx *= 1 - 0.3 * h;
    }
    c.x += c.vx * h; c.y += c.vy * h;
    if (c.y <= gy + 6) {
      if (water) { c.swim = true; c.y = gy; c.vy = 0; c.chute = false; }
      else {
        if (c.vy < -160) { c.contact = 'splat'; return; }
        c.ground = true; c.chute = false; c.y = gy + 6; c.vy = 0;
      }
    }
  } else if (c.swim) {
    c.vx = mx * 30; c.x += c.vx * h;
    const ng = terrain.ground(c.x);
    if (!terrain.water(c.x)) { c.swim = false; c.ground = true; c.y = ng + 6; }
    else c.y = ng;
  } else {
    // на земле: бег и прыжок
    c.vx = mx * 80;
    if (inp.j) { c.vy = 175; c.ground = false; c.chute = false; c.jumping = true; }
    c.x += c.vx * h;
    if (c.ground) {
      const ng = terrain.ground(c.x);
      if (ng - c.y + 6 > 22) { c.x -= c.vx * h; c.vx = 0; }   // слишком крутой склон
      else c.y = terrain.ground(c.x) + 6;
      if (terrain.water(c.x)) { c.swim = true; c.ground = false; c.y = terrain.ground(c.x); }
    }
  }
}

export function tickPilot(c, inp, dt, substeps, terrain, width) {
  const h = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    // прыжок без парашюта: не раскрываем купол
    if (c.jumping && !c.ground) {
      c.vy -= GRAVITY * h; c.x += c.vx * h; c.y += c.vy * h;
      const gy = terrain.ground(c.x);
      if (c.y <= gy + 6) {
        if (terrain.water(c.x)) { c.swim = true; c.y = gy; } else { c.ground = true; c.y = gy + 6; }
        c.vy = 0; c.jumping = false;
      }
      if (inp.j) inp = { ...inp, j: 0 };
      continue;
    }
    stepPilot(c, inp, h, terrain);
    inp = { ...inp, j: 0 };
    if (c.contact) break;
  }
  if (width) c.x = clamp(c.x, 5, width - 5);
}

// Сжатая сериализация своего самолёта (для сверки клиента с сервером).
export function packPlane(p) {
  return [r1(p.x), r1(p.y), r2(p.vx), r2(p.vy), r3(p.a), r3(p.roll), p.rollT, r3(p.thr), r3(p.heat),
    p.overheat ? 1 : 0, p.stall, p.spin, r3(p.stallT), p.ground ? 1 : 0, p.dead ? 1 : 0,
    r3(p.parts.engine), r3(p.parts.wing), r3(p.parts.tail), r3(p.parts.fuel), p.boosting ? 1 : 0];
}
export function unpackPlane(a, p = {}) {
  p.x = a[0]; p.y = a[1]; p.vx = a[2]; p.vy = a[3]; p.a = a[4]; p.roll = a[5]; p.rollT = a[6]; p.thr = a[7];
  p.heat = a[8]; p.overheat = !!a[9]; p.stall = a[10]; p.spin = a[11]; p.stallT = a[12]; p.ground = !!a[13];
  p.dead = !!a[14]; p.parts = { engine: a[15], wing: a[16], tail: a[17], fuel: a[18] }; p.boosting = !!a[19];
  p.deadSpin = p.deadSpin || 0; p.contact = null;
  return p;
}
export function packPilot(c) {
  return [r1(c.x), r1(c.y), r2(c.vx), r2(c.vy), c.ground ? 1 : 0, c.chute ? 1 : 0, r3(c.chuteT), c.swim ? 1 : 0, c.jumping ? 1 : 0, r3(c.aim)];
}
export function unpackPilot(a, c = {}) {
  c.x = a[0]; c.y = a[1]; c.vx = a[2]; c.vy = a[3]; c.ground = !!a[4]; c.chute = !!a[5]; c.chuteT = a[6];
  c.swim = !!a[7]; c.jumping = !!a[8]; c.aim = a[9]; c.contact = null;
  return c;
}
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
