// ИИ-пилоты: воздушный бой, атака наземных целей, уход от земли и сваливания. 3 уровня сложности.
import { CEILING, GRAVITY, clamp, wrapAngle } from '../shared/constants.js';

const NAMES = ['Сокол', 'Беркут', 'Ястреб', 'Кречет', 'Стриж', 'Гром', 'Буран', 'Вихрь', 'Ворон', 'Филин', 'Шторм', 'Молот',
  'Ace', 'Maverick', 'Baron', 'Viper', 'Ghost', 'Hawk', 'Raven', 'Blaze'];
export function botName(i) { return '[BOT] ' + NAMES[(i * 7 + Math.floor(Math.random() * NAMES.length)) % NAMES.length]; }

const DIFF = [
  { aim: 0.16, react: 0.75, lead: 0.55, cone: 0.16, range: 520, turn: 0.75, evade: 0.3, wobble: 0.5, boost: 0.3 },
  { aim: 0.07, react: 0.4, lead: 0.85, cone: 0.11, range: 640, turn: 0.9, evade: 0.6, wobble: 0.25, boost: 0.6 },
  { aim: 0.025, react: 0.18, lead: 1.0, cone: 0.08, range: 760, turn: 1.0, evade: 0.9, wobble: 0.1, boost: 0.9 },
];

export function botThink(g, u, dt) {
  const b = u.bot;
  const D = DIFF[b.diff] || DIFF[1];
  if (b.reset) { b.reset = false; b.target = null; b.ground = null; b.retarget = 0; b.ejectT = 0; b.noise = 0; b.flipCD = 0; b.plan = null; }
  if (u.state === 'pilot') return pilotThink(g, u, b, D);
  if (u.state !== 'plane') return null;
  const pl = g.planes.get(u.planeEid);
  if (!pl) return null;
  const p = pl.p, st = pl.st, pc = pl.pc, t = g.terrain;
  const inp = { p: 0, ta: 1, f: 0 };

  // сбит — прыгаем с парашютом
  if (p.dead || pc.hp <= 0) {
    b.ejectT = (b.ejectT || 0) + dt;
    if (b.ejectT > D.react + 0.4) inp.e = 1;
    return inp;
  }

  const v = Math.hypot(p.vx, p.vy);
  const vs = st.vstall;
  const dirX = p.vx >= 0 ? 1 : -1;
  b.noise = (b.noise || 0) + (Math.random() - 0.5) * dt * 4 * D.wobble;
  b.noise *= 1 - dt * 1.5;
  b.flipCD = Math.max(0, (b.flipCD || 0) - dt);

  // взлёт с полосы
  if (p.ground) {
    inp.ta = 1;
    const want = (p.rollT > 0 ? 0 : Math.PI);
    if (v > vs * 1.25) inp.p = clamp(wrapAngle((p.rollT > 0 ? 0.3 : Math.PI - 0.3) - p.a) * 3, -1, 1);
    else inp.p = clamp(wrapAngle(want - p.a) * 2, -1, 1);
    return inp;
  }

  let desired = null, urgent = false, fire = false;

  // 1. земля впереди
  let groundAhead = -1e9;
  for (let k = 0.4; k <= 3; k += 0.5) groundAhead = Math.max(groundAhead, t.ground(p.x + p.vx * k));
  const futureY = p.y + p.vy * 1.6 - (p.vy < 0 ? 0 : 0);
  const alt = p.y - t.ground(p.x);
  if (futureY < groundAhead + 130 || alt < 110) { desired = dirX > 0 ? 0.75 : Math.PI - 0.75; urgent = true; }

  // 2. сваливание
  if (!urgent && (p.stall || v < vs * 1.12)) {
    desired = dirX > 0 ? -0.45 : Math.PI + 0.45;
    if (p.spin) inp.p = 0;
    urgent = alt > 250;
    if (p.spin) return { p: 0, ta: 1 };
  }

  // 3. потолок / границы карты
  if (!urgent && p.y > CEILING - 150) desired = dirX > 0 ? -0.25 : Math.PI + 0.25;
  if (!urgent && (p.x < 350 || p.x > t.width - 350)) {
    const toRight = p.x < 350;
    desired = toRight ? 0.25 : Math.PI - 0.25;
    urgent = p.x < 0 || p.x > t.width;
  }

  // 3б. предотвращение столкновений с любыми самолётами
  if (!urgent) {
    for (const o of g.planes.values()) {
      if (o === pl) continue;
      const rx = o.p.x - p.x, ry = o.p.y - p.y, d = Math.hypot(rx, ry);
      if (d > 800 || d < 1) continue;
      const closing = -((o.p.vx - p.vx) * rx + (o.p.vy - p.vy) * ry) / d;
      // проверяем минимальную дистанцию на траектории сближения
      const rvx = o.p.vx - p.vx, rvy = o.p.vy - p.vy, rv2 = rvx * rvx + rvy * rvy || 1;
      const tmin = -(rx * rvx + ry * rvy) / rv2;
      const miss = Math.hypot(rx + rvx * tmin, ry + rvy * tmin);
      if (closing > 0 && tmin > 0 && tmin < 1.3 && miss < 45 * (st.size + o.st.size)) {
        // расходимся по высоте: тот, кто выше, уходит вверх
        const upward = ry < 0 || alt < 350;
        desired = (dirX > 0 ? 0 : Math.PI) + dirX * (upward ? 0.9 : -0.9);
        return finish(inp, desired, p, true, D, b, v, vs);
      }
    }
  }

  // 4. бой
  if (!urgent) {
    b.retarget -= dt;
    if (b.retarget <= 0 || (b.target && (!g.planes.has(b.target.eid) || b.target.p.dead || !b.target.owner))) {
      b.retarget = 1.5 + Math.random() * 1.5;
      b.target = pickAirTarget(g, u, pl);
      b.ground = pickGroundTarget(g, u, pl);
    }
    const role = st.def.class;
    const air = b.target && g.planes.has(b.target.eid) ? b.target : null;
    const gt = b.ground && b.ground.hp > 0 ? b.ground : null;
    const airDist = air ? Math.hypot(air.p.x - p.x, air.p.y - p.y) : 1e9;
    const preferGround = gt && (role === 'bomber' || (role === 'attacker' && airDist > 500) || (!air) || (g.mode === 'base' && role !== 'fighter' && airDist > 350));

    // уклонение от противника на хвосте
    const threat = findThreat(g, u, pl);
    if (threat && Math.random() < D.evade) {
      const side = wrapAngle(Math.atan2(threat.p.y - p.y, threat.p.x - p.x) - p.a) > 0 ? -1 : 1;
      desired = p.a + side * 1.4;
      if (alt < 400) desired = dirX > 0 ? 0.6 : Math.PI - 0.6;
      if (p.heat < 0.6) inp.bo = Math.random() < D.boost ? 1 : 0;
    } else if (preferGround) {
      const r = attackGround(g, u, pl, gt, D, b);
      desired = r.desired; fire = r.fire; if (r.bomb) inp.b = 1; if (r.rocket) inp.r = 1;
    } else if (air) {
      const w = st.guns[0] ? st.guns[0].wd : { speed: 900 };
      // упреждение
      const rx = air.p.x - p.x, ry = air.p.y - p.y;
      let tt = Math.hypot(rx, ry) / w.speed;
      let ax = rx, ay = ry;
      for (let k = 0; k < 2; k++) { ax = rx + (air.p.vx - p.vx) * tt * D.lead; ay = ry + (air.p.vy - p.vy) * tt * D.lead; tt = Math.hypot(ax, ay) / w.speed; }
      desired = Math.atan2(ay, ax) + b.noise * D.aim * 3;
      const off = Math.abs(wrapAngle(desired - p.a));
      const d = Math.hypot(ax, ay);
      fire = d < D.range && off < D.cone + 18 / Math.max(80, d);
      // не врезаться в цель: при встречном сближении уходим вверх/вниз
      const closing = ((air.p.vx - p.vx) * rx + (air.p.vy - p.vy) * ry) / Math.max(1, airDist);
      if (airDist < 90 + Math.max(0, -closing) * 0.35) { desired = p.a + (alt > 300 && ry > 0 ? -0.9 : 0.9); fire = false; }
      if (airDist > 900 && p.heat < 0.5 && Math.random() < D.boost) inp.bo = 1;
      // не пикировать в землю за целью
      if (alt < 260 && Math.sin(desired) < -0.2) desired = dirX > 0 ? -0.05 : Math.PI + 0.05;
    } else {
      // патруль: набираем высоту в сторону центра
      const cx = t.width / 2;
      const toRight = Math.abs(p.x - cx) < 1500 ? dirX > 0 : p.x < cx;
      const wantAlt = t.ground(p.x) + 700;
      desired = (toRight ? 0 : Math.PI) + (toRight ? 1 : -1) * clamp((wantAlt - p.y) / 800, -0.4, 0.4);
    }
  }
  if (desired === null) desired = p.a;
  inp.f = fire ? 1 : 0;
  return finish(inp, desired, p, urgent, D, b, v, vs);
}

function finish(inp, desired, p, urgent, D, b, v, vs) {
  // ход ручкой: рассогласование -> тангаж
  const err = wrapAngle(desired - p.a);
  inp.p = clamp(err * 3.2 * D.turn, -1, 1);
  if (urgent) inp.p = clamp(err * 5, -1, 1);
  // на малой скорости не тянем ручку до упора
  if (v < vs * 1.3 && !urgent) inp.p *= 0.6;
  inp.ta = 1;
  // держим «живот» к земле
  const wantRoll = Math.cos(p.a) >= 0 ? 1 : -1;
  if (b.flipCD <= 0 && p.rollT !== wantRoll && Math.abs(Math.cos(p.a)) > 0.45) { inp.fl = 1; b.flipCD = 0.8 + D.react; }
  return inp;
}

function pickAirTarget(g, u, pl) {
  let best = null, bs = 1e9;
  for (const o of g.planes.values()) {
    if (!o.owner || o.p.dead || !g.hostile(u, o.owner) || o.protect > 0) continue;
    if (o.p.inCloud) continue;    // в облаках бот теряет цель
    const dx = o.p.x - pl.p.x, dy = o.p.y - pl.p.y;
    const d = Math.hypot(dx, dy);
    if (d > 3200) continue;
    const ang = Math.abs(wrapAngle(Math.atan2(dy, dx) - pl.p.a));
    const s = d * (1 + ang * 0.6) * (o.owner.isBot ? 1.15 : 1);
    if (s < bs) { bs = s; best = o; }
  }
  return best;
}

function pickGroundTarget(g, u, pl) {
  let best = null, bs = 1e9;
  for (const o of g.ground.objs) {
    if (o.hp <= 0 || o.team === u.team || o.team === -1 && g.teams) continue;
    if (u.team < 0 && o.team === -1 && o.type === 'building') continue;
    let d = Math.abs(o.x - pl.p.x);
    if (o.type === 'hq') d *= pl.st.def.class === 'bomber' ? 0.3 : 0.7;
    if (o.type === 'aa') d *= 0.8;
    if (d < bs && d < 6000) { bs = d; best = o; }
  }
  return best;
}

function findThreat(g, u, pl) {
  for (const o of g.planes.values()) {
    if (!o.owner || o.p.dead || !g.hostile(u, o.owner)) continue;
    const dx = pl.p.x - o.p.x, dy = pl.p.y - o.p.y, d = Math.hypot(dx, dy);
    if (d > 420 || d < 30) continue;
    // противник смотрит на нас, мы — от него
    const theirOff = Math.abs(wrapAngle(Math.atan2(dy, dx) - o.p.a));
    const ourOff = Math.abs(wrapAngle(Math.atan2(-dy, -dx) - pl.p.a));
    if (theirOff < 0.35 && ourOff > 1.8) return o;
  }
  return null;
}

function attackGround(g, u, pl, gt, D, b) {
  const p = pl.p, st = pl.st, pc = pl.pc, t = g.terrain;
  const dx = gt.x - p.x;
  const ty = gt.y + gt.h * 0.5;
  const dirX = p.vx >= 0 ? 1 : -1;
  const res = { desired: null, fire: false, bomb: false, rocket: false };
  const groundY = t.ground(p.x);
  if (pc.bombs > 0 && (st.def.class === 'bomber' || pc.rockets === 0 && st.guns.length === 0 || st.def.class !== 'fighter' && Math.abs(dx) > 400)) {
    // горизонтальное бомбометание
    const wantAlt = Math.max(gt.y + (st.def.class === 'bomber' ? 520 : 320), t.ground(gt.x) + 300);
    const toward = dx >= 0 ? 0 : Math.PI;
    if (Math.sign(dx) !== dirX && Math.abs(dx) < 900) {
      // пролетели — разворот на дистанции
      res.desired = dirX > 0 ? 0.3 : Math.PI - 0.3;
      if (Math.abs(dx) > 600) res.desired = toward + (dx >= 0 ? 0.5 : -0.5);
    } else {
      res.desired = toward + (dx >= 0 ? 1 : -1) * clamp((wantAlt - p.y) / 600, -0.35, 0.35);
    }
    // точка падения бомбы
    const h = p.y - ty;
    if (h > 40) {
      const vy = p.vy - 15;
      const tf = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * h)) / GRAVITY;
      const impactX = p.x + p.vx * tf * 0.97;
      if (Math.abs(impactX - gt.x) < Math.max(20, gt.w * 0.5) + 10 * (2 - b.diff)) res.bomb = true;
    }
    return res;
  }
  // штурмовка: пологое пикирование с огнём и ракетами
  const dist = Math.hypot(dx, ty - p.y);
  const ang = Math.atan2(ty - p.y, dx);
  const alt = p.y - groundY;
  if (Math.sign(dx) !== dirX || dist < 160 || alt < 150) {
    // выход из атаки и заход на новый круг
    res.desired = dirX > 0 ? 0.55 : Math.PI - 0.55;
    if (Math.abs(dx) > 1200) res.desired = (dx > 0 ? 0 : Math.PI) + (dx > 0 ? 0.25 : -0.25);
    return res;
  }
  if (dist > 1100 || Math.sin(ang) > -0.15) {
    // выход на рубеж атаки: держим высоту ~500
    const wantAlt = groundY + 520;
    res.desired = (dx > 0 ? 0 : Math.PI) + (dx > 0 ? 1 : -1) * clamp((wantAlt - p.y) / 500, -0.3, 0.3);
    return res;
  }
  res.desired = ang + b.noise * D.aim * 2;
  const off = Math.abs(wrapAngle(ang - p.a));
  if (off < 0.12 && dist < 700) res.fire = true;
  if (off < 0.08 && dist < 650 && pc.rockets > 0 && Math.random() < 0.25) res.rocket = true;
  if (pc.bombs > 0 && dist < 260 && off < 0.25) res.bomb = true;
  return res;
}

function pilotThink(g, u, b, D) {
  const c = u.pilot;
  const inp = { mx: 0, aim: Math.PI / 2, f: 0 };
  if (!c.ground && !c.swim) return inp;
  // к ближайшему своему аэродрому
  let best = null, bd = 1e9;
  for (const a of g.map.airfields) {
    if (u.team >= 0 && a.team !== u.team) continue;
    const d = Math.abs((a.x0 + a.x1) / 2 - c.x);
    if (d < bd) { bd = d; best = a; }
  }
  if (best) {
    if (c.x < best.x0 + 20) inp.mx = 1; else if (c.x > best.x1 - 20) inp.mx = -1;
    else if (g.rules.canRespawn(g, u, true)) inp.e = 1;
  }
  if (g.settings.respawnMode === 'timer' && u.pilotRespawnT <= 0 && bd > 600) inp.e = 1;
  // стреляем по низколетящим врагам
  for (const pl of g.planes.values()) {
    if (!pl.owner || pl.p.dead || !g.hostile(u, pl.owner)) continue;
    const dx = pl.p.x - c.x, dy = pl.p.y - c.y;
    if (Math.hypot(dx, dy) < 380) { inp.aim = Math.atan2(dy + pl.p.vy * 0.4, dx + pl.p.vx * 0.4); inp.f = 1; break; }
  }
  return inp;
}
