// Печатает таблицу лётных характеристик всех самолётов (в игровых и «реально-эквивалентных» единицах).
// Запуск: node tests/tools/flight-report.mjs [--json]
import { DATA, stats, MAXUP, maxLevelSpeed, bestClimb, verticalClimb, diveSpeed, bestLoop, accelTime, stallSpeed } from './flightlab.js';
import { SPEED_TO_KMH } from '../../shared/constants.js';
import * as C from '../../shared/constants.js';

// Масштаб мира: время в игре ускорено (TIME_SCALE), 1 игровая единица = UNIT_M метров.
const TIME_SCALE = C.TIME_SCALE || 5;
const UNIT_M = C.UNIT_M || 2.22;

const rows = [];
for (const d of DATA.planes) {
  const st = stats(d.id), stU = stats(d.id, MAXUP);
  const vmax = maxLevelSpeed(st), vmaxB = maxLevelSpeed(st, true), vmaxU = maxLevelSpeed(stU);
  const climb = bestClimb(st);
  const vert = verticalClimb(st), vertU = verticalClimb(stU), vertUB = verticalClimb(stU, 60, true);
  const dive = diveSpeed(st, 1);
  const loop = bestLoop(st);
  const acc = accelTime(st);
  const vs = stallSpeed(st);
  rows.push({
    id: d.id, name: d.name, cls: d.class,
    vmaxKmh: Math.round(vmax * SPEED_TO_KMH), vmaxBoostKmh: Math.round(vmaxB * SPEED_TO_KMH), vmaxUpKmh: Math.round(vmaxU * SPEED_TO_KMH),
    stallKmh: vs ? Math.round(vs * SPEED_TO_KMH) : null,
    climbMs: +(climb.vy * UNIT_M / TIME_SCALE).toFixed(1), climbGame: +climb.vy.toFixed(1),
    vertStallAt: vert.stallAt, vertUpStallAt: vertU.stallAt, vertUpFinalKmh: Math.round(vertU.finalV * SPEED_TO_KMH),
    vertUpBoostStallAt: vertUB.stallAt,
    diveKmh: Math.round(dive * SPEED_TO_KMH),
    loopS: +(loop.time).toFixed(2), loopRealS: +(loop.time * TIME_SCALE).toFixed(1), loopV: Math.round(loop.V * SPEED_TO_KMH),
    accel50to90S: +acc.toFixed(1),
  });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
else {
  console.log('| id | класс | Vmax км/ч | с форс. | макс. улучш. | срыв км/ч | V_y м/с (экв.) | верт. срыв, с | верт. срыв (улучш.), с | пикир. км/ч | петля, с (экв. реал.) | разгон 50→90%, с |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.id} | ${r.cls} | ${r.vmaxKmh} | ${r.vmaxBoostKmh} | ${r.vmaxUpKmh} | ${r.stallKmh} | ${r.climbMs} | ${r.vertStallAt ?? 'нет'} | ${r.vertUpStallAt ?? 'НЕТ (беск. подъём)'} | ${r.diveKmh} | ${r.loopS} (${r.loopRealS}) | ${r.accel50to90S} |`);
}
