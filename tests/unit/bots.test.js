// ИИ: не врезается в землю постоянно, уровни сложности различаются, пеший бот не застревает.
import { describe, it, expect } from 'vitest';
import { TICK_RATE } from '../../shared/constants.js';
import { makeGame, fakeClient } from '../helpers.js';

function countKills(g, minutes, each) {
  const kills = [];
  for (let i = 0; i < minutes * 60 * TICK_RATE && !g.ended; i++) {
    g.tick();
    for (const e of g.events) if (e[0] === 'kill') kills.push(e);
    g.events = [];
    if (each) each(i);
  }
  return kills;
}

describe('боты', () => {
  it('редко разбиваются сами (меньше 0,3 раза на бота в минуту)', () => {
    const g = makeGame({ mode: 'tdm', map: 'plains', bots: true, botCount: 10, botDifficulty: 1, maxPlayers: 12, timeLimit: 30, scoreLimit: 999 },
      [fakeClient('h', { team: 0 })]);
    const kills = countKills(g, 3);
    const selfCrash = kills.filter(e => !e[1] && e[3] === 'crash' && g.users.get(e[2])?.isBot).length;
    expect(selfCrash / (10 * 3)).toBeLessThan(0.3);
    expect(kills.filter(e => e[1]).length).toBeGreaterThan(3);   // и при этом воюют
  });

  it('асы заметно сильнее новичков', () => {
    let ace = 0, novice = 0;
    for (const seed of [1, 2]) {
      const g = makeGame({ mode: 'tdm', map: 'plains', bots: true, botCount: 8, maxPlayers: 9, classes: ['fighter'], timeLimit: 30, scoreLimit: 999 },
        [fakeClient('h', { team: 0 })]);
      // убираем человека; матч не должен закончиться — подменяем проверку конца
      g.rules = { ...g.rules, checkEnd: () => null };
      g.removeHuman('h'); void seed;
      for (const u of g.users.values()) if (u.bot) u.bot.diff = u.team === 0 ? 2 : 0;
      const kills = countKills(g, 4);
      for (const e of kills) { const k = g.users.get(e[1]); if (!k) continue; if (k.bot.diff === 2) ace++; else novice++; }
    }
    expect(ace, `асы ${ace} : новички ${novice}`).toBeGreaterThan(novice * 1.5);
  });

  it('пеший бот не застревает (режим возрождения «через аэродром», горы)', () => {
    const g = makeGame({ mode: 'tdm', map: 'mountains', bots: true, botCount: 8, maxPlayers: 9, respawnMode: 'airfield', timeLimit: 30, scoreLimit: 999 },
      [fakeClient('h', { team: 0 })]);
    const track = new Map();
    let stuck = 0;
    countKills(g, 4, i => {
      if (i % (5 * TICK_RATE)) return;
      for (const u of g.users.values()) {
        if (!u.isBot) continue;
        if (u.state !== 'pilot' || !(u.pilot.ground || u.pilot.swim)) { track.delete(u.id); continue; }
        const t = track.get(u.id) || { x: u.pilot.x, since: i };
        if (Math.abs(u.pilot.x - t.x) > 60) { t.x = u.pilot.x; t.since = i; }
        if (i - t.since > 25 * TICK_RATE) { stuck++; t.since = i; }
        track.set(u.id, t);
      }
    });
    expect(stuck).toBe(0);
  });
});
