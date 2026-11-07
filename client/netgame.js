// Сетевой бой на клиенте: отправка ввода, предсказание своего самолёта/пилота,
// сверка с сервером (reconciliation), интерполяция чужих объектов, эффекты и HUD.
import { DT, TICK_RATE, PHYS_SUBSTEPS, INTERP_DELAY_TICKS, MODES, TEAM_COLORS, TEAM_NAMES, NATIONS, clamp, lerp, lerpAngle, wrapAngle } from '../shared/constants.js';
import { buildStats, tickPlane, unpackPlane, tickPilot, unpackPilot } from '../shared/physics.js';
import { getTerrain } from '../shared/maps.js';
import { PF, CF, PROJ_NAMES } from '../shared/protocol.js';
import { drawHud } from './hud.js';

const KILL_ICON = { gun: '✈︎', crash: '💥', pilot: '☠', zone: '☢', suicide: '☠', fire: '🔥', flak: '✷', boom: '💣', ram: '⚔', mg: '✈︎', hmg: '✈︎', cannon: '✈︎', hcannon: '✈︎', pistol: '🔫' };

export class NetGame {
  constructor(app, m) {
    this.app = app;
    this.r = app.renderer;
    this.input = app.input;
    this.net = app.net;
    this.myId = m.you;
    this.mode = m.mode;
    this.settings = m.settings;
    this.terrain = getTerrain(m.map);
    this.r.setTerrain(this.terrain);
    this.teams = MODES[m.mode].teams;
    this.setRoster(m.roster);
    this.groundInfo = new Map(m.ground.map(g => [g.gid, g]));
    this.snaps = [];
    this.est = null;
    this.seq = 1;
    this.pending = [];
    this.pred = null; this.prevPred = null; this.predKind = null; this.predEid = 0;
    this.smooth = { x: 0, y: 0 };
    this.acc = 0;
    this.killfeed = [];
    this.hitMarker = 0;
    this.lastMe = null;
    this.localGun = { t: [], heat: 0 };
    this.camFocus = null;
    this.spectate = null;
    this.ended = false;
    this.chatLines = [];
  }

  setRoster(roster) {
    this.roster = new Map(roster.map(r => [r.id, r]));
    const me = this.roster.get(this.myId);
    if (me) {
      this.myTeam = me.team;
      const def = this.app.data.planes.find(p => p.id === me.planeId);
      if (def && (!this.myDef || this.myDef.id !== def.id)) { this.myDef = def; this.myStats = buildStats(def, this.app.profileUpgrades(def.id), this.app.data); }
    }
  }

  hostileId(id) {
    if (!id || id === this.myId) return false;
    const r = this.roster.get(id);
    if (!r) return true;
    return !this.teams || r.team !== this.myTeam;
  }
  colorOf(id) { const r = this.roster.get(id); return r ? r.color : '#ccc'; }
  nameOf(id) { const r = this.roster.get(id); return r ? r.name : (id ? '?' : 'Окружение'); }

  // ---------- сообщения сервера ----------
  onSnapshot(s) {
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    if (this.est === null) this.est = s.k;
    else if (s.k > this.est + 10 || s.k < this.est - 20) this.est = s.k;
    this.latest = s;
    for (const e of s.E) this.onEvent(e);
    this.reconcile(s.me);
    this.lastMe = s.me;
  }

  onEvent(e) {
    const r = this.r;
    switch (e[0]) {
      case 'shot': {
        const [, owner, x, y, vx, vy, w, life] = e;
        if (owner === this.predEid && this.predKind === 'plane') return;
        if (owner === 'c' + this.myId) return;
        r.addTracer(x, y, vx, vy, life, w === 'cannon' || w === 'hcannon' ? '255,170,90' : '255,235,160', w === 'cannon' || w === 'hcannon');
        break;
      }
      case 'hit': r.spark(e[1], e[2], !!e[4]); if (e[5] === this.myId) { this.hitMarker = 1; this.hitPos = [e[1], e[2]]; } break;
      case 'boom': r.explode(e[1], e[2], e[3]); if (this.terrain.water(e[1]) && e[2] < 5) r.splash(e[1], true); break;
      case 'flak': r.flak(e[1], e[2]); break;
      case 'splash': r.splash(e[1], !!e[2]); break;
      case 'muzzle': r.addParticle({ x: e[1], y: e[2], vx: 0, vy: 0, life: 0.1, max: 0.1, size: 8, grow: 40, color: '255,220,120', a: 0.9, kind: 'flash' }); r.smoke(e[1], e[2], 0.3, 6); break;
      case 'kill': {
        const [, killer, victim, how] = e;
        const kn = killer ? this.nameOf(killer) : '', vn = this.nameOf(victim);
        this.killfeed.unshift({ killer: kn || (how === 'crash' ? '' : 'ПВО'), victim: vn, icon: KILL_ICON[how] || '✈︎', kc: killer ? this.colorOf(killer) : '#bbb', vc: this.colorOf(victim), ttl: 7 });
        if (this.killfeed.length > 6) this.killfeed.pop();
        if (killer === this.myId && victim !== this.myId) this.app.toast(how === 'pilot' ? `Пилот ${vn} уничтожен` : `Сбит: ${vn}`);
        if (victim === this.myId) this.spectate = killer || null;
        break;
      }
      case 'msg': this.app.addIngameChat({ sys: true, text: e[1] }); break;
    }
  }

  reconcile(me) {
    if (!me) return;
    if (me.s === 'plane' && me.pl) {
      if (this.predKind !== 'plane' || this.predEid !== me.eid) {
        this.pred = unpackPlane(me.pl); this.prevPred = { ...this.pred }; this.predKind = 'plane'; this.predEid = me.eid;
        this.pending = this.pending.filter(p => p.s > me.seq);
        this.smooth = { x: 0, y: 0 };
        if (this.roster.get(this.myId)?.planeId !== me.plane) { this.setRosterPlane(me.plane); }
        return;
      }
      const old = { x: this.pred.x, y: this.pred.y };
      const p = unpackPlane(me.pl);
      this.pending = this.pending.filter(i => i.s > me.seq);
      for (const inp of this.pending) tickPlane(p, this.myStats, inp, DT, PHYS_SUBSTEPS, this.terrain);
      const dx = old.x - p.x, dy = old.y - p.y;
      if (Math.hypot(dx, dy) < 150) { this.smooth.x += dx; this.smooth.y += dy; } else this.smooth = { x: 0, y: 0 };
      this.pred = p;
    } else if (me.s === 'pilot' && me.pi) {
      if (this.predKind !== 'pilot') {
        this.pred = unpackPilot(me.pi); this.prevPred = { ...this.pred }; this.predKind = 'pilot'; this.predEid = 0;
        this.pending = this.pending.filter(p => p.s > me.seq);
        this.smooth = { x: 0, y: 0 };
        return;
      }
      const old = { x: this.pred.x, y: this.pred.y };
      const c = unpackPilot(me.pi);
      this.pending = this.pending.filter(i => i.s > me.seq);
      for (const inp of this.pending) tickPilot(c, inp, DT, PHYS_SUBSTEPS, this.terrain, this.terrain.width);
      const dx = old.x - c.x, dy = old.y - c.y;
      if (Math.hypot(dx, dy) < 80) { this.smooth.x += dx; this.smooth.y += dy; } else this.smooth = { x: 0, y: 0 };
      this.pred = c;
    } else {
      if (this.predKind) { this.camFocus = { x: this.pred.x, y: this.pred.y }; }
      this.predKind = null; this.pred = null; this.pending = [];
    }
  }

  setRosterPlane(planeId) {
    const r = this.roster.get(this.myId);
    if (r) r.planeId = planeId;
    const def = this.app.data.planes.find(p => p.id === planeId);
    if (def) { this.myDef = def; this.myStats = buildStats(def, this.app.profileUpgrades(def.id), this.app.data); }
  }

  // ---------- тик клиента ----------
  tick() {
    if (this.ended) return;
    const me = this.lastMe;
    let inp;
    if (this.predKind === 'plane' && this.pred) {
      const pos = { x: this.r.sx(this.pred.x), y: this.r.sy(this.pred.y) };
      inp = this.input.planeInput(pos, this.pred);
    } else if (this.predKind === 'pilot' && this.pred) {
      const pos = { x: this.r.sx(this.pred.x), y: this.r.sy(this.pred.y + 10) };
      inp = this.input.pilotInput(pos, this.autoAimPilot());
      if (this._spawnClick) { inp.e = 1; this._spawnClick = false; }
    } else {
      inp = this.input.pilotInput(null);
    }
    inp.s = this.seq++;
    this.net.send({ ...inp, t: 'in', th: inp.t });
    if (this.pred) {
      this.prevPred = { ...this.pred, parts: this.pred.parts };
      if (this.predKind === 'plane') {
        tickPlane(this.pred, this.myStats, inp, DT, PHYS_SUBSTEPS, this.terrain);
        this.predictGuns(inp);
      } else {
        tickPilot(this.pred, inp, DT, PHYS_SUBSTEPS, this.terrain, this.terrain.width);
        this.predictPistol(inp);
      }
      this.pending.push(inp);
      if (this.pending.length > 90) this.pending.shift();
    }
  }

  predictGuns(inp) {
    const me = this.lastMe, p = this.pred, st = this.myStats;
    if (!me || !me.am) return;
    const g = this.localGun;
    st.guns.forEach((gun, i) => {
      g.t[i] = (g.t[i] || 0) - DT;
      if (inp.f && !me.go && me.am[i] > 0 && !p.ground) {
        let n = 0;
        while (g.t[i] <= 0 && n++ < 4) {
          g.t[i] += 1 / gun.wd.rof;
          const a = p.a + (Math.random() - 0.5) * gun.wd.spread * st.spreadMul * (1 + (me.gh || 0) * 1.6);
          const off = 16 * st.size;
          this.r.addTracer(p.x + Math.cos(p.a) * off, p.y + Math.sin(p.a) * off, p.vx + Math.cos(a) * gun.wd.speed, p.vy + Math.sin(a) * gun.wd.speed,
            gun.wd.life, gun.wd.explosive ? '255,170,90' : '255,235,160', gun.wd.explosive);
        }
      } else if (g.t[i] < 0) g.t[i] = 0;
    });
  }

  predictPistol(inp) {
    const c = this.pred;
    this._pt = (this._pt || 0) - DT;
    if (inp.f && !c.swim && this._pt <= 0) {
      this._pt = 1 / 6;
      this.r.addTracer(c.x + Math.cos(c.aim) * 10, c.y + 10 + Math.sin(c.aim) * 10, Math.cos(c.aim) * 700, Math.sin(c.aim) * 700, 0.8, '255,240,200');
    }
  }

  autoAimPilot() {
    // на телефоне пилот автоматически целится в ближайший вражеский самолёт
    const s = this.latest; if (!s || !this.pred) return null;
    let best = null, bd = 450;
    for (const P of s.P) {
      if (!this.hostileId(P[1]) || (P[10] & PF.DEAD)) continue;
      const d = Math.hypot(P[3] - this.pred.x, P[4] - this.pred.y);
      if (d < bd) { bd = d; best = P; }
    }
    if (!best) return Math.PI / 2;
    return Math.atan2(best[4] + best[8] * 0.4 - this.pred.y - 10, best[3] + best[7] * 0.4 - this.pred.x);
  }

  // ---------- интерполяция ----------
  interp() {
    const rt = this.est - INTERP_DELAY_TICKS;
    const S = this.snaps;
    if (!S.length) return null;
    let a = S[0], b = S[0];
    for (let i = 0; i < S.length - 1; i++) if (S[i].k <= rt && S[i + 1].k >= rt) { a = S[i]; b = S[i + 1]; break; }
    if (rt > S[S.length - 1].k) a = b = S[S.length - 1];
    const t = b.k === a.k ? 0 : clamp((rt - a.k) / (b.k - a.k), 0, 1);
    return { a, b, t };
  }

  frame(dt) {
    if (this.est !== null) this.est += dt * TICK_RATE;
    if (this.latest && this.est > this.latest.k + 6) this.est = this.latest.k + 6;
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) { this.acc -= DT; this.tick(); }
    const k = Math.min(1, dt * 8);
    this.smooth.x *= 1 - k; this.smooth.y *= 1 - k;
    this.hitMarker = Math.max(0, this.hitMarker - dt * 3);
    for (const kf of this.killfeed) kf.ttl -= dt;
    this.killfeed = this.killfeed.filter(k => k.ttl > 0);
    this.r.update(dt);

    const I = this.interp();
    const view = { planes: [], pilots: [], ground: [], projectiles: [], zone: this.latest ? this.latest.z : null };
    const me = this.lastMe;
    const alpha = this.acc / DT;
    let myPos = null;
    if (I) {
      const { a, b, t } = I;
      const am = new Map(a.P.map(p => [p[0], p]));
      for (const P of b.P) {
        if (this.predKind === 'plane' && P[0] === this.predEid) continue;
        const A = am.get(P[0]) || P;
        const def = this.app.data.planes.find(d => d.id === P[2]);
        const f = P[10];
        const hidden = (f & PF.CLOUD) && this.hostileId(P[1]);
        const pl = {
          id: P[0], owner: P[1], def, x: lerp(A[3], P[3], t), y: lerp(A[4], P[4], t), a: lerpAngle(A[5], P[5], t), roll: lerp(A[6], P[6], t),
          vx: P[7], vy: P[8], thr: P[9], boosting: !!(f & PF.BOOST), fire: !!(f & PF.FIRE), dead: !!(f & PF.DEAD), cloud: !!(f & PF.CLOUD),
          hpFrac: P[11] / 100, parts: { engine: P[12], wing: P[13], tail: P[14], fuel: P[15] }, bombs: P[16], rockets: P[17],
          name: f & PF.DEAD ? null : this.nameOf(P[1]), color: this.colorOf(P[1]), hiddenTag: hidden,
        };
        view.planes.push(pl);
        this.r.planeFx(pl, dt);
      }
      const ac = new Map(a.C.map(c => [c[0], c]));
      for (const C of b.C) {
        if (C[0] === this.myId && this.predKind === 'pilot') continue;
        const A = ac.get(C[0]) || C;
        view.pilots.push({ x: lerp(A[1], C[1], t), y: lerp(A[2], C[2], t), vx: C[3], vy: C[4], aim: C[5], chute: !!(C[6] & CF.CHUTE), ground: !!(C[6] & CF.GROUND), swim: !!(C[6] & CF.SWIM), name: this.nameOf(C[0]), color: this.colorOf(C[0]) });
      }
      const ar = new Map(a.R.map(r => [r[0], r]));
      for (const R of b.R) {
        const A = ar.get(R[0]) || R;
        view.projectiles.push({ type: PROJ_NAMES[R[1]], x: lerp(A[2], R[2], t), y: lerp(A[3], R[3], t), vx: R[4], vy: R[5] });
      }
      const ag = new Map(a.G.map(g => [g[0], g]));
      for (const G of b.G) {
        const info = this.groundInfo.get(G[0]); if (!info) continue;
        const A = ag.get(G[0]) || G;
        const x = lerp(A[2], G[2], t);
        view.ground.push({ ...info, hp: G[1], x, y: this.terrain.ground(x), dir: lerpAngle(A[3], G[3], t), face: G[4], color: this.objColor(info.team) });
      }
    }
    // свой самолёт / пилот: предсказанное состояние + сглаживание поправок
    if (this.pred && this.prevPred) {
      const P = this.pred, Q = this.prevPred;
      const x = lerp(Q.x, P.x, alpha) + this.smooth.x, y = lerp(Q.y, P.y, alpha) + this.smooth.y;
      myPos = { x, y };
      if (this.predKind === 'plane') {
        const g = this.lastG = Math.abs(P.a - Q.a) / DT * Math.hypot(P.vx, P.vy) / 110;
        const pl = { ...P, x, y, a: lerpAngle(Q.a, P.a, alpha), roll: lerp(Q.roll, P.roll, alpha), def: this.myDef, id: this.predEid, isMe: true,
          fire: me && me.fire, dead: P.dead, bombs: me ? me.bm : 0, rockets: me ? me.rk : 0, g, parts: P.parts };
        view.planes.push(pl);
        this.r.planeFx(pl, dt);
      } else {
        view.pilots.push({ ...P, x, y, isMe: true, color: '#fff' });
      }
    }
    // камера
    let focus = myPos;
    if (!focus) {
      let sp = null;
      if (this.spectate && I) {
        const P = I.b.P.find(p => p[1] === this.spectate);
        if (P) sp = { x: P[3], y: P[4] };
      }
      focus = sp || this.camFocus || { x: this.terrain.width / 2, y: 800 };
    }
    const spd = this.predKind === 'plane' ? Math.hypot(this.pred.vx, this.pred.vy) : 0;
    this.r.follow(focus.x, focus.y + (this.predKind === 'pilot' ? 60 : 0), spd, dt, this.predKind === 'pilot' ? 1.25 : 1);
    for (const p of view.planes) if (p.hiddenTag) p.name = null;
    this.r.draw(view);
    this.drawHud(view, myPos);
  }

  objColor(team) { return team === 0 ? TEAM_COLORS[0] : team === 1 ? TEAM_COLORS[1] : team === -2 ? '#c4c' : '#999'; }

  drawHud(view, myPos) {
    const me = this.lastMe, s = this.latest, r = this.r;
    const info = { mobile: this.input.touch, killfeed: this.killfeed, hitMarker: this.hitMarker, warnings: [] };
    if (this.hitPos && this.hitMarker > 0) info.hitPos = { x: r.sx(this.hitPos[0]), y: r.sy(this.hitPos[1]) };
    if (s) {
      info.timer = s.tl;
      info.modeLabel = MODES[this.mode].short;
      if (this.teams) {
        info.score = this.mode === 'base' && s.x
          ? [{ text: `${TEAM_NAMES[0]}: штаб ${s.x.hq[0]}%`, color: TEAM_COLORS[0] }, { text: `${TEAM_NAMES[1]}: штаб ${s.x.hq[1]}%`, color: TEAM_COLORS[1] }]
          : [{ text: `${TEAM_NAMES[0]} ${s.ts[0]}`, color: TEAM_COLORS[0] }, { text: `${s.ts[1]} ${TEAM_NAMES[1]}`, color: TEAM_COLORS[1] }];
      } else {
        const sc = [...s.sc].sort((a, b) => b[1] - a[1]);
        const mine = s.sc.find(x => x[0] === this.myId);
        const place = sc.findIndex(x => x[0] === this.myId) + 1;
        if (this.mode === 'br') info.score = [{ text: `Живых: ${s.sc.filter(x => x[4] !== 2).length}`, color: '#fff' }, { text: `Убийств: ${mine ? mine[1] : 0}`, color: '#ffe04a' }];
        else info.score = [{ text: `Лидер: ${this.nameOf(sc[0] && sc[0][0])} ${sc[0] ? sc[0][1] : 0}`, color: this.colorOf(sc[0] && sc[0][0]) }, { text: `Вы: ${mine ? mine[1] : 0} (#${place})`, color: '#ffe04a' }];
      }
    }
    // мини-карта
    const pts = [];
    for (const p of view.planes) {
      if (p.isMe) continue;
      const hostile = this.hostileId(p.owner);
      if (hostile && p.cloud) continue;
      if (p.dead) continue;
      pts.push({ x: p.x, y: p.y, color: hostile ? '#ff5544' : '#66b0ff' });
    }
    for (const c of view.pilots) if (!c.isMe) pts.push({ x: c.x, y: c.y, color: '#fff', kind: 'pilot' });
    for (const g of view.ground) if (g.hp > 0 && g.type !== 'building') pts.push({ x: g.x, y: g.y, color: g.color, kind: g.type === 'hq' ? 'base' : 'ground' });
    if (myPos) pts.push({ x: myPos.x, y: myPos.y, color: '#ffe04a', me: true });
    info.minimap = { terrain: this.terrain, points: pts, zone: s ? s.z : null, view: [r.wx(0), r.wx(r.W)], teamColor: t => this.teams ? TEAM_COLORS[t] : '#bbb' };

    if (this.predKind === 'plane' && this.pred && me && me.mhp) {
      const p = this.pred, st = this.myStats;
      info.me = {
        kind: 'plane', speed: Math.hypot(p.vx, p.vy), alt: p.y - this.terrain.ground(p.x), thr: p.thr, heat: p.heat, overheat: p.overheat, boosting: p.boosting,
        gunHeat: me.gh || 0, gunOverheat: !!me.go, hpFrac: me.hp / me.mhp, parts: p.parts, fire: !!me.fire,
        weapons: [
          ...st.guns.map((g, i) => ({ label: `${g.wd.name} ×${g.count}`, n: me.am ? me.am[i] : 0 })),
          ...(st.bombs ? [{ label: st.bombs.bd.name + ' [B]', n: me.bm }] : []),
          ...(st.rockets ? [{ label: st.rockets.rd.name + ' [R]', n: me.rk }] : []),
        ],
      };
      if (p.stall) info.warnings.push({ text: p.spin ? 'ШТОПОР! Отпустите ручку и опустите нос' : 'СВАЛИВАНИЕ! Нос вниз, газ!' });
      if (p.overheat) info.warnings.push({ text: 'Двигатель перегрет', color: '#ffb04a' });
      if (me.fire) info.warnings.push({ text: 'ПОЖАР! Разгонитесь в пикировании или прыгайте (E)', color: '#ff8a2a' });
      if (p.dead) info.warnings.push({ text: 'САМОЛЁТ СБИТ — E: катапультироваться!' });
      if (p.x < 0 || p.x > this.terrain.width) info.warnings.push({ text: 'ВЫ ПОКИДАЕТЕ ЗОНУ БОЯ' });
      if (s && s.z && (p.x < s.z[0] || p.x > s.z[1])) info.warnings.push({ text: 'ВНЕ ЗОНЫ — урон!' });
      if (me.rep) info.warnings.push({ text: 'Ремонт и перезарядка…', color: '#8fe09a' });
      const alt = p.y - this.terrain.ground(p.x);
      if (alt < 120 && p.vy < -60 && !p.ground) info.warnings.push({ text: 'ЗЕМЛЯ!' });
      this.leadIndicator(info, view, p, st);
      info.aim = { x: r.sx(myPos.x + Math.cos(p.a) * 220), y: r.sy(myPos.y + Math.sin(p.a) * 220) };
      info.arrows = this.arrows(view, myPos);
      info.hint = 'W/S газ · A/D (или M — мышь) · Space огонь · B бомба · R ракета · F переворот · E прыжок · Shift форсаж · Tab счёт';
    } else if (this.predKind === 'pilot' && me) {
      let hint = 'A/D бег · W прыжок · ЛКМ огонь · K сдаться';
      if (me.af) hint = 'E — взлететь с аэродрома!';
      else if (this.settings.respawnMode === 'timer' && me.prt <= 0 && this.mode !== 'br') hint = 'E — возродиться в воздухе';
      else if (this.settings.respawnMode === 'timer' && this.mode !== 'br') hint = `Возрождение через ${Math.ceil(me.prt)} с (или дойдите до аэродрома)`;
      else hint = 'Дойдите до своего аэродрома, чтобы взлететь';
      info.me = { kind: 'pilot', hpFrac: me.hp / me.mhp, hint };
      this.app.setSpawnButton(me.af || (this.settings.respawnMode === 'timer' && me.prt <= 0 && this.mode !== 'br'));
    } else if (me) {
      if (me.out) { info.center = 'Вы выбыли'; info.center2 = 'Наблюдение за боем'; }
      else if (me.s === 'dead') { info.center = 'Вы погибли'; info.center2 = `Возрождение через ${Math.ceil(me.rt || 0)} с`; }
    }
    if (this.predKind !== 'pilot') this.app.setSpawnButton(false);
    drawHud(r, info);
  }

  leadIndicator(info, view, p, st) {
    const w = st.guns[0] ? st.guns[0].wd : null;
    if (!w) return;
    let best = null, bs = 1e9;
    for (const o of view.planes) {
      if (o.isMe || o.dead || !this.hostileId(o.owner) || o.cloud) continue;
      const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
      if (d > 1100) continue;
      const off = Math.abs(wrapAngle(Math.atan2(dy, dx) - p.a));
      if (off > 1.1) continue;
      const sc = d * (1 + off);
      if (sc < bs) { bs = sc; best = o; }
    }
    if (!best) return;
    let rx = best.x - p.x, ry = best.y - p.y, t = Math.hypot(rx, ry) / w.speed, ax = rx, ay = ry;
    for (let k = 0; k < 3; k++) { ax = rx + (best.vx - p.vx) * t; ay = ry + (best.vy - p.vy) * t; t = Math.hypot(ax, ay) / w.speed; }
    const r = this.r;
    const lx = p.x + ax, ly = p.y + ay;
    const good = Math.abs(wrapAngle(Math.atan2(ay, ax) - p.a)) < 0.06 && Math.hypot(ax, ay) < w.speed * w.life;
    info.lead = { x: r.sx(lx), y: r.sy(ly), x2: r.sx(best.x), y2: r.sy(best.y), good };
  }

  arrows(view, myPos) {
    const r = this.r, out = [];
    for (const o of view.planes) {
      if (o.isMe || o.dead || !this.hostileId(o.owner) || o.cloud) continue;
      if (r.visible(o.x, o.y, -30)) continue;
      const d = Math.hypot(o.x - myPos.x, o.y - myPos.y);
      if (d > 2600) continue;
      const ang = Math.atan2(-(o.y - myPos.y), o.x - myPos.x);
      const cx = r.W / 2, cy = r.H / 2;
      const k = Math.min((cx - 30) / Math.abs(Math.cos(ang) || 1e-6), (cy - 30) / Math.abs(Math.sin(ang) || 1e-6));
      out.push({ x: cx + Math.cos(ang) * k, y: cy + Math.sin(ang) * k, ang, color: '#ff5544' });
    }
    return out;
  }

  scoreboardHtml() {
    const s = this.latest; if (!s) return '';
    const rows = [...s.sc].sort((a, b) => b[3] - a[3] || b[1] - a[1]).map(x => {
      const r = this.roster.get(x[0]) || { name: '?', color: '#ccc', planeId: '' };
      const def = this.app.data.planes.find(p => p.id === r.planeId);
      return `<tr class="${x[0] === this.myId ? 'me' : ''}"><td style="color:${r.color}">${esc(r.name)}</td><td>${def ? esc(def.name) : ''}</td><td>${x[1]}</td><td>${x[2]}</td><td>${x[5]}</td><td>${x[3]}</td><td>${x[4] === 2 ? 'выбыл' : x[4] === 1 ? 'мёртв' : ''}</td></tr>`;
    }).join('');
    return `<table class="list"><thead><tr><th>Пилот</th><th>Самолёт</th><th>Сбито</th><th>Смерти</th><th>Наземка</th><th>Очки</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}

export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
