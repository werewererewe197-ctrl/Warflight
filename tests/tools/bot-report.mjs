// Отчёт по ботам: асы против новичков, крушения по уровням, длительность режима «Базы».
import { makeGame, fakeClient } from '../helpers.js';
import { TICK_RATE } from '../../shared/constants.js';
function run(g, minutes, onEv) {
  for (let i = 0; i < minutes * 60 * TICK_RATE && !g.ended; i++) { g.tick(); for (const e of g.events) onEv && onEv(e); g.events = []; }
}
// 1) асы (команда 0) против новичков (команда 1) на одинаковых истребителях
let ace = 0, nov = 0;
for (let s = 0; s < 3; s++) {
  const g = makeGame({ mode: 'tdm', map: 'plains', bots: true, botCount: 8, maxPlayers: 9, classes: ['fighter'], timeLimit: 30, scoreLimit: 999 }, [fakeClient('h', { team: 0 })]);
  g.rules = { ...g.rules, checkEnd: () => null }; g.removeHuman('h');
  for (const u of g.users.values()) if (u.bot) u.bot.diff = u.team === 0 ? 2 : 0;
  run(g, 4, e => { if (e[0] === 'kill' && e[1]) { const k = g.users.get(e[1]); if (k) (k.bot.diff === 2 ? ace++ : nov++); } });
}
console.log('асы : новички =', ace, ':', nov);
// 2) крушения без участия врага на бота в минуту
for (const d of [0, 1, 2]) {
  const g = makeGame({ mode: 'tdm', map: 'mountains', bots: true, botCount: 10, botDifficulty: d, maxPlayers: 11, timeLimit: 30, scoreLimit: 999 }, [fakeClient('h', { team: 0 })]);
  g.rules = { ...g.rules, checkEnd: () => null }; g.removeHuman('h');
  let crash = 0, kills = 0;
  run(g, 4, e => { if (e[0] === 'kill') { if (!e[1] && e[3] === 'crash') crash++; else if (e[1]) kills++; } });
  console.log(`сложность ${d}: самостоятельных крушений ${(crash / 40).toFixed(2)} на бота/мин, сбитий ${kills}`);
}
// 3) режим «Базы»: когда падает штаб (14 ботов-асов)
for (const map of ['plains', 'mountains', 'islands']) {
  const g = makeGame({ mode: 'base', map, bots: true, botCount: 14, botDifficulty: 2, maxPlayers: 16, timeLimit: 30 }, [fakeClient('h', { team: 0 })]);
  g.rules = { ...g.rules, checkEnd: g.rules.checkEnd };
  const hq = () => g.ground.objs.filter(o => o.type === 'hq').map(o => Math.round(100 * o.hp / o.maxHp));
  run(g, 15);
  console.log(`«Базы», ${map}: ${g.ended ? 'конец на ' + (g.time / 60).toFixed(1) + ' мин' : 'за 15 мин штабы целы на ' + hq().join('/') + '%'}${g.result() ? ' — ' + g.result().reason : ''}`);
}
