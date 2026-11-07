// Реалистичность: сравнение лётных характеристик в игре с прототипами (приблизительные исторические данные).
// Игровые значения приводятся к реальным единицам по масштабу мира (UNIT_M, TIME_SCALE в shared/constants.js).
// Запуск: node tests/tools/realism-report.mjs
import { DATA, stats, maxLevelSpeed, bestClimb, diveSpeed, bestLoop } from './flightlab.js';
import { SPEED_TO_KMH, UNIT_M, TIME_SCALE } from '../../shared/constants.js';

// Прототипы и справочные значения (≈, по общеизвестным данным испытаний; у разных модификаций отличаются).
// vmax — км/ч на расчётной высоте; climb — м/с у земли; turn — время установившегося виража 360°, с;
// vne — предельная скорость пикирования, км/ч.
export const REF = {
  us_f1: { proto: 'P-51B Mustang', vmax: 703, climb: 17.5, turn: 23, vne: 805 },
  us_a2: { proto: 'P-47D Thunderbolt', vmax: 690, climb: 14, turn: 26, vne: 885 },
  us_b3: { proto: 'B-17G Flying Fortress', vmax: 462, climb: 4.6, turn: null, vne: 490 },
  su_f1: { proto: 'Як-3', vmax: 646, climb: 20.5, turn: 18.5, vne: 700 },
  su_a2: { proto: 'Ил-2М3', vmax: 414, climb: 10, turn: 24, vne: 600 },
  su_b3: { proto: 'Пе-2', vmax: 540, climb: 9, turn: null, vne: 720 },
  uk_f1: { proto: 'Spitfire Mk I', vmax: 582, climb: 12.7, turn: 18.5, vne: 724 },
  uk_a2: { proto: 'Typhoon Ib', vmax: 663, climb: 13.7, turn: 25, vne: 800 },
  uk_b3: { proto: 'Lancaster B.I', vmax: 454, climb: 3.7, turn: null, vne: 580 },
  de_f1: { proto: 'Fw 190A-8', vmax: 656, climb: 15, turn: 23, vne: 850 },
  de_a2: { proto: 'Ju 87G-2', vmax: 344, climb: 5, turn: 24, vne: 600 },
  de_b3: { proto: 'He 111H-16', vmax: 435, climb: 4, turn: null, vne: 600 },
  jp_f1: { proto: 'A6M2 Zero', vmax: 533, climb: 15.5, turn: 16, vne: 660 },
  jp_a2: { proto: 'J2M3 Raiden', vmax: 596, climb: 19, turn: 22, vne: 795 },
  jp_b3: { proto: 'G4M2', vmax: 437, climb: 6, turn: null, vne: 550 },
};

export function measure(id) {
  const st = stats(id);
  return {
    vmax: Math.round(maxLevelSpeed(st) * SPEED_TO_KMH),
    climb: +(bestClimb(st).vy * UNIT_M / TIME_SCALE).toFixed(1),
    turn: +(bestLoop(st).time * TIME_SCALE).toFixed(1),
    dive: Math.round(diveSpeed(st, 1) * SPEED_TO_KMH),
  };
}

function verdictSpeed(g, r) { const d = g / r - 1; return Math.abs(d) <= 0.07 ? `верно (${pct(d)})` : Math.abs(d) <= 0.12 ? `близко (${pct(d)})` : `НЕВЕРНО (${pct(d)})`; }
function pct(d) { return (d >= 0 ? '+' : '') + Math.round(d * 100) + '%'; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  for (const d of DATA.planes) rows.push({ d, r: REF[d.id], m: measure(d.id) });
  console.log('| Самолёт (прототип) | Характеристика | В игре | Реальная | Вердикт |');
  console.log('|---|---|---|---|---|');
  for (const { d, r, m } of rows) {
    const name = `${d.name} (${r.proto})`;
    console.log(`| ${name} | Макс. скорость, км/ч | ${m.vmax} | ≈${r.vmax} | ${verdictSpeed(m.vmax, r.vmax)} |`);
    const k = m.climb / r.climb;
    console.log(`| ${name} | Скороподъёмность, м/с | ${m.climb} | ≈${r.climb} | ${k < 0.8 ? 'занижена' : k <= 1.3 ? 'верно' : k <= 2.6 ? `завышена ×${k.toFixed(1)} (аркада)` : `НЕВЕРНО ×${k.toFixed(1)}`} |`);
    if (r.turn) console.log(`| ${name} | Разворот 360°, с (приведено) | ${m.turn} | ≈${r.turn} | ${Math.abs(m.turn / r.turn - 1) <= 0.15 ? 'верно' : Math.abs(m.turn / r.turn - 1) <= 0.3 ? 'близко' : 'отличается'} |`);
    else console.log(`| ${name} | Разворот 360°, с (приведено) | ${m.turn} | — | бомбардировщик: только сравнение с истребителями |`);
    console.log(`| ${name} | Пикирование (терминальная), км/ч | ${m.dive} | Vne ≈${r.vne} | ${m.dive <= r.vne * 1.15 && m.dive >= r.vne * 0.85 ? 'верно (упирается в Vne)' : m.dive > r.vne * 1.15 ? 'завышено' : 'занижено'} |`);
  }
  // соотношения внутри класса истребителей
  const F = rows.filter(x => x.d.class === 'fighter');
  const rank = (arr, key, asc) => [...arr].sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).map(x => x.id).join(' > ');
  const game = F.map(x => ({ id: x.r.proto, ...x.m })), real = F.map(x => ({ id: x.r.proto, ...x.r, dive: x.r.vne }));
  console.log('\nПорядок истребителей (лучший → худший):');
  for (const [k, asc, label] of [['vmax', false, 'скорость'], ['climb', false, 'скороподъёмность'], ['turn', true, 'вираж'], ['dive', false, 'пикирование']]) {
    console.log(`- ${label}: игра ${rank(game, k, asc)}; реальность ${rank(real, k, asc)}`);
  }
}
