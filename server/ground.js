// Наземные объекты: штабы, ангары, здания, ПВО, артиллерия, танки. Их ИИ и разрушение.
import { GRAVITY, clamp, wrapAngle } from '../shared/constants.js';

const TYPES = {
  hq:        { hp: 4000, w: 100, h: 45, solid: true, respawn: 0 },
  hangar:    { hp: 320, w: 80, h: 40, solid: true, respawn: 60 },
  building:  { hp: 180, w: 60, h: 80, solid: true, respawn: 75 },
  aa:        { hp: 130, w: 32, h: 22, respawn: 50 },
  artillery: { hp: 120, w: 36, h: 18, respawn: 55 },
  tank:      { hp: 170, w: 40, h: 24, respawn: 40 },
};

function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

export class GroundForces {
  constructor(game) {
    this.g = game;
    this.objs = [];
    this.seq = 1;
    this.tankTimer = [8, 8];
    this.ready = false;
    const mode = game.mode;
    for (const o of game.map.objects) {
      if (o.type === 'hq' && mode !== 'base') continue;
      if ((o.type === 'tank' || o.type === 'artillery') && mode !== 'base' && mode !== 'tdm') continue;
      let team = o.team ?? -1;
      if (mode === 'br' && o.type === 'aa') team = -2;      // в королевской битве ПВО бьёт всех
      if (mode === 'dm' && o.type === 'aa') team = -1;      // в DM зенитки нейтральны (мишени)
      this.add(o.type, team, o.x);
    }
    this.ready = true;
  }

  add(type, team, x) {
    const T = TYPES[type];
    let w = T.w, h = T.h;
    if (type === 'building') { w = 44 + hash(x * 13.7) * 30; h = 40 + hash(x * 3.1) * 60 + 16; }
    const o = {
      gid: this.seq++, type, team, x, x0: x, y: this.g.terrain.ground(x), w, h, hp: T.hp, maxHp: T.hp,
      reload: 1 + Math.random() * 2, mgT: 0, dir: type === 'aa' ? Math.PI / 2 : type === 'artillery' ? 0.7 : 0.05,
      face: team === 1 ? -1 : 1, deadT: 0, solid: !!T.solid,
    };
    if (type === 'artillery' && team === 1) o.dir = Math.PI - 0.7;
    this.objs.push(o);
    // объект, появившийся во время матча (волна танков), объявляем клиентам
    if (this.ready) this.g.events.push(['gadd', this.info(o)]);
    return o;
  }

  info(o) { return { gid: o.gid, type: o.type, team: o.team, x: o.x, y: o.y, w: o.w, h: o.h, maxHp: o.maxHp }; }
  staticInfo() { return this.objs.map(o => this.info(o)); }

  snapshot() {
    const out = [];
    for (const o of this.objs) out.push([o.gid, Math.max(0, Math.round(o.hp)), Math.round(o.x * 10) / 10, Math.round(o.dir * 100) / 100, o.face]);
    return out;
  }

  hostileTo(o, u) {
    if (!o || !u) return false;
    if (o.team === -2) return true;
    return o.team >= 0 && u.team >= 0 && o.team !== u.team;
  }

  hitTest(x, y, dx, dy, owner, team) {
    const t = owner ? owner.team : team;
    for (const o of this.objs) {
      if (o.hp <= 0) continue;
      if (t !== undefined && t >= 0 && o.team === t) continue;
      if (Math.abs(x - o.x) > o.w / 2 + Math.abs(dx) + 5) continue;
      for (const k of [0.5, 1]) {
        const px = x + dx * k, py = y + dy * k;
        if (px > o.x - o.w / 2 && px < o.x + o.w / 2 && py > o.y - 2 && py < o.y + o.h) return o;
      }
    }
    return null;
  }

  solidAt(x, y) {
    for (const o of this.objs) {
      if (!o.solid || o.hp <= 0) continue;
      if (x > o.x - o.w / 2 && x < o.x + o.w / 2 && y > o.y && y < o.y + o.h * 0.9) return o;
    }
    return null;
  }

  // Даёт ли уничтожение объекта очки: только вражеские объекты (нейтральные здания и мишени — нет,
  // иначе их можно бесконечно фармить: они возрождаются).
  rewarding(o, attacker) {
    if (!attacker) return false;
    if (o.team === -1) return false;
    if (o.team === -2) return true;
    return attacker.team < 0 || o.team !== attacker.team;
  }

  damage(o, dmg, attacker) {
    if (o.hp <= 0) return;
    o.hp -= dmg;
    const reward = this.rewarding(o, attacker);
    if (reward) attacker.stats.damage += Math.min(dmg, o.hp + dmg) * 0.5;
    if (o.hp <= 0) {
      o.hp = 0; o.deadT = 0;
      this.g.events.push(['boom', Math.round(o.x), Math.round(o.y + o.h * 0.4), o.type === 'hq' ? 140 : 60]);
      this.g.events.push(['gkill', o.gid, attacker ? attacker.id : '']);
      if (reward) {
        attacker.stats.ground++;
        attacker.stats.score += o.type === 'hq' ? 10 : 1;
      }
      this.g.rules.onGroundKill && this.g.rules.onGroundKill(this.g, attacker, o);
    }
  }

  explosion(x, y, r, dmg, owner, team) {
    const t = owner ? owner.team : team;
    for (const o of this.objs) {
      if (o.hp <= 0) continue;
      if (t !== undefined && t !== null && t >= 0 && o.team === t) continue;
      const dx = Math.max(0, Math.abs(x - o.x) - o.w / 2);
      const dy = Math.max(0, o.y - y, y - (o.y + o.h));
      const d = Math.hypot(dx, dy);
      // штаб — укреплённый бункер: от взрывов получает 35% урона (иначе один бомбардировщик сносит его за заход)
      const fort = o.type === 'hq' ? 0.35 : 1;
      if (d < r) this.damage(o, (dmg * (1 - d / r) * 1.1 + dmg * 0.15) * fort, owner);
    }
  }

  // ---------- ИИ ----------
  tick(dt) {
    const g = this.g;
    for (const o of this.objs) {
      if (o.hp <= 0) {
        o.deadT += dt;
        const T = TYPES[o.type];
        if (o.type === 'tank' && g.mode === 'base') continue;          // в режиме баз танки приходят волнами
        if (T.respawn && o.deadT > T.respawn) { o.hp = o.maxHp; o.x = o.x0; o.y = g.terrain.ground(o.x); }
        continue;
      }
      o.reload -= dt; o.mgT -= dt;
      if (o.type === 'aa') this.aaThink(o);
      else if (o.type === 'tank') this.tankThink(o, dt);
      else if (o.type === 'artillery') this.artThink(o);
    }
    // волны танков в режиме уничтожения баз
    if (g.mode === 'base') {
      for (const team of [0, 1]) {
        this.tankTimer[team] -= dt;
        if (this.tankTimer[team] > 0) continue;
        this.tankTimer[team] = 28;
        const alive = this.objs.filter(o => o.type === 'tank' && o.team === team && o.hp > 0).length;
        const hq = this.objs.find(o => o.type === 'hq' && o.team === team);
        if (alive < 4 && hq && hq.hp > 0) {
          const sp = g.map.tankSpawns[team];
          this.objs = this.objs.filter(o => !(o.type === 'tank' && o.hp <= 0 && o.deadT > 5));
          this.add('tank', team, sp + (team === 0 ? 60 : -60));
          if (alive < 3) this.add('tank', team, sp + (team === 0 ? 0 : 0));
        }
      }
    }
  }

  aaThink(o) {
    const g = this.g;
    let best = null, bd = 780;
    for (const pl of g.planes.values()) {
      if (!pl.owner || pl.p.dead || pl.p.inCloud || pl.protect > 0) continue;
      if (!this.hostileTo(o, pl.owner)) continue;
      const alt = pl.p.y - g.terrain.ground(pl.p.x);
      if (alt < 25) continue;
      const d = Math.hypot(pl.p.x - o.x, pl.p.y - o.y);
      if (d < bd) { bd = d; best = pl; }
    }
    if (!best) return;
    const SPEED = 640;
    let t = bd / SPEED, tx = best.p.x, ty = best.p.y;
    for (let k = 0; k < 3; k++) { tx = best.p.x + best.p.vx * t; ty = best.p.y + best.p.vy * t; t = Math.hypot(tx - o.x, ty - o.y - 12) / SPEED; }
    o.dir = Math.atan2(ty - o.y - 12, tx - o.x);
    if (o.reload > 0) return;
    o.reload = 1.05 + Math.random() * 0.3;
    const err = 18 + bd * 0.05;
    tx += (Math.random() - 0.5) * err * 2; ty += (Math.random() - 0.5) * err * 2;
    t = Math.hypot(tx - o.x, ty - o.y - 12) / SPEED;
    const a = Math.atan2(ty - o.y - 12, tx - o.x);
    g.projs.push({ id: g.projSeq++, type: 'flak', o: null, src: o, team: o.team, x: o.x, y: o.y + 12, vx: Math.cos(a) * SPEED, vy: Math.sin(a) * SPEED, life: t, dmg: 30, r: 60 });
  }

  groundTargetFor(o, range, preferHq) {
    const g = this.g;
    let best = null, bd = range;
    for (const t of this.objs) {
      if (t.hp <= 0 || t.team < 0 || t.team === o.team || o.team < 0) continue;
      if (t.type === 'building') continue;
      let d = Math.abs(t.x - o.x);
      if (preferHq && t.type === 'hq') d *= 0.6;
      if (t.type === 'tank') d *= 0.8;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  tankThink(o, dt) {
    const g = this.g;
    // цель: вражеская техника/постройки или пешие пилоты
    let target = this.groundTargetFor(o, 520, false);
    let tx, ty;
    if (target) { tx = target.x; ty = target.y + target.h * 0.5; }
    if (!target) {
      for (const u of g.users.values()) {
        if (u.state !== 'pilot' || !u.pilot.ground || !this.hostileTo(o, u)) continue;
        if (Math.abs(u.pilot.x - o.x) < 420) { target = u; tx = u.pilot.x; ty = u.pilot.y + 8; break; }
      }
    }
    if (target) {
      o.face = tx > o.x ? 1 : -1;
      const ang = ballistic(Math.abs(tx - o.x), ty - (o.y + 18), 400, false);
      o.dir = ang;
      if (o.reload <= 0) {
        o.reload = 3.5 + Math.random();
        const a = ang + (Math.random() - 0.5) * 0.05;
        const vx = Math.cos(a) * 400 * o.face, vy = Math.sin(a) * 400;
        g.projs.push({ id: g.projSeq++, type: 'shell', o: null, team: o.team, x: o.x + o.face * 22, y: o.y + 18, vx, vy, life: 6, dmg: 70, r: 45 });
        g.events.push(['muzzle', Math.round(o.x + o.face * 28), Math.round(o.y + 18)]);
      }
    } else {
      // движение к врагу
      o.face = o.team === 1 ? -1 : 1;
      o.dir = 0.05;
      const nx = o.x + o.face * 22 * dt;
      const ny = g.terrain.ground(nx);
      const blocked = g.terrain.water(nx + o.face * 30) || Math.abs(ny - o.y) / Math.max(0.01, 22 * dt) > 0.7 ||
        this.objs.some(t => t !== o && t.type === 'tank' && t.hp > 0 && t.team === o.team && (t.x - o.x) * o.face > 0 && Math.abs(t.x - o.x) < 70) ||
        nx < 100 || nx > g.terrain.width - 100;
      if (!blocked) { o.x = nx; o.y = ny; }
    }
    // пулемёт по низколетящим самолётам
    if (o.mgT <= 0) {
      for (const pl of g.planes.values()) {
        if (!pl.owner || pl.p.dead || !this.hostileTo(o, pl.owner)) continue;
        const dx = pl.p.x - o.x, dy = pl.p.y - o.y - 20;
        if (Math.hypot(dx, dy) < 380 && dy > 0 && dy < 260) {
          o.mgT = 0.22;
          const sp = 800, t = Math.hypot(dx, dy) / sp;
          const a = Math.atan2(dy + pl.p.vy * t, dx + pl.p.vx * t) + (Math.random() - 0.5) * 0.12;
          g.bullets.push({ o: null, eid: -1, x: o.x, y: o.y + 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, dmg: 2.5, life: 0.6, explosive: false, w: 'mg', team: o.team });
          g.events.push(['shot', 'g' + o.gid, Math.round(o.x), Math.round(o.y + 20), Math.round(Math.cos(a) * sp), Math.round(Math.sin(a) * sp), 'mg', 0.6]);
          break;
        }
      }
    }
  }

  artThink(o) {
    const g = this.g;
    if (o.reload > 0) return;
    const target = this.groundTargetFor(o, 2500, true);
    if (!target) { o.reload = 2; return; }
    const dx = target.x - o.x, face = dx > 0 ? 1 : -1;
    const ang = ballistic(Math.abs(dx), target.y - o.y, 520, true);
    o.dir = face > 0 ? ang : Math.PI - ang;
    o.reload = 5 + Math.random() * 2;
    const a = ang + (Math.random() - 0.5) * 0.04;
    g.projs.push({ id: g.projSeq++, type: 'shell', o: null, team: o.team, x: o.x + face * 20, y: o.y + 14, vx: Math.cos(a) * 520 * face, vy: Math.sin(a) * 520, life: 12, dmg: 90, r: 70 });
    g.events.push(['muzzle', Math.round(o.x + face * 30), Math.round(o.y + 16)]);
  }
}

// Угол выстрела для попадания в точку (dx>0, dy) при скорости v; high — навесная траектория.
function ballistic(dx, dy, v, high) {
  const G = GRAVITY, v2 = v * v;
  const disc = v2 * v2 - G * (G * dx * dx + 2 * dy * v2);
  if (disc < 0) return Math.PI / 4;
  const s = Math.sqrt(disc);
  const t = high ? (v2 + s) / (G * dx) : (v2 - s) / (G * dx);
  return Math.atan(t);
}
