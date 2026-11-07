// Правила игровых режимов.
import { DT, clamp } from '../shared/constants.js';

const base = {
  setup(g) {},
  onKill(g, killer, victim, pilot) {
    if (g.teams && killer.team >= 0 && killer.team !== victim.team) g.teamScore[killer.team] += pilot ? 0 : 1;
  },
  canRespawn(g, u, fromAirfield) { return true; },
  timeUp(g) { return g.time >= g.timeLimit; },
  checkEnd(g) { return null; },
};

const dm = {
  ...base,
  checkEnd(g) {
    const us = [...g.users.values()];
    const top = us.reduce((a, b) => (!a || b.stats.kills > a.stats.kills ? b : a), null);
    if (top && top.stats.kills >= g.settings.scoreLimit) return { winnerId: top.id, reason: `${top.name} набрал ${top.stats.kills} побед` };
    if (base.timeUp(g)) return { winnerId: top ? top.id : null, reason: 'Время вышло' };
    if (!us.some(u => !u.isBot)) return { winnerId: null, reason: 'Все игроки вышли' };
    return null;
  },
};

const tdm = {
  ...base,
  checkEnd(g) {
    const [a, b] = g.teamScore, L = g.settings.scoreLimit;
    if (a >= L || b >= L) return { winnerTeam: a > b ? 0 : 1, reason: 'Достигнут лимит очков' };
    if (base.timeUp(g)) return { winnerTeam: a === b ? null : a > b ? 0 : 1, reason: 'Время вышло' };
    if (![...g.users.values()].some(u => !u.isBot)) return { winnerTeam: null, reason: 'Все игроки вышли' };
    return null;
  },
};

const baseMode = {
  ...base,
  setup(g) { g.hqDestroyed = null; },
  onKill() {},
  onGroundKill(g, attacker, o) {
    if (o.team === 0 || o.team === 1) g.teamScore[1 - o.team] += o.type === 'hq' ? 0 : 1;
    if (o.type === 'hq') g.hqDestroyed = o.team;
  },
  hqHp(g) {
    return [0, 1].map(t => { const h = g.ground.objs.find(o => o.type === 'hq' && o.team === t); return h ? h.hp / h.maxHp : 0; });
  },
  extra(g) { return { hq: baseMode.hqHp(g).map(v => Math.round(v * 100)) }; },
  checkEnd(g) {
    if (g.hqDestroyed !== null) return { winnerTeam: 1 - g.hqDestroyed, reason: `Штаб команды ${g.hqDestroyed === 0 ? 'синих' : 'красных'} уничтожен` };
    if (base.timeUp(g)) {
      const [a, b] = baseMode.hqHp(g);
      if (Math.abs(a - b) > 0.001) return { winnerTeam: a > b ? 0 : 1, reason: 'Время вышло: у победителя штаб целее' };
      const [sa, sb] = g.teamScore;
      return { winnerTeam: sa === sb ? null : sa > sb ? 0 : 1, reason: 'Время вышло' };
    }
    if (![...g.users.values()].some(u => !u.isBot)) return { winnerTeam: null, reason: 'Все игроки вышли' };
    return null;
  },
};

const br = {
  ...base,
  setup(g) {
    g.zoneStart = [0, g.terrain.width];
    const c = g.terrain.width * (0.3 + Math.random() * 0.4);
    g.zoneEnd = [c - 450, c + 450];
    g.zoneNow = [...g.zoneStart];
    g.brStarted = false;
  },
  afterSpawn(g) { for (const u of g.users.values()) u.lives = 1; },
  lateJoin(g, u) { u.out = true; u.lives = 0; u.state = 'dead'; },
  spawnPoint(g, u) {
    const W = g.terrain.width;
    const x = 600 + Math.random() * (W - 1200);
    const y = Math.max(g.terrain.ground(x) + 450, 900 + Math.random() * 500);
    const a = x < W / 2 ? 0.05 : Math.PI - 0.05;
    return { x, y, a };
  },
  canRespawn(g, u, fromAirfield) {
    if (u.out) return false;
    if (fromAirfield) return true;          // одна жизнь, но пеший пилот может взлететь с аэродрома
    return !u.spawnedOnce;
  },
  onDeath(g, u) { u.lives = 0; u.out = true; g.events.push(['msg', `${u.name} выбывает`]); },
  tick(g) {
    const t = clamp(g.time / (g.timeLimit * 0.8), 0, 1);
    const s = t * t * (3 - 2 * t);
    g.zoneNow = [g.zoneStart[0] + (g.zoneEnd[0] - g.zoneStart[0]) * s, g.zoneStart[1] + (g.zoneEnd[1] - g.zoneStart[1]) * s];
  },
  zone(g) { return [Math.round(g.zoneNow[0]), Math.round(g.zoneNow[1])]; },
  zoneDamage(g, x) { return (x < g.zoneNow[0] || x > g.zoneNow[1]) ? 14 : 0; },
  checkEnd(g) {
    if (g.time < 3) return null;
    const alive = [...g.users.values()].filter(u => !u.out);
    if (alive.length <= 1) return { winnerId: alive[0] ? alive[0].id : null, reason: alive[0] ? `${alive[0].name} — последний выживший` : 'Никто не выжил' };
    if (base.timeUp(g)) {
      const best = alive.sort((a, b) => b.stats.kills - a.stats.kills)[0];
      return { winnerId: best ? best.id : null, reason: 'Время вышло' };
    }
    if (![...g.users.values()].some(u => !u.isBot && !u.out) && [...g.users.values()].some(u => !u.isBot)) {
      // все люди выбыли — доигрывать за ботов незачем
      const best = alive.sort((a, b) => b.stats.kills - a.stats.kills)[0];
      return { winnerId: best ? best.id : null, reason: 'Все игроки выбыли' };
    }
    if (![...g.users.values()].some(u => !u.isBot)) return { winnerId: null, reason: 'Все игроки вышли' };
    return null;
  },
};

export const MODE_RULES = { dm, tdm, base: baseMode, br };
