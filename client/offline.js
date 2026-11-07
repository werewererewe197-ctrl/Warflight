// Этап 1: офлайн-тренировка — свободный полёт с локальной физикой, стрельбой и бомбами по мишеням.
import { DT, PHYS_SUBSTEPS, GRAVITY, UNIT_M, clamp, wrapAngle } from '../shared/constants.js';
import { buildStats, createPlane, tickPlane, createPilot, tickPilot } from '../shared/physics.js';
import { getTerrain } from '../shared/maps.js';
import { drawHud } from './hud.js';

export class OfflineGame {
  constructor(app, mapId, planeId) {
    this.app = app;
    this.r = app.renderer;
    this.input = app.input;
    this.terrain = getTerrain(mapId);
    this.r.setTerrain(this.terrain);
    this.def = app.data.planes.find(p => p.id === planeId) || app.data.planes[0];
    this.st = buildStats(this.def, app.profileUpgrades(planeId), app.data);
    this.targets = this.terrain.map.objects.filter(o => o.type !== 'hq').map(o => ({
      ...o, y: this.terrain.ground(o.x), hp: 100, maxHp: 100, color: '#aaa', respawn: 0,
    }));
    this.bombs = [];
    this.bullets = [];
    this.acc = 0;
    this.respawnT = 0;
    this.msg = 'Тренировка: W/S газ, A/D поворот, Space огонь, B бомба, F переворот. Esc — выход';
    this.msgT = 15;
    this.spawn();
  }

  spawn() {
    const af = this.terrain.map.airfields[0];
    this.plane = createPlane(this.st, af.x1 + 200, af.h + 380, 0, this.st.vstall * 1.9);
    this.ammo = this.st.guns.map(g => Math.round(g.ammo * this.st.ammoMul));
    this.gunT = this.st.guns.map(() => 0);
    this.gunHeat = 0; this.gunOver = false;
    this.bombsLeft = this.st.bombs ? this.st.bombs.count : 0;
    this.pilot = null;
  }

  frame(dt) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) { this.acc -= DT; this.tick(); }
    this.r.update(dt);
    const p = this.plane, c = this.pilot;
    const focus = c || p;
    this.r.follow(focus.x, focus.y, p ? Math.hypot(p.vx, p.vy) : 0, dt);
    const planes = [];
    if (p && !this.crashed) {
      const view = { ...p, def: this.def, id: 1, isMe: true, fire: p.parts.fuel < 0.3, bombs: this.bombsLeft, g: 0 };
      planes.push(view);
      this.r.planeFx(view, dt);
    }
    this.r.draw({
      planes, pilots: c ? [{ ...c, color: '#fff' }] : [],
      ground: this.targets, projectiles: this.bombs.map(b => ({ ...b, type: 'bomb' })),
    });
    this.msgT -= dt;
    const me = p && !this.crashed ? {
      kind: 'plane', speed: Math.hypot(p.vx, p.vy), alt: (p.y - Math.max(0, this.terrain.ground(p.x))) * UNIT_M, thr: p.thr, heat: p.heat,
      overheat: p.overheat, boosting: p.boosting, gunHeat: this.gunHeat, gunOverheat: this.gunOver, hpFrac: 1, parts: p.parts,
      weapons: [...this.st.guns.map((g, i) => ({ icon: 'bullet', n: this.ammo[i], warn: this.gunOver })),
        ...(this.st.bombs ? [{ icon: 'bomb', n: this.bombsLeft, key: 'B' }] : [])],
    } : null;
    const warnings = [];
    if (p && p.stall) warnings.push({ text: p.spin ? 'Штопор — отпустите ручку' : 'Сваливание — нос вниз, газ' });
    if (p && p.overheat) warnings.push({ text: 'Двигатель перегрет', icon: 'temp', color: '#ffb04a' });
    this.input.setTouchInfo({ hasBombs: !!this.st.bombs, bombs: this.bombsLeft, hasRockets: false, rockets: 0, canSpawn: false });
    drawHud(this.r, {
      me, mobile: this.input.touch,
      minimap: { terrain: this.terrain, teamColor: t => t === 0 ? '#4b8fe8' : '#e5533f', points: p ? [{ x: p.x, y: p.y, color: '#ffe04a', me: true }] : [] },
      warnings, center: this.crashed ? 'Самолёт разбит' : null,
      hint: this.msgT > 0 ? this.msg : null,
    });
  }

  tick() {
    const p = this.plane;
    if (this.crashed) {
      this.respawnT -= DT;
      if (this.respawnT <= 0) { this.crashed = false; this.spawn(); }
      return;
    }
    const pos = { x: this.r.sx(p.x), y: this.r.sy(p.y) };
    const inp = this.input.planeInput(pos, p);
    tickPlane(p, this.st, inp, DT, PHYS_SUBSTEPS, this.terrain);
    if (p.contact === 'crash' || p.contact === 'water') {
      if (p.contact === 'water') this.r.splash(p.x, true); else this.r.explode(p.x, p.y, 70);
      this.crashed = true; this.respawnT = 2.5;
      return;
    }
    // ремонт/перезарядка на аэродроме
    if (p.ground && Math.hypot(p.vx, p.vy) < 40 && this.terrain.airfieldAt(p.x)) {
      this.ammo = this.st.guns.map(g => Math.round(g.ammo * this.st.ammoMul));
      this.bombsLeft = this.st.bombs ? this.st.bombs.count : 0;
    }
    // стрельба
    this.gunHeat = Math.max(0, this.gunHeat - 0.4 * DT);
    if (this.gunOver && this.gunHeat < 0.4) this.gunOver = false;
    this.st.guns.forEach((g, i) => {
      this.gunT[i] -= DT;
      if (inp.f && !this.gunOver && this.ammo[i] > 0) {
        while (this.gunT[i] <= 0) {
          this.gunT[i] += 1 / g.wd.rof;
          this.ammo[i]--;
          this.gunHeat += g.wd.heat; if (this.gunHeat >= 1) { this.gunOver = true; }
          const a = p.a + (Math.random() - 0.5) * g.wd.spread * this.st.spreadMul;
          const vx = p.vx + Math.cos(a) * g.wd.speed, vy = p.vy + Math.sin(a) * g.wd.speed;
          const ox = p.x + Math.cos(p.a) * 16, oy = p.y + Math.sin(p.a) * 16;
          this.r.addTracer(ox, oy, vx, vy, g.wd.life, g.wd.explosive ? '255,170,90' : '255,235,160', g.wd.explosive);
          this.bullets.push({ x: ox, y: oy, vx, vy, life: g.wd.life, dmg: g.wd.dmg * g.count });
        }
      } else if (this.gunT[i] < 0) this.gunT[i] = 0;
    });
    if (inp.b && this.bombsLeft > 0) {
      this.bombsLeft--;
      this.bombs.push({ x: p.x, y: p.y - 8, vx: p.vx, vy: p.vy - 20, r: this.st.bombs.bd.radius });
    }
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= DT; b.vy -= 30 * DT; b.x += b.vx * DT; b.y += b.vy * DT;
      let hit = b.life <= 0 || b.y < this.terrain.ground(b.x);
      for (const t of this.targets) {
        if (t.hp > 0 && Math.abs(b.x - t.x) < 25 && b.y > t.y && b.y < t.y + 40) { t.hp -= b.dmg; hit = true; this.r.spark(b.x, b.y); if (t.hp <= 0) { this.r.explode(t.x, t.y + 10, 50); t.respawn = 10; } }
      }
      if (hit) this.bullets.splice(i, 1);
    }
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vy -= GRAVITY * DT; b.vx *= 1 - 0.1 * DT; b.x += b.vx * DT; b.y += b.vy * DT;
      if (b.y < this.terrain.ground(b.x)) {
        if (this.terrain.water(b.x)) this.r.splash(b.x, true); else this.r.explode(b.x, b.y, b.r);
        for (const t of this.targets) if (t.hp > 0 && Math.abs(t.x - b.x) < b.r) { t.hp = 0; t.respawn = 10; this.r.explode(t.x, t.y + 10, 40); }
        this.bombs.splice(i, 1);
      }
    }
    for (const t of this.targets) if (t.hp <= 0) { t.respawn -= DT; if (t.respawn <= 0) t.hp = t.maxHp; }
  }
}
