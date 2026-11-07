// Баланс: DPS, эффективная прочность (с бронёй), время уничтожения (TTK), стоимость полной прокачки.
// Запуск: node tests/tools/balance-report.mjs
import { DATA, stats } from './flightlab.js';
import { upgradeCost, UPGRADE_TRACKS, UPGRADE_MAX, xpForLevel } from '../../shared/constants.js';

const heavy = w => ['cannon', 'hcannon'].includes(w);
function dpsVs(att, def) {
  let dps = 0;
  for (const g of att.guns) {
    const w = DATA.weapons[g.w];
    const k = 1 - def.armor * (heavy(g.w) ? 0.5 : 1.2);
    dps += w.dmg * g.count * w.rof * Math.max(k, 0.05);
  }
  return dps;
}
const P = DATA.planes;
console.log('| самолёт | класс | DPS (без брони) | прочность | броня | Vmax | «сила» = DPS·HP |');
console.log('|---|---|---|---|---|---|---|');
for (const d of P) {
  const st = stats(d.id);
  const dps = st.guns.reduce((s, g) => s + DATA.weapons[g.w].dmg * g.count * DATA.weapons[g.w].rof, 0);
  console.log(`| ${d.name} (${d.id}) | ${d.class} | ${dps.toFixed(0)} | ${d.hp} | ${d.armor} | ${d.vmax} | ${(dps * d.hp / 1000).toFixed(0)} |`);
}
const F = P.filter(p => p.class === 'fighter');
console.log('\nTTK, с (строка атакует столбец), истребители ранга 1:');
console.log('| | ' + F.map(f => f.id).join(' | ') + ' |'); console.log('|' + '---|'.repeat(F.length + 1));
for (const a of F) console.log(`| ${a.id} | ` + F.map(t => (t.hp / dpsVs(stats(a.id), stats(t.id))).toFixed(2)).join(' | ') + ' |');
// экономика
let perNation = {};
for (const d of P) {
  const up = UPGRADE_TRACKS.length * Array.from({ length: UPGRADE_MAX }, (_, l) => upgradeCost(d.tier, l)).reduce((a, b) => a + b, 0);
  perNation[d.nation] = (perNation[d.nation] || 0) + d.cost + up;
}
const total = Object.values(perNation).reduce((a, b) => a + b, 0);
const unlockOnly = P.reduce((s, d) => s + d.cost, 0);
console.log('\nСтоимость: открыть все самолёты =', unlockOnly, '; всё с улучшениями =', total, '; по нациям', perNation, '; уровень для 3-го ранга: опыт', xpForLevel(4));
