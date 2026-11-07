// Игровая логика без сети: режимы, очки, возрождение, посадка, наземка, огонь по своим, античит.
import { describe, it, expect } from 'vitest';
import { DT, TICK_RATE } from '../../shared/constants.js';
import { makeGame, fakeClient, ticks, planeOf, placePlane, feed, DATA } from '../helpers.js';

const two = () => [fakeClient('a', { team: 0 }), fakeClient('b', { team: 1 })];
function spawnAll(g) { ticks(g, 40); for (const pl of g.planes.values()) pl.protect = 0; }   // все возрождаются; снимаем стартовую неуязвимость
// ждём, пока участник снова окажется в новом самолёте (сбитый самолёт ещё падает)
function waitRespawn(g, uid, maxSec = 60) {
  const old = g.users.get(uid).planeEid;
  for (let i = 0; i < maxSec * TICK_RATE; i++) {
    const u = g.users.get(uid);
    if (u.state === 'pilot') { const c = u.pilot; c.ground = true; u.pilotRespawnT = 0; g.killPilot(u, null, 'suicide'); }
    g.tick();
    if (u.state === 'plane' && u.planeEid !== old) { const pl = planeOf(g, uid); if (pl) pl.protect = 0; return; }
    if (g.ended) return;
  }
  throw new Error('не возродился');
}
function kill(g, victimId, killerId) {
  const pl = planeOf(g, victimId);
  pl.protect = 0;
  g.damagePlane(pl, 1e6, 'hull', g.users.get(killerId), 'mg', true);
}

describe('режимы и условия победы', () => {
  it('DM: матч заканчивается при достижении лимита побед, победитель верный', () => {
    const g = makeGame({ mode: 'dm', scoreLimit: 3 }, two());
    spawnAll(g);
    for (let i = 0; i < 3; i++) {
      kill(g, 'b', 'a');
      if (i < 2) waitRespawn(g, 'b'); else ticks(g, 2);
    }
    expect(g.ended).toBe(true);
    expect(g.result().winnerId).toBe('a');
    expect(g.result().results.find(r => r.id === 'a').kills).toBe(3);
  });

  it('TDM: сбитие самолёта даёт очко команде, убийство пилота — нет', () => {
    const g = makeGame({ mode: 'tdm', scoreLimit: 50 }, two());
    spawnAll(g);
    kill(g, 'b', 'a');
    expect(g.teamScore).toEqual([1, 0]);
    // пилот b катапультируется и погибает от a
    const ub = g.users.get('b');
    g.eject(ub, planeOf(g, 'b') || { p: { x: 0, y: 0, vx: 0, vy: 0, ground: false, dead: true }, pc: { hp: 0 } });
    if (ub.state === 'pilot') g.killPilot(ub, g.users.get('a'), 'pilot');
    expect(g.teamScore).toEqual([1, 0]);
    expect(g.users.get('a').stats.pilotKills).toBe(1);
  });

  it('TDM: конец по лимиту очков', () => {
    const g = makeGame({ mode: 'tdm', scoreLimit: 2 }, two());
    spawnAll(g);
    kill(g, 'b', 'a'); waitRespawn(g, 'b');
    kill(g, 'b', 'a'); ticks(g, 2);
    expect(g.ended).toBe(true);
    expect(g.result().winnerTeam).toBe(0);
  });

  it('Базы: уничтожение штаба — победа другой команды', () => {
    const g = makeGame({ mode: 'base', map: 'plains' }, two());
    spawnAll(g);
    const hq = g.ground.objs.find(o => o.type === 'hq' && o.team === 1);
    g.ground.damage(hq, 1e6, g.users.get('a'));
    ticks(g, 1);
    expect(g.ended).toBe(true);
    expect(g.result().winnerTeam).toBe(0);
  });

  it('Battle Royale: зона сужается, погибший выбывает, последний выживший побеждает', () => {
    const cl = [fakeClient('a', { team: 0 }), fakeClient('b', { team: 0 }), fakeClient('c', { team: 0 })];
    const g = makeGame({ mode: 'br', timeLimit: 2 }, cl);
    spawnAll(g);
    const z0 = g.rules.zone(g);
    ticks(g, 30 * 20);
    const z1 = g.rules.zone(g);
    expect(z1[1] - z1[0]).toBeLessThan(z0[1] - z0[0]);
    // b погибает без парашюта
    const ub = g.users.get('b');
    g.crashPlane(planeOf(g, 'b'), 'crash');
    expect(ub.out).toBe(true);
    ticks(g, 30 * 10);
    expect(ub.state).toBe('dead');
    g.crashPlane(planeOf(g, 'c'), 'crash');
    ticks(g, 2);
    expect(g.ended).toBe(true);
    expect(g.result().winnerId).toBe('a');
  });

  it('таймер: по истечении времени матч заканчивается', () => {
    const g = makeGame({ mode: 'tdm', timeLimit: 2 }, two());
    spawnAll(g);
    g.time = g.timeLimit - DT / 2;
    ticks(g, 2);
    expect(g.ended).toBe(true);
    expect(g.result().reason).toMatch(/Время/);
  });

  it('возрождение по таймеру через заданное время', () => {
    const g = makeGame({ mode: 'tdm', respawnTime: 4 }, two());
    spawnAll(g);
    g.crashPlane(planeOf(g, 'b'), 'crash');
    const ub = g.users.get('b');
    expect(ub.state).toBe('dead');
    ticks(g, 3.5 * TICK_RATE);
    expect(ub.state).toBe('dead');
    ticks(g, 1 * TICK_RATE);
    expect(ub.state).toBe('plane');
  });
});

describe('огонь по своим', () => {
  function shootTeammate(ff) {
    const cl = [fakeClient('a', { team: 0 }), fakeClient('b', { team: 0 })];
    const g = makeGame({ mode: 'tdm', friendlyFire: ff }, cl);
    spawnAll(g);
    placePlane(g, 'a', 3000, 1500, 0, 260);
    const tb = placePlane(g, 'b', 3200, 1500, 0, 260);
    const hp0 = tb.pc.hp;
    for (let i = 0; i < 45; i++) { feed(g, 'a', { f: 1, ta: 1 }); feed(g, 'b', { ta: 1 }); g.tick(); }
    return hp0 - tb.pc.hp;
  }
  it('по умолчанию (выключен) пули не ранят союзника', () => {
    expect(shootTeammate(false)).toBe(0);
  });
  it('включённый огонь по своим наносит урон союзнику', () => {
    expect(shootTeammate(true)).toBeGreaterThan(0);
  });
});

describe('посадка, ремонт, перезарядка', () => {
  function onRunway(speed) {
    const g = makeGame({ mode: 'tdm', map: 'plains' }, two());
    spawnAll(g);
    const af = g.map.airfields[0];
    const pl = planeOf(g, 'a');
    Object.assign(pl.p, { x: af.x0 + 300, y: af.h + 5, a: 0, vx: speed, vy: 0, ground: true, roll: 1, rollT: 1 });
    pl.pc.hp = 50; pl.pc.ammo = pl.pc.ammo.map(() => 0);
    for (let i = 0; i < 20; i++) { feed(g, 'a', { ta: speed > 60 ? 1 : 0 }); g.tick(); }
    return pl;
  }
  it('на малой скорости на своём аэродроме — ремонт и перезарядка', () => {
    const pl = onRunway(20);
    expect(pl.pc.hp).toBeGreaterThan(50);
    expect(pl.pc.ammo[0]).toBeGreaterThan(0);
  });
  it('касание полосы на скорости — без ремонта', () => {
    const pl = onRunway(200);
    expect(pl.pc.hp).toBeLessThanOrEqual(50);
    expect(pl.pc.ammo[0]).toBe(0);
  });
});

describe('наземные цели', () => {
  it('уничтожение вражеского объекта засчитывается ровно один раз', () => {
    const g = makeGame({ mode: 'tdm', map: 'plains' }, two());
    spawnAll(g);
    const aa = g.ground.objs.find(o => o.type === 'aa' && o.team === 1);
    const ua = g.users.get('a');
    for (let i = 0; i < 5; i++) g.ground.explosion(aa.x, aa.y + 5, 14, 500, ua);
    expect(ua.stats.ground).toBe(1);
  });

  it('нейтральные здания не дают наземных очков и опыта (защита от фарма)', () => {
    const g = makeGame({ mode: 'tdm', map: 'plains' }, two());
    spawnAll(g);
    const ua = g.users.get('a');
    for (const b of g.ground.objs.filter(o => o.type === 'building')) g.ground.damage(b, 1e6, ua);
    expect(ua.stats.ground).toBe(0);
    expect(ua.stats.score).toBe(0);
  });

  it('ПВО стреляет по вражеским самолётам рядом и не стреляет по своим', () => {
    const g = makeGame({ mode: 'tdm', map: 'plains' }, two());
    spawnAll(g);
    const aaRed = g.ground.objs.find(o => o.type === 'aa' && o.team === 1);
    const pa = placePlane(g, 'a', aaRed.x - 250, aaRed.y + 350, 0, 220);
    const pb = placePlane(g, 'b', aaRed.x + 250, aaRed.y + 350, Math.PI, 220);
    let flak = 0;
    for (let i = 0; i < 90; i++) {
      Object.assign(pa.p, { x: aaRed.x - 250, y: aaRed.y + 350, vx: 0.1, vy: 0 });
      Object.assign(pb.p, { x: aaRed.x + 250, y: aaRed.y + 350, vx: -0.1, vy: 0 });
      g.tick();
      flak += g.projs.filter(p => p.type === 'flak' && p.src === aaRed).length;
    }
    expect(flak).toBeGreaterThan(0);
    expect(pa.pc.hp).toBeLessThan(pa.st.maxHp);
    expect(pb.pc.hp).toBe(pb.st.maxHp);
  });

  it('новые танки (волны в режиме баз) видны клиенту: о каждом объекте в снапшоте есть статическая информация', () => {
    const cl = two();
    const g = makeGame({ mode: 'base', map: 'plains' }, cl);
    const known = new Set(g.ground.staticInfo().map(o => o.gid));
    ticks(g, 30 * 40, () => {});
    for (const m of cl[0].sent) if (m.t === 's') for (const e of m.E) if (e[0] === 'gadd') known.add(e[1].gid);
    const last = cl[0].sent.filter(m => m.t === 's').pop();
    const unknown = last.G.filter(o => !known.has(o[0]));
    expect(unknown.length).toBe(0);
  });
});

describe('честный подсчёт фрагов', () => {
  it('катапультирование после попаданий врага засчитывает фраг атакующему и смерть жертве', () => {
    const g = makeGame({ mode: 'tdm' }, two());
    spawnAll(g);
    const pb = planeOf(g, 'b');
    g.damagePlane(pb, pb.pc.hp * 0.4, 'hull', g.users.get('a'), 'mg', true);
    expect(pb.p.dead).toBe(false);
    g.eject(g.users.get('b'), pb);
    for (let i = 0; i < 400 && g.planes.has(pb.eid); i++) g.tick();
    expect(g.users.get('a').stats.kills).toBe(1);
    expect(g.users.get('b').stats.deaths).toBe(1);
  });

  it('столкновение с врагом наносит урон обоим, свои проходят насквозь', () => {
    const g = makeGame({ mode: 'tdm' }, [fakeClient('a', { team: 0 }), fakeClient('b', { team: 1 }), fakeClient('c', { team: 0 })]);
    spawnAll(g);
    const pa = placePlane(g, 'a', 5000, 1500, 0, 250), pb = placePlane(g, 'b', 5010, 1500, Math.PI, 250);
    g.collidePlanes();
    expect(pa.pc.hp).toBeLessThan(pa.st.maxHp);
    expect(pb.pc.hp).toBeLessThan(pb.st.maxHp);
    const pc = placePlane(g, 'c', 7000, 1500, 0, 250);
    const pa2 = placePlane(g, 'a', 7005, 1500, Math.PI, 250);
    const hpc = pc.pc.hp, hpa = pa2.pc.hp;
    g.time += 2; g.collidePlanes();
    expect(pc.pc.hp).toBe(hpc); expect(pa2.pc.hp).toBe(hpa);
  });

  it('за границей карты через 3 с начинается урон', () => {
    const g = makeGame({ mode: 'tdm' }, two());
    spawnAll(g);
    const pa = placePlane(g, 'a', -200, 1500, Math.PI, 200);
    const hp0 = pa.pc.hp;
    for (let i = 0; i < 2.5 * TICK_RATE; i++) { pa.p.x = -200; feed(g, 'a', { ta: 1 }); g.tick(); }
    expect(pa.pc.hp).toBe(hp0);
    for (let i = 0; i < 1.5 * TICK_RATE; i++) { pa.p.x = -200; feed(g, 'a', { ta: 1 }); g.tick(); }
    expect(pa.pc.hp).toBeLessThan(hp0);
  });

  it('вода: медленное приводнение — пилот плывёт, удар на скорости — гибель', () => {
    const g = makeGame({ mode: 'tdm', map: 'islands' }, two());
    spawnAll(g);
    const ua = g.users.get('a'), ub = g.users.get('b');
    const pa = placePlane(g, 'a', 3000, 2, 0, ua.st.vstall * 1.1); pa.p.vy = -5;
    const pb = placePlane(g, 'b', 3500, 3, -0.6, 380);
    g.tick();
    expect(ua.state).toBe('pilot');
    expect(ua.pilot.swim).toBe(true);
    expect(ub.state).toBe('dead');
  });

  it('самолёт в облаке не обстреливается ПВО', () => {
    const g = makeGame({ mode: 'tdm', map: 'plains' }, two());
    spawnAll(g);
    const aaRed = g.ground.objs.find(o => o.type === 'aa' && o.team === 1);
    const cloud = g.terrain.clouds[0];
    // ставим ПВО прямо под облаком, а самолёт — в облако
    aaRed.x = cloud.x; aaRed.y = g.terrain.ground(cloud.x);
    const pa = placePlane(g, 'a', cloud.x, cloud.y, 0, 200);
    let flak = 0;
    for (let i = 0; i < 60; i++) { Object.assign(pa.p, { x: cloud.x, y: cloud.y, vx: 0.1, vy: 0 }); g.tick(); flak += g.projs.filter(p => p.type === 'flak' && p.src === aaRed).length; }
    expect(pa.p.inCloud).toBe(true);
    expect(flak).toBe(0);
  });
});

describe('античит на уровне симуляции', () => {
  it('поток ввода чаще тиков не ускоряет самолёт', () => {
    const run = (perTick) => {
      const g = makeGame({ mode: 'tdm' }, two());
      spawnAll(g);
      const pa = placePlane(g, 'a', 3000, 1500, 0, 250);
      for (let i = 0; i < 90; i++) { for (let k = 0; k < perTick; k++) feed(g, 'a', { ta: 1 }); g.tick(); }
      return pa.p.x;
    };
    expect(Math.abs(run(10) - run(1))).toBeLessThan(1);
  });

  it('скорострельность ограничена сервером', () => {
    const g = makeGame({ mode: 'tdm' }, two());
    spawnAll(g);
    placePlane(g, 'a', 3000, 1500, 0, 250);
    const ua = g.users.get('a');
    const before = g.bullets.length;
    let shots = 0;
    for (let i = 0; i < 60; i++) { for (let k = 0; k < 5; k++) feed(g, 'a', { f: 1, ta: 1 }); g.tick(); shots += g.events.filter(e => e[0] === 'shot').length; g.events = []; }
    const rof = ua.st.guns.reduce((s, gn) => s + gn.wd.rof, 0);
    expect(shots).toBeLessThanOrEqual(Math.ceil(rof * 2) + 2);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('гость без профиля не может летать на закрытых самолётах', () => {
    const guest = fakeClient('g', { team: 0, planeId: 'us_b3', profile: null });
    const g = makeGame({ mode: 'tdm' }, [guest, fakeClient('b', { team: 1 })]);
    const def = DATA.planes.find(p => p.id === g.users.get('g').planeId);
    expect(def.cost).toBe(0);
  });
});
