// Авторитарная симуляция матча: самолёты, пилоты, оружие, попадания, наземные объекты, режимы.
import {
  DT, TICK_RATE, PHYS_SUBSTEPS, SNAPSHOT_EVERY, GRAVITY, CEILING, TEAM_COLORS, FFA_COLORS, MODES,
  clamp, wrapAngle,
} from '../shared/constants.js';
import { buildStats, createPlane, tickPlane, createPilot, tickPilot, packPlane, packPilot } from '../shared/physics.js';
import { getTerrain } from '../shared/maps.js';
import { PF, CF, PROJ, LIMITS } from '../shared/protocol.js';
import { sanityCheckPlane } from './anticheat.js';
import { GroundForces } from './ground.js';
import { botThink, botName } from './bots.js';
import { MODE_RULES } from './modes.js';

const PILOT_HP = 40;
const MAX_REWIND = 15;            // компенсация лага: не больше 15 тиков (500 мс) назад
const HIST = 32;                  // глубина истории позиций самолётов (тиков)
const STARVE_TICKS = 9;           // ввод не приходит 300 мс → нейтральный ввод (вкладка в фоне, обрыв)
const PILOT_GUN = { dmg: 4, rof: 6, speed: 700, spread: 0.05, life: 0.8 };

let eidSeq = 1;

export class Game {
  constructor(room, data, onEnd, opts = {}) {
    this.room = room;
    this.data = data;
    this.settings = { ...room.settings };
    this.mode = this.settings.mode;
    this.rules = MODE_RULES[this.mode];
    this.teams = MODES[this.mode].teams;
    this.terrain = getTerrain(this.settings.map);
    this.map = this.terrain.map;
    this.onEnd = onEnd;
    this.tickN = 0;
    this.time = 0;
    this.timeLimit = this.settings.timeLimit * 60;
    this.users = new Map();      // id -> участник
    this.planes = new Map();     // eid -> самолёт
    this.bullets = [];
    this.projs = [];
    this.events = [];
    this.projSeq = 1;
    this.teamScore = [0, 0];
    this.ended = false;
    this.ground = new GroundForces(this);
    this.colorIdx = 0;
    this.rules.setup(this);

    for (const pl of room.players.values()) this.addHuman(pl, true);
    if (this.settings.bots) {
      const n = clamp(this.settings.botCount | 0, 0, Math.max(0, this.settings.maxPlayers - this.users.size));
      for (let i = 0; i < n; i++) this.addBot(i);
    }
    this.rules.afterSpawn && this.rules.afterSpawn(this);
    if (!opts.manual) this.startLoop();
  }

  // Точный игровой цикл: тики по накопленному времени, без дрейфа частоты (setInterval давал 30,19 Гц).
  startLoop() {
    const period = 1000 / TICK_RATE;
    let next = performance.now() + period;
    const loop = () => {
      if (this.ended) return;
      const now = performance.now();
      let n = 0;
      while (now >= next && n < 4) { this.safeTick(); next += period; n++; }
      if (now - next > 250) next = now + period;        // сильно отстали (пауза процесса) — не догоняем рывком
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(loop, period);
  }

  // ---------- участники ----------
  makeUser(id, name, isBot) {
    return {
      id, name, isBot, client: null, team: -1, color: '#fff', planeId: null, def: null, st: null,
      state: 'dead', planeEid: 0, pilot: null, pilotHp: PILOT_HP, pilotGunT: 0,
      inputQ: [], lastInput: { p: 0, t: 0 }, lastSeq: 0, respawnT: 1, pilotRespawnT: 0, lives: 99, out: false,
      viewTick: 0, starve: 0, qOver: 0,
      stats: { kills: 0, deaths: 0, damage: 0, ground: 0, score: 0, pilotKills: 0 },
      bot: null, lastHitBy: null, lastHitT: -99, spawnedOnce: false,
    };
  }

  pickTeam() {
    if (!this.teams) return -1;
    let a = 0, b = 0;
    for (const u of this.users.values()) { if (u.team === 0) a++; else if (u.team === 1) b++; }
    return a <= b ? 0 : 1;
  }

  addHuman(pl, initial = false) {
    if (!initial) this.freeSlotFor(pl);
    const u = this.makeUser(pl.id, pl.name, false);
    u.client = pl;
    u.team = this.teams ? (pl.team === 0 || pl.team === 1 ? pl.team : this.pickTeam()) : -1;
    u.color = this.teams ? TEAM_COLORS[u.team] : FFA_COLORS[this.colorIdx++ % FFA_COLORS.length];
    this.setPlane(u, pl.planeId);
    this.users.set(u.id, u);
    if (!initial && this.rules.lateJoin) this.rules.lateJoin(this, u);
    u.respawnT = initial ? 0.5 : 1.5;
    if (!initial) this.broadcastRoster();
    return u;
  }

  // Вход в идущий матч: если участников уже максимум — бот уступает место (из команды входящего).
  freeSlotFor(pl) {
    if (this.users.size < this.settings.maxPlayers) return;
    const bots = [...this.users.values()].filter(u => u.isBot);
    if (!bots.length) return;
    const team = this.teams ? (pl.team === 0 || pl.team === 1 ? pl.team : this.pickTeam()) : -1;
    const bot = bots.find(b => b.team === team && b.state !== 'plane') || bots.find(b => b.team === team) || bots[0];
    this.removeUser(bot);
    this.events.push(['msg', `${bot.name} уступает место`]);
  }

  // Переподключение: тот же участник, сбрасываем нумерацию ввода (клиент начинает с 1).
  resumeHuman(client) {
    const u = this.users.get(client.id);
    if (!u) return null;
    u.client = client; u.lastSeq = 0; u.inputQ.length = 0; u.starve = 0;
    return u;
  }

  renameUser(id, name) {
    const u = this.users.get(id);
    if (u && u.name !== name) { u.name = name; this.broadcastRoster(); }
  }

  addBot(i) {
    const id = 'b' + (i + 1) + '_' + Math.floor(Math.random() * 1e4);
    const u = this.makeUser(id, botName(i), true);
    u.team = this.pickTeam();
    u.color = this.teams ? TEAM_COLORS[u.team] : FFA_COLORS[this.colorIdx++ % FFA_COLORS.length];
    // боты берут самолёты из разрешённых
    const allowed = this.allowedPlanes();
    const weights = allowed.map(p => p.class === 'fighter' ? 4 : p.class === 'attacker' ? 2 : 1.2);
    let r = Math.random() * weights.reduce((a, b) => a + b, 0), pick = allowed[0];
    for (let k = 0; k < allowed.length; k++) { r -= weights[k]; if (r <= 0) { pick = allowed[k]; break; } }
    this.setPlane(u, pick ? pick.id : this.data.planes[0].id);
    u.bot = { diff: clamp(this.settings.botDifficulty | 0, 0, 2) };
    u.respawnT = 0.5 + Math.random();
    this.users.set(id, u);
  }

  allowedPlanes() {
    const s = this.settings;
    const list = this.data.planes.filter(p => s.nations.includes(p.nation) && s.classes.includes(p.class));
    return list.length ? list : this.data.planes.filter(p => p.tier === 1);
  }

  setPlane(u, planeId) {
    const allowed = this.allowedPlanes();
    let def = allowed.find(p => p.id === planeId);
    const owns = p => u.isBot || (u.client && u.client.profile && u.client.profile.unlocked.includes(p.id));
    if (def && !owns(def)) def = null;
    if (!def) def = allowed.find(owns) || allowed.find(p => p.cost === 0) || this.data.planes.find(p => p.cost === 0);
    u.planeId = def.id; u.def = def;
    const ups = (!u.isBot && u.client && u.client.profile && u.client.profile.upgrades[def.id]) || (u.isBot ? botUpgrades(this.settings.botDifficulty) : {});
    u.st = buildStats(def, ups, this.data);
  }

  removeHuman(id) {
    const u = this.users.get(id);
    if (!u) return;
    // вышел из матча под огнём — фраг тому, кто попал последним
    if (u.state === 'plane') this.creditLoss(u, this.planes.get(u.planeEid), 'crash');
    this.removeUser(u);
    this.rules.checkEnd && this.checkEnd();
  }

  removeUser(u) {
    if (u.planeEid) { const pl = this.planes.get(u.planeEid); if (pl) { pl.owner = null; pl.abandonedBy = null; pl.p.dead = true; } }
    this.users.delete(u.id);
    this.broadcastRoster();
  }

  // Потеря самолёта без прямого сбития (катапульта, выход, падение): фраг недавно попавшему врагу и смерть.
  creditLoss(u, pl, how) {
    if (!pl || pl.killedCredited || pl.p.ground) return;
    pl.killedCredited = true;
    const killer = (u.lastHitBy && this.time - u.lastHitT < 10 && this.users.has(u.lastHitBy.id) && this.hostile(u.lastHitBy, u)) ? u.lastHitBy : null;
    this.events.push(['kill', killer ? killer.id : '', u.id, how]);
    u.stats.deaths++;
    if (killer) { killer.stats.kills++; killer.stats.score += 2; this.rules.onKill(this, killer, u, false); }
  }

  roster() {
    return [...this.users.values()].map(u => ({ id: u.id, name: u.name, team: u.team, color: u.color, planeId: u.planeId, bot: u.isBot }));
  }
  broadcastRoster() {
    const msg = JSON.stringify({ t: 'roster', roster: this.roster() });
    for (const u of this.users.values()) if (u.client) u.client.sendRaw(msg);
  }

  matchInfo(u) {
    return {
      t: 'match', map: this.settings.map, mode: this.mode, settings: this.settings, roster: this.roster(),
      ground: this.ground.staticInfo(), you: u.id, tick: this.tickN,
    };
  }

  handleInput(id, inp) {
    const u = this.users.get(id);
    if (!u || u.isBot) return;
    if (inp.s <= u.lastSeq) return;
    if (u.inputQ.length && inp.s <= u.inputQ[u.inputQ.length - 1].s) return;
    u.inputQ.push(inp);
    while (u.inputQ.length > LIMITS.INPUT_QUEUE) {
      // клиент шлёт ввод быстрее тиков сервера — отбрасываем лишнее (защита от спидхака)
      const dropped = u.inputQ.shift();
      if (dropped.b || dropped.r || dropped.fl || dropped.e || dropped.j || dropped.k) {
        const n = u.inputQ[0]; n.b |= dropped.b; n.r |= dropped.r; n.fl |= dropped.fl; n.e |= dropped.e; n.j |= dropped.j; n.k |= dropped.k;
      }
    }
  }

  // Может ли оружие участника a ранить b (с учётом настройки «огонь по своим»).
  canDamage(a, b) {
    if (!a || !b || a === b || a.id === b.id) return false;
    return this.hostile(a, b) || !!this.settings.friendlyFire;
  }

  bulletHostile(b, u) {
    if (b.o) return this.canDamage(b.o, u);
    return b.team === -2 || (b.team >= 0 && u.team >= 0 && u.team !== b.team);
  }

  hostile(a, b) {
    if (!a || !b || a === b || a.id === b.id) return false;
    if (a.team < 0 || b.team < 0) return true;
    return a.team !== b.team;
  }

  // ---------- спавн ----------
  airfieldFor(u) {
    const afs = this.map.airfields;
    if (u.team >= 0) return afs.find(a => a.team === u.team) || afs[0];
    return afs[Math.floor(Math.random() * afs.length)];
  }

  spawnPlane(u, onRunway = false, af = null) {
    if (u.pendingPlane) { this.setPlane(u, u.pendingPlane); u.pendingPlane = null; }
    af = af || this.airfieldFor(u);
    const toRight = (af.x0 + af.x1) / 2 < this.terrain.width / 2;
    let x, y, a, speed;
    if (this.rules.spawnPoint && !onRunway) {
      ({ x, y, a } = this.rules.spawnPoint(this, u));
      speed = u.st.vstall * 1.9;
    } else if (onRunway) {
      x = toRight ? af.x0 + 40 : af.x1 - 40; y = af.h + 5 * u.st.size; a = toRight ? 0 : Math.PI; speed = 0;
    } else {
      x = toRight ? af.x1 - Math.random() * 700 : af.x0 + Math.random() * 700;
      y = af.h + 350 + Math.random() * 450; a = toRight ? 0.05 : Math.PI - 0.05; speed = u.st.vstall * 1.9;
    }
    const p = createPlane(u.st, x, y, a, speed, onRunway);
    if (onRunway) p.thr = 0.2;
    const eid = eidSeq++;
    const pl = { eid, owner: u, st: u.st, def: u.def, p, pc: this.freshCombat(u.st), protect: onRunway ? 3 : 2, collideT: 0 };
    this.planes.set(eid, pl);
    u.planeEid = eid; u.state = 'plane'; u.pilot = null; u.spawnedOnce = true;
    u.inputQ.length = 0;
    if (u.bot) u.bot.reset = true;
    return pl;
  }

  freshCombat(st) {
    return {
      hp: st.maxHp, ammo: st.guns.map(g => Math.round(g.ammo * st.ammoMul)), gunT: st.guns.map(() => 0),
      gunHeat: 0, gunOver: false, bombs: st.bombs ? st.bombs.count : 0, rockets: st.rockets ? Math.round(st.rockets.count * (1 + (st.ammoMul - 1) * 0.5)) : 0,
      bombT: 0, rocketT: 0, fire: 0, gunnerT: st.gunners.map(() => Math.random()), repairing: false,
    };
  }

  // ---------- тик ----------
  safeTick() {
    const t0 = performance.now();
    try { this.tick(); } catch (e) { console.error('Ошибка симуляции:', e); }
    const ms = performance.now() - t0;
    const m = this.metrics || (this.metrics = { samples: new Float64Array(9000), n: 0, max: 0, startWall: Date.now(), startTick: this.tickN });
    m.samples[m.n % m.samples.length] = ms; m.n++; if (ms > m.max) m.max = ms;
  }

  // Статистика длительности тика (для нагрузочного теста, /metrics).
  tickStats() {
    const m = this.metrics;
    if (!m || !m.n) return null;
    const arr = Array.from(m.samples.subarray(0, Math.min(m.n, m.samples.length))).sort((a, b) => a - b);
    const q = f => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
    const wall = (Date.now() - m.startWall) / 1000;
    return { ticks: m.n, avgMs: arr.reduce((a, b) => a + b, 0) / arr.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), maxMs: m.max,
      actualHz: wall > 0 ? (this.tickN - m.startTick) / wall : 0, planes: this.planes.size, bullets: this.bullets.length, projs: this.projs.length,
      users: this.users.size };
  }

  tick() {
    if (this.ended) return;
    this.tickN++;
    this.time += DT;
    for (const u of this.users.values()) this.updateUser(u);
    for (const pl of this.planes.values()) this.updatePlane(pl);
    for (const pl of this.planes.values()) this.recordHistory(pl);
    this.collidePlanes();
    this.updateBullets();
    this.updateProjectiles();
    this.ground.tick(DT);
    this.rules.tick && this.rules.tick(this, DT);
    this.checkEnd();
    if (this.tickN % SNAPSHOT_EVERY === 0) this.sendSnapshots();
  }

  nextInput(u) {
    if (u.isBot) return botThink(this, u, DT);
    // Буфер ввода: если он долго длиннее 3 (клиент спешит или пачка после лага) — подрезаем, иначе растёт задержка.
    if (u.inputQ.length > 3) { if (++u.qOver > 30) { this.dropInput(u); u.qOver = 0; } } else u.qOver = 0;
    const inp = u.inputQ.shift();
    if (inp) {
      u.lastSeq = inp.s; u.starve = 0;
      if (typeof inp.rt === 'number') u.viewTick = clamp(Math.round(inp.rt), this.tickN - MAX_REWIND, this.tickN);
      u.lastInput = { ...inp, b: 0, r: 0, fl: 0, e: 0, j: 0, k: 0 };
      return inp;
    }
    // ввод не пришёл — повторяем последний (без однократных действий); если долго нет — нейтральный ввод
    if (++u.starve > STARVE_TICKS) return { p: 0, t: 0, ta: u.lastInput.ta, mx: 0, aim: u.lastInput.aim };
    return u.lastInput;
  }

  dropInput(u) {
    const d = u.inputQ.shift();
    const n = u.inputQ[0];
    if (d && n) for (const k of ['b', 'r', 'fl', 'e', 'j', 'k']) n[k] |= d[k];
  }

  updateUser(u) {
    const inp = this.nextInput(u) || {};
    if (u.state === 'plane') {
      const pl = this.planes.get(u.planeEid);
      if (!pl) { u.state = 'dead'; return; }
      pl.inp = inp;
      if (inp.e) this.eject(u, pl);
    } else if (u.state === 'pilot') {
      this.updatePilot(u, inp);
    } else if (u.state === 'dead') {
      if (u.out) return;
      u.respawnT -= DT;
      if (u.respawnT <= 0 && this.rules.canRespawn(this, u)) this.spawnPlane(u);
    }
  }

  eject(u, pl) {
    const p = pl.p;
    // катапультирование в воздухе = потеря самолёта; под огнём — фраг атакующему
    if (!p.dead) this.creditLoss(u, pl, 'eject');
    const c = createPilot(p.x, p.y + 10, p.vx * 0.5, p.vy * 0.5 + 110);
    if (p.ground) { c.vx = 0; c.vy = 0; c.ground = true; c.y = this.terrain.ground(p.x) + 6; }
    u.pilot = c; u.pilotHp = PILOT_HP; u.state = 'pilot'; u.planeEid = 0;
    u.pilotRespawnT = this.settings.respawnTime;
    pl.owner = null; pl.abandonedBy = u; p.dead = true; p.deadSpin = (Math.random() - 0.5) * 0.6;
    if (pl.pc.hp > 0 && !p.ground) pl.pc.hp = Math.min(pl.pc.hp, 1);
    this.events.push(['msg', `${u.name} катапультировался`]);
  }

  updatePilot(u, inp) {
    const c = u.pilot;
    tickPilot(c, inp, DT, PHYS_SUBSTEPS, this.terrain, this.terrain.width);
    if (c.contact === 'splat') { this.killPilot(u, null, 'crash'); return; }
    if (c.landingDamage > 0) {                          // ушибся при падении (прыжок с обрыва и т.п.)
      u.pilotHp -= c.landingDamage; c.landingDamage = 0;
      if (u.pilotHp <= 0) { this.killPilot(u, null, 'crash'); return; }
    }
    if (c.ground || c.swim) u.pilotRespawnT -= DT;
    // стрельба из автомата
    u.pilotGunT -= DT;
    if (inp.f && !c.swim && u.pilotGunT <= 0) {
      u.pilotGunT = 1 / PILOT_GUN.rof;
      const a = c.aim + (Math.random() - 0.5) * PILOT_GUN.spread;
      const ox = c.x + Math.cos(c.aim) * 10, oy = c.y + 10 + Math.sin(c.aim) * 10;
      this.addBullet(u, null, ox, oy, Math.cos(a) * PILOT_GUN.speed, Math.sin(a) * PILOT_GUN.speed, PILOT_GUN.dmg, PILOT_GUN.life, false, 'pistol');
    }
    // взлёт с аэродрома или возрождение по таймеру
    if (inp.e && (c.ground)) {
      const af = this.terrain.airfieldAt(c.x, c.y);
      if (af && (af.team === u.team || u.team < 0) && this.rules.canRespawn(this, u, true)) { this.spawnPlane(u, true, af); return; }
      if (this.settings.respawnMode === 'timer' && u.pilotRespawnT <= 0 && this.rules.canRespawn(this, u)) { this.spawnPlane(u); return; }
    }
    if (inp.k) { this.killPilot(u, null, 'suicide'); return; }
    // зона/границы
    const dmgZ = this.rules.zoneDamage ? this.rules.zoneDamage(this, c.x) : 0;
    if (dmgZ) { u.pilotHp -= dmgZ * 0.5 * DT; if (u.pilotHp <= 0) this.killPilot(u, null, 'zone'); }
  }

  killPilot(u, killer, how) {
    if (u.state !== 'pilot') return;
    const c = u.pilot;
    this.events.push(['kill', killer ? killer.id : '', u.id, how === 'crash' || how === 'suicide' || how === 'zone' ? how : 'pilot']);
    if (killer && this.hostile(killer, u)) { killer.stats.pilotKills++; killer.stats.score += 1; this.rules.onKill(this, killer, u, true); }
    this.events.push(['boom', Math.round(c.x), Math.round(c.y), 12]);
    u.pilot = null;
    this.userDied(u);
  }

  userDied(u) {
    u.state = 'dead'; u.planeEid = 0;
    u.respawnT = this.settings.respawnTime;
    this.rules.onDeath && this.rules.onDeath(this, u);
  }

  updatePlane(pl) {
    const p = pl.p, st = pl.st, pc = pl.pc;
    const u = pl.owner;
    const inp = (u && u.state === 'plane' && u.planeEid === pl.eid) ? (pl.inp || {}) : {};
    pl.protect = Math.max(0, pl.protect - DT);
    tickPlane(p, st, inp, DT, PHYS_SUBSTEPS, this.terrain);
    sanityCheckPlane(p, st);
    // жёсткая посадка: урон по скорости удара (рассчитан физикой)
    if (p.impact > 0) { const d = p.impact; p.impact = 0; this.damagePlane(pl, d, 'hull', null, 'crash', true); if (!this.planes.has(pl.eid)) return; }
    p.inCloud = this.terrain.inCloud(p.x, p.y);
    if (p.contact === 'crash' || p.contact === 'water') { this.crashPlane(pl, p.contact); return; }
    // столкновение со зданиями
    if (!p.ground) {
      const hitObj = this.ground.solidAt(p.x, p.y);
      if (hitObj) { this.ground.damage(hitObj, hitObj.type === 'hq' ? 120 : 400, u, true); this.crashPlane(pl, 'crash'); return; }
    }
    if (!u || p.dead) {
      // сбитый/брошенный самолёт: падает и горит
      if (pc.fire <= 0) pc.fire = 1;
      if (this.time - (pl.deadT ?? (pl.deadT = this.time)) > 25) this.planes.delete(pl.eid);
      return;
    }
    // ---- оружие ----
    pc.gunHeat = Math.max(0, pc.gunHeat - 0.38 * DT);
    if (pc.gunOver && pc.gunHeat < 0.35) pc.gunOver = false;
    const firing = inp.f && !pc.gunOver && !p.ground;
    for (let i = 0; i < st.guns.length; i++) {
      const g = st.guns[i], w = g.wd;
      pc.gunT[i] -= DT;
      if (firing && pc.ammo[i] > 0) {
        let guard = 0;
        while (pc.gunT[i] <= 0 && pc.ammo[i] > 0 && guard++ < 4) {
          pc.gunT[i] += 1 / w.rof;                        // скорострельность контролирует сервер
          pc.ammo[i]--;
          pc.gunHeat += w.heat;
          if (pc.gunHeat >= 1) { pc.gunHeat = 1; pc.gunOver = true; }
          const bloom = 1 + pc.gunHeat * 1.6 * st.recoilMul;  // «отдача»: разброс растёт при длинной очереди
          const a = p.a + (Math.random() - 0.5) * w.spread * st.spreadMul * bloom;
          const off = 16 * st.size;
          const side = (i % 2 ? -1 : 1) * 2;
          const ox = p.x + Math.cos(p.a) * off - Math.sin(p.a) * side, oy = p.y + Math.sin(p.a) * off + Math.cos(p.a) * side;
          this.addBullet(u, pl, ox, oy, p.vx + Math.cos(a) * w.speed, p.vy + Math.sin(a) * w.speed, w.dmg * g.count * st.dmgMul, w.life, w.explosive, g.w);
        }
      } else if (pc.gunT[i] < 0) pc.gunT[i] = 0;
    }
    pc.bombT -= DT; pc.rocketT -= DT;
    if (inp.b && pc.bombs > 0 && pc.bombT <= 0 && !p.ground) {
      pc.bombs--; pc.bombT = 0.35;
      const b = st.bombs.bd;
      this.addProj('bomb', u, p.x, p.y - 8 * st.size, p.vx, p.vy - 15, { dmg: b.dmg * st.dmgMul, r: b.radius, life: 30 });
    }
    if (inp.r && pc.rockets > 0 && pc.rocketT <= 0 && !p.ground) {
      pc.rockets--; pc.rocketT = 0.25;
      const rd = st.rockets.rd;
      this.addProj('rocket', u, p.x + Math.cos(p.a) * 10, p.y + Math.sin(p.a) * 10 - 4, p.vx + Math.cos(p.a) * rd.speed * 0.6, p.vy + Math.sin(p.a) * rd.speed * 0.6,
        { dmg: rd.dmg * st.dmgMul, r: rd.radius, life: 3.2, thrust: rd.speed, a: p.a });
    }
    // бортовые стрелки
    if (st.gunners.length) this.updateGunners(pl);
    // пожар
    if (pc.fire > 0) {
      pc.fire -= DT;
      this.damagePlane(pl, 7 * DT, 'fuel', pl.fireBy || null, 'fire', true);
      const v = Math.hypot(p.vx, p.vy);
      if (Math.random() < DT * (v > st.vmax * 0.95 ? 0.6 : 0.08)) pc.fire = 0;   // сбить пламя пикированием
    }
    // ремонт и перезарядка на своём аэродроме
    pc.repairing = false;
    if (p.ground && Math.hypot(p.vx, p.vy) < 45) {
      const af = this.terrain.airfieldAt(p.x);
      if (af && (af.team === u.team || u.team < 0)) this.repair(pl);
    }
    // границы карты, потолок, зона
    let dmg = 0;
    if (p.x < 0 || p.x > this.terrain.width) { pl.oob = (pl.oob || 0) + DT; if (pl.oob > 3) dmg += 20; if (p.x < -1500 || p.x > this.terrain.width + 1500) dmg += 500; }
    else pl.oob = 0;
    if (this.rules.zoneDamage) dmg += this.rules.zoneDamage(this, p.x);
    if (dmg) this.damagePlane(pl, dmg * DT, 'hull', null, 'zone', true);
  }

  recordHistory(pl) {
    const h = pl.hist || (pl.hist = new Array(HIST));
    const e = h[this.tickN % HIST] || (h[this.tickN % HIST] = {});
    e.k = this.tickN; e.x = pl.p.x; e.y = pl.p.y; e.a = pl.p.a;
  }

  // Поза самолёта N тиков назад (для компенсации лага); если истории нет — текущая.
  poseAt(pl, rewind) {
    if (rewind > 0 && pl.hist) {
      const e = pl.hist[(this.tickN - rewind) % HIST];
      if (e && e.k === this.tickN - rewind) return e;
    }
    return pl.p;
  }

  repair(pl) {
    const pc = pl.pc, st = pl.st, p = pl.p;
    pc.repairing = true;
    pc.hp = Math.min(st.maxHp, pc.hp + st.maxHp * 0.18 * DT);
    for (const k of ['engine', 'wing', 'tail', 'fuel']) p.parts[k] = Math.min(1, p.parts[k] + 0.25 * DT);
    pc.fire = 0;
    st.guns.forEach((g, i) => { const max = Math.round(g.ammo * st.ammoMul); pc.ammo[i] = Math.min(max, pc.ammo[i] + Math.ceil(max * 0.3 * DT)); });
    pl.reloadAcc = (pl.reloadAcc || 0) + DT;
    if (pl.reloadAcc > 1) {
      pl.reloadAcc = 0;
      if (st.bombs && pc.bombs < st.bombs.count) pc.bombs++;
      const rmax = st.rockets ? Math.round(st.rockets.count * (1 + (st.ammoMul - 1) * 0.5)) : 0;
      if (pc.rockets < rmax) pc.rockets = Math.min(rmax, pc.rockets + 2);
    }
  }

  updateGunners(pl) {
    const p = pl.p, st = pl.st, pc = pl.pc, u = pl.owner;
    const up = p.roll >= 0 ? 1 : -1;
    st.gunners.forEach((gn, i) => {
      pc.gunnerT[i] -= DT;
      if (pc.gunnerT[i] > 0) return;
      const w = gn.wd;
      const gx = p.x + Math.cos(p.a) * gn.x * 20 * st.size, gy = p.y + Math.sin(p.a) * gn.x * 20 * st.size;
      const center = p.a + gn.dir * up;
      let best = null, bd = 560;
      for (const o of this.planes.values()) {
        if (!o.owner || o.p.dead || !this.hostile(u, o.owner) || o.p.inCloud) continue;
        const dx = o.p.x - gx, dy = o.p.y - gy, d = Math.hypot(dx, dy);
        if (d > bd) continue;
        const ang = Math.atan2(dy, dx);
        if (Math.abs(wrapAngle(ang - center)) > gn.arc) continue;
        best = o; bd = d;
      }
      if (!best) { pc.gunnerT[i] = 0.3; return; }
      pc.gunnerT[i] = 1 / (w.rof * 0.6);
      const t = bd / w.speed;
      const tx = best.p.x + (best.p.vx - p.vx) * t, ty = best.p.y + (best.p.vy - p.vy) * t;
      const a = Math.atan2(ty - gy, tx - gx) + (Math.random() - 0.5) * w.spread * 3;
      this.addBullet(u, pl, gx, gy, p.vx + Math.cos(a) * w.speed, p.vy + Math.sin(a) * w.speed, w.dmg * gn.count * 0.8, w.life * 0.7, w.explosive, gn.w, true);
    });
  }

  addBullet(u, pl, x, y, vx, vy, dmg, life, explosive, w, gunner = false) {
    // компенсация лага: пуля игрока сверяется с позициями целей в тот тик, который он видел на экране
    const rewind = u && !u.isBot && u.viewTick ? clamp(this.tickN - u.viewTick, 0, MAX_REWIND) : 0;
    this.bullets.push({ o: u, eid: pl ? pl.eid : 0, x, y, vx, vy, dmg, life, explosive, w, rewind: gunner ? 0 : rewind });
    this.events.push(['shot', pl ? pl.eid : 'c' + u.id, Math.round(x), Math.round(y), Math.round(vx), Math.round(vy), w, +life.toFixed(2), gunner ? 1 : 0]);
  }

  addProj(type, u, x, y, vx, vy, opt) {
    const pr = { id: this.projSeq++, type, o: u, team: u ? u.team : -1, x, y, vx, vy, ...opt };
    this.projs.push(pr);
    return pr;
  }

  // ---------- попадания ----------
  planeHit(pl, x0, y0, dx, dy, pad = 0, rewind = 0) {
    const p = this.poseAt(pl, rewind), s = pl.st.size;
    const ca = Math.cos(p.a), sa = Math.sin(p.a);
    const r = 10 * s + pad;
    let best = -1;
    for (const k of [-0.6, 0.6]) {
      const cx = p.x + ca * 13 * s * k * 1.4, cy = p.y + sa * 13 * s * k * 1.4;
      const t = segCircle(x0, y0, dx, dy, cx, cy, r);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  hitPart(pl, hx, hy, rewind = 0) {
    const p = this.poseAt(pl, rewind), s = pl.st.size;
    const u = ((hx - p.x) * Math.cos(p.a) + (hy - p.y) * Math.sin(p.a)) / s;
    if (u > 8) return 'engine';
    if (u < -10) return 'tail';
    return Math.random() < 0.6 ? 'wing' : 'fuel';
  }

  damagePlane(pl, dmg, part, attacker, weapon, direct = false) {
    const pc = pl.pc, p = pl.p, st = pl.st;
    if (pc.hp <= 0 || dmg <= 0) return;
    if (pl.protect > 0 && attacker) return;
    if (!direct) {
      const heavy = weapon === 'cannon' || weapon === 'hcannon' || weapon === 'flak' || weapon === 'boom';
      dmg *= 1 - st.armor * (heavy ? 0.5 : 1.2);
      dmg = Math.max(dmg, 0.3);
    }
    pc.hp -= dmg;
    if (attacker && pl.owner && attacker !== pl.owner) {
      attacker.stats.damage += dmg;
      pl.owner.lastHitBy = attacker; pl.owner.lastHitT = this.time;
    }
    if (part !== 'hull') {
      const prev = p.parts[part];
      p.parts[part] = Math.max(0, prev - dmg / (st.maxHp * 0.32));
      if (part === 'fuel' && pc.fire <= 0 && Math.random() < (p.parts.fuel < 0.5 ? 0.16 : 0.04) * (weapon === 'fire' ? 0 : 1)) {
        pc.fire = 8; pl.fireBy = attacker;
      }
      if (part === 'wing' && p.parts.wing <= 0) pc.hp = 0; // крыло отломилось
    }
    if (pc.hp <= 0) this.downPlane(pl, attacker, weapon);
  }

  downPlane(pl, attacker, weapon) {
    const p = pl.p;
    if (p.dead) { pl.pc.hp = 0; return; }
    p.dead = true; p.deadSpin = (Math.random() - 0.5) * 1.6;
    pl.pc.hp = 0; pl.pc.fire = 99;
    const u = pl.owner;
    if (!u) return;
    let killer = attacker;
    if (!killer && u.lastHitBy && this.time - u.lastHitT < 10) killer = u.lastHitBy;
    if (killer && !this.hostile(killer, u)) killer = null;
    this.events.push(['kill', killer ? killer.id : '', u.id, weapon === 'zone' ? 'zone' : (weapon || 'gun')]);
    this.events.push(['boom', Math.round(p.x), Math.round(p.y), 25]);
    if (killer && this.hostile(killer, u)) { killer.stats.kills++; killer.stats.score += 2; this.rules.onKill(this, killer, u, false); }
    pl.killedCredited = true;
    u.stats.deaths++;
  }

  crashPlane(pl, how) {
    const p = pl.p, u = pl.owner;
    this.planes.delete(pl.eid);
    if (how === 'water') this.events.push(['splash', Math.round(p.x), 1]);
    else {
      this.events.push(['boom', Math.round(p.x), Math.round(p.y), 70]);
      this.ground.explosion(p.x, p.y, 70, 120, u || pl.abandonedBy, null);
    }
    if (u && u.planeEid === pl.eid) {
      const v = Math.hypot(p.vx, p.vy);
      if (!p.dead && !pl.killedCredited) {
        let killer = (u.lastHitBy && this.time - u.lastHitT < 10) ? u.lastHitBy : null;
        this.events.push(['kill', killer ? killer.id : '', u.id, 'crash']);
        u.stats.deaths++;
        if (killer && this.hostile(killer, u)) { killer.stats.kills++; killer.stats.score += 2; this.rules.onKill(this, killer, u, false); }
      }
      // посадка на воду на малой скорости — пилот выживает
      if (how === 'water' && v < u.st.vstall * 1.3 && !p.dead) {
        const c = createPilot(p.x, 0, 0, 0); c.swim = true;
        u.pilot = c; u.pilotHp = PILOT_HP; u.state = 'pilot'; u.planeEid = 0; u.pilotRespawnT = this.settings.respawnTime;
        return;
      }
      this.userDied(u);
    }
  }

  collidePlanes() {
    const arr = [...this.planes.values()];
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (a.p.ground && b.p.ground) continue;
      const r = 9 * (a.st.size + b.st.size);
      const dx = a.p.x - b.p.x, dy = a.p.y - b.p.y;
      if (dx * dx + dy * dy > r * r) continue;
      if (this.time - (a.collideT || -9) < 0.5) continue;
      a.collideT = b.collideT = this.time;
      const rel = Math.hypot(a.p.vx - b.p.vx, a.p.vy - b.p.vy);
      // урон от тарана зависит от относительной скорости и массы встречного самолёта
      const base = 20 + rel * 0.5, ma = a.st.mass || 4, mb = b.st.mass || 4;
      const dmgA = base * 2 * mb / (ma + mb), dmgB = base * 2 * ma / (ma + mb);
      this.events.push(['hit', Math.round((a.p.x + b.p.x) / 2), Math.round((a.p.y + b.p.y) / 2), 0, 1]);
      const ao = a.owner, bo = b.owner;
      if (ao && bo && !this.hostile(ao, bo)) continue;   // свои не таранят друг друга
      this.damagePlane(a, dmgA, 'wing', bo, 'ram', true);
      this.damagePlane(b, dmgB, 'wing', ao, 'ram', true);
    }
  }

  updateBullets() {
    const users = [...this.users.values()];
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= DT;
      const dx = b.vx * DT, dy = (b.vy - 15 * DT) * DT;
      let hit = false;
      // самолёты
      let bestT = 2, bestPl = null;
      for (const pl of this.planes.values()) {
        if (pl.eid === b.eid) continue;
        if (pl.owner ? !this.bulletHostile(b, pl.owner) : false) continue;
        if (!pl.owner && pl.abandonedBy === b.o) continue;
        const t = this.planeHit(pl, b.x, b.y, dx, dy, 0, b.rewind);
        if (t >= 0 && t < bestT) { bestT = t; bestPl = pl; }
      }
      if (bestPl) {
        const hx = b.x + dx * bestT, hy = b.y + dy * bestT;
        const part = this.hitPart(bestPl, hx, hy, b.rewind);
        this.damagePlane(bestPl, b.dmg, part, b.o, b.w);
        this.events.push(['hit', Math.round(hx), Math.round(hy), bestPl.eid, b.explosive ? 1 : 0, b.o ? b.o.id : '']);
        hit = true;
      }
      // пилоты
      if (!hit) for (const u of users) {
        if (u.state !== 'pilot' || !this.bulletHostile(b, u)) continue;
        const c = u.pilot;
        if (segCircle(b.x, b.y, dx, dy, c.x, c.y + 9, c.chute ? 10 : 8) >= 0) {
          u.pilotHp -= b.dmg * 1.2;
          this.events.push(['hit', Math.round(c.x), Math.round(c.y + 9), 0, 0, b.o ? b.o.id : '']);
          if (u.pilotHp <= 0) this.killPilot(u, b.o, 'pilot');
          hit = true; break;
        }
      }
      // наземные объекты
      if (!hit) {
        const o = this.ground.hitTest(b.x, b.y, dx, dy, b.o, b.team);
        // капитальные постройки (штаб, ангар, здания) почти не берутся пулемётами — нужны бомбы, ракеты, пушки
        const hard = o && (o.type === 'hq' || o.type === 'hangar' || o.type === 'building');
        if (o) { this.ground.damage(o, b.dmg * (b.explosive ? (hard ? 0.6 : 1.3) : (hard ? 0.15 : 0.6)), b.o); this.events.push(['hit', Math.round(b.x + dx), Math.round(b.y + dy), 0, 0]); hit = true; }
      }
      b.x += dx; b.y += dy; b.vy -= 30 * DT;
      if (!hit && b.y < this.terrain.ground(b.x)) hit = true;
      if (hit || b.life <= 0) { this.bullets[i] = this.bullets[this.bullets.length - 1]; this.bullets.pop(); }
    }
  }

  updateProjectiles() {
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const pr = this.projs[i];
      pr.life -= DT;
      if (pr.type === 'rocket') {
        const v = Math.hypot(pr.vx, pr.vy) || 1;
        if (v < pr.thrust) { pr.vx += Math.cos(pr.a) * pr.thrust * 1.5 * DT; pr.vy += Math.sin(pr.a) * pr.thrust * 1.5 * DT; }
        pr.vy -= 25 * DT;
      } else if (pr.type === 'flak') {
        // разрывы зенитных снарядов по взрывателю
      } else {
        pr.vy -= GRAVITY * DT;
        pr.vx *= 1 - 0.05 * DT;
      }
      const dx = pr.vx * DT, dy = pr.vy * DT;
      let boom = false;
      if (pr.type === 'flak') {
        pr.x += dx; pr.y += dy;
        if (pr.life <= 0) { this.flakBurst(pr); this.projs.splice(i, 1); }
        continue;
      }
      // контакт с самолётами (ракеты и снаряды)
      if (pr.type !== 'bomb' || true) {
        for (const pl of this.planes.values()) {
          if (pl.owner === pr.o || (pl.owner && pr.o && !this.canDamage(pr.o, pl.owner))) continue;
          if (!pr.o && pl.owner && pl.owner.team === pr.team) continue;
          if (this.planeHit(pl, pr.x, pr.y, dx, dy, 2) >= 0) { boom = true; this.damagePlane(pl, pr.dmg * 0.6, 'fuel', pr.o, 'boom'); break; }
        }
      }
      if (!boom && this.ground.hitTest(pr.x, pr.y, dx, dy, pr.o, pr.team)) boom = true;
      pr.x += dx; pr.y += dy;
      const gy = this.terrain.ground(pr.x);
      if (!boom && pr.y <= gy) { boom = true; pr.y = gy; }
      if (boom || pr.life <= 0) {
        this.explode(pr);
        this.projs[i] = this.projs[this.projs.length - 1]; this.projs.pop();
      }
    }
  }

  explode(pr) {
    if (this.terrain.water(pr.x) && pr.y <= 2) this.events.push(['splash', Math.round(pr.x), pr.r > 60 ? 1 : 0]);
    else this.events.push(['boom', Math.round(pr.x), Math.round(pr.y), Math.round(pr.r)]);
    this.areaDamage(pr.x, pr.y, pr.r, pr.dmg, pr.o, pr.team);
  }

  areaDamage(x, y, r, dmg, owner, team) {
    this.ground.explosion(x, y, r, dmg, owner, team);
    for (const u of this.users.values()) {
      if (u.state !== 'pilot') continue;
      if (owner ? !this.canDamage(owner, u) && owner !== u : u.team === team) continue;
      const d = Math.hypot(u.pilot.x - x, u.pilot.y + 8 - y);
      if (d < r * 1.1) { u.pilotHp -= dmg * (1 - d / (r * 1.1)) + 20; if (u.pilotHp <= 0) this.killPilot(u, owner && owner !== u ? owner : null, 'pilot'); }
    }
    for (const pl of this.planes.values()) {
      if (pl.owner && owner && !this.canDamage(owner, pl.owner)) continue;
      if (!owner && pl.owner && pl.owner.team === team) continue;
      const d = Math.hypot(pl.p.x - x, pl.p.y - y);
      if (d < r * 0.7) this.damagePlane(pl, dmg * 0.5 * (1 - d / (r * 0.7)), 'hull', owner, 'boom');
    }
  }

  flakBurst(pr) {
    this.events.push(['flak', Math.round(pr.x), Math.round(pr.y)]);
    for (const pl of this.planes.values()) {
      if (!pl.owner || pl.p.dead) continue;
      if (!this.ground.hostileTo(pr.src, pl.owner)) continue;
      const d = Math.hypot(pl.p.x - pr.x, pl.p.y - pr.y);
      if (d < 60) {
        const parts = ['engine', 'wing', 'tail', 'fuel'];
        this.damagePlane(pl, pr.dmg * (1 - d / 70), parts[Math.floor(Math.random() * 4)], null, 'flak');
        if (pl.pc.hp <= 0 && pl.owner) { /* сбит ПВО */ }
      }
    }
  }

  // ---------- конец матча ----------
  checkEnd() {
    if (this.ended) return;
    const res = this.rules.checkEnd(this);
    if (res) this.finish(res);
  }

  finish(res) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    const results = [...this.users.values()].map(u => ({
      id: u.id, name: u.name, team: u.team, bot: u.isBot, planeId: u.planeId, color: u.color,
      kills: u.stats.kills, deaths: u.stats.deaths, damage: Math.round(u.stats.damage), ground: u.stats.ground,
      pilotKills: u.stats.pilotKills, score: u.stats.score,
      won: res.winnerTeam !== undefined && res.winnerTeam !== null ? u.team === res.winnerTeam : res.winnerId === u.id,
    })).sort((a, b) => b.score - a.score || b.kills - a.kills);
    this.onEnd({ results, ...res, mode: this.mode, teamScore: this.teamScore });
  }

  stop() { this.ended = true; clearTimeout(this.timer); }

  // ---------- снапшоты ----------
  sendSnapshots() {
    const P = [];
    for (const pl of this.planes.values()) {
      const p = pl.p;
      let f = 0;
      if (p.boosting) f |= PF.BOOST; if (pl.pc.fire > 0) f |= PF.FIRE; if (p.dead) f |= PF.DEAD; if (p.stall) f |= PF.STALL;
      if (p.inCloud) f |= PF.CLOUD; if (p.ground) f |= PF.GROUND;
      P.push([pl.eid, pl.owner ? pl.owner.id : (pl.abandonedBy ? pl.abandonedBy.id : ''), pl.def.id, r1(p.x), r1(p.y), r3(p.a), r2(p.roll), r1(p.vx), r1(p.vy),
        r2(p.thr), f, Math.round(100 * pl.pc.hp / pl.st.maxHp), r2(p.parts.engine), r2(p.parts.wing), r2(p.parts.tail), r2(p.parts.fuel), pl.pc.bombs, pl.pc.rockets]);
    }
    const C = [];
    for (const u of this.users.values()) {
      if (u.state !== 'pilot') continue;
      const c = u.pilot;
      let f = 0; if (c.chute) f |= CF.CHUTE; if (c.ground) f |= CF.GROUND; if (c.swim) f |= CF.SWIM;
      C.push([u.id, r1(c.x), r1(c.y), r1(c.vx), r1(c.vy), r2(c.aim), f]);
    }
    const R = this.projs.filter(p => p.type !== 'flak').map(p => [p.id, PROJ[p.type], r1(p.x), r1(p.y), r1(p.vx), r1(p.vy)]);
    const G = this.ground.snapshot();
    const base = {
      t: 's', k: this.tickN, tl: Math.max(0, Math.round(this.timeLimit - this.time)), ts: this.teamScore, P, C, R, G,
      z: this.rules.zone ? this.rules.zone(this) : null, x: this.rules.extra ? this.rules.extra(this) : null,
      sc: [...this.users.values()].map(u => [u.id, u.stats.kills, u.stats.deaths, u.stats.score, u.state === 'dead' ? (u.out ? 2 : 1) : 0, u.stats.ground]),
    };
    const ev = this.events; this.events = [];
    for (const u of this.users.values()) {
      if (!u.client) continue;
      const msg = { ...base, E: this.filterEvents(ev, u), me: this.meState(u) };
      u.client.send(msg);
    }
  }

  focusOf(u) {
    if (u.state === 'plane') { const pl = this.planes.get(u.planeEid); if (pl) return pl.p; }
    if (u.state === 'pilot') return u.pilot;
    return null;
  }

  filterEvents(ev, u) {
    const f = this.focusOf(u);
    if (!f) return ev;
    return ev.filter(e => e[0] !== 'shot' || (Math.abs(e[2] - f.x) < 2200 && Math.abs(e[3] - f.y) < 1500));
  }

  meState(u) {
    const m = { s: u.state, seq: u.lastSeq, plane: u.planeId, rt: u.state === 'dead' ? r1(Math.max(0, u.respawnT)) : null, out: u.out };
    if (u.state === 'plane') {
      const pl = this.planes.get(u.planeEid);
      if (pl) {
        m.eid = pl.eid; m.pl = packPlane(pl.p); m.hp = Math.round(pl.pc.hp); m.mhp = pl.st.maxHp;
        m.am = pl.pc.ammo; m.bm = pl.pc.bombs; m.rk = pl.pc.rockets; m.gh = r2(pl.pc.gunHeat); m.go = pl.pc.gunOver ? 1 : 0;
        m.rep = pl.pc.repairing ? 1 : 0; m.fire = pl.pc.fire > 0 ? 1 : 0; m.prot = pl.protect > 0 ? 1 : 0;
      }
    } else if (u.state === 'pilot') {
      m.pi = packPilot(u.pilot); m.hp = Math.round(u.pilotHp); m.mhp = PILOT_HP;
      m.prt = r1(Math.max(0, u.pilotRespawnT));
      const af = u.pilot.ground ? this.terrain.airfieldAt(u.pilot.x, u.pilot.y) : null;
      m.af = af && (af.team === u.team || u.team < 0) ? 1 : 0;
    }
    return m;
  }
}

function botUpgrades(d) { const l = clamp(d | 0, 0, 2); return { engine: l, armor: l, damage: l, ammo: l, accuracy: l }; }

// Пересечение отрезка (x0,y0)+(dx,dy)*t с окружностью. Возвращает t∈[0,1] или -1.
export function segCircle(x0, y0, dx, dy, cx, cy, r) {
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  if (a === 0) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
