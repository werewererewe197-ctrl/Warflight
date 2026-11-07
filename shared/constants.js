// Общие константы клиента и сервера.
export const TICK_RATE = 30;              // тиков симуляции в секунду
export const DT = 1 / TICK_RATE;
export const PHYS_SUBSTEPS = 2;           // физика: 60 Гц внутри тика
export const SNAPSHOT_EVERY = 2;          // снапшот каждые 2 тика (15 Гц)
export const INTERP_DELAY_TICKS = 4;      // задержка интерполяции чужих объектов

export const GRAVITY = 110;               // ед/с²
export const CEILING = 2600;              // практический потолок
export const SPEED_TO_KMH = 1.6;          // перевод ед/с -> км/ч для HUD
export const PLANE_RADIUS = 15;           // радиус хитбокса истребителя (масштабируется size)
export const PILOT_RADIUS = 7;
export const OUT_OF_BOUNDS_MARGIN = 150;

export const TEAM_COLORS = ['#4b8fe8', '#e5533f'];
export const TEAM_NAMES = ['Синие', 'Красные'];
export const FFA_COLORS = ['#4b8fe8', '#e5533f', '#53c26b', '#e8c24b', '#b25be0', '#4bd6d6', '#e8884b', '#e05bb0',
  '#9fd65b', '#5b6be0', '#d6d6d6', '#8b5b3a', '#3ab08b', '#e0a0a0', '#a0a0e0', '#f0f070'];

export const MODES = {
  dm:   { name: 'Deathmatch',        short: 'DM',  teams: false, desc: 'Каждый сам за себя. Побеждает лучший по убийствам.' },
  tdm:  { name: 'Team Deathmatch',   short: 'TDM', teams: true,  desc: 'Две команды. Очки за сбитых врагов.' },
  base: { name: 'Уничтожение баз',   short: 'BASE',teams: true,  desc: 'Уничтожьте штаб противника. Защищайте свой.' },
  br:   { name: 'Battle Royale',     short: 'BR',  teams: false, desc: 'Одна жизнь, зона сужается. Выживает последний.' },
};

export const NATIONS = {
  us: { name: 'США',            color: '#5e6e48', accent: '#d8d0b0', insignia: 'us' },
  su: { name: 'СССР',           color: '#4f6b3a', accent: '#c94030', insignia: 'su' },
  uk: { name: 'Великобритания', color: '#6b6a45', accent: '#3f5a8a', insignia: 'uk' },
  de: { name: 'Германия',       color: '#6f7a80', accent: '#e8d040', insignia: 'de' },
  jp: { name: 'Япония',         color: '#a9ab9a', accent: '#c0302a', insignia: 'jp' },
};

export const CLASSES = {
  fighter:  { name: 'Истребитель' },
  attacker: { name: 'Штурмовик' },
  bomber:   { name: 'Бомбардировщик' },
};

export const PARTS = ['engine', 'wing', 'tail', 'fuel'];
export const PART_NAMES = { engine: 'Двигатель', wing: 'Крылья', tail: 'Хвост', fuel: 'Бак', hull: 'Корпус' };

export const UPGRADE_TRACKS = ['engine', 'armor', 'damage', 'ammo', 'accuracy'];
export const UPGRADE_NAMES = {
  engine: 'Двигатель', armor: 'Броня', damage: 'Урон оружия', ammo: 'Боезапас', accuracy: 'Точность/отдача',
};
export const UPGRADE_MAX = 3;
// Заявленные эффекты одного уровня улучшения (показываются в ангаре, проверяются тестами).
export const UPGRADE_EFFECTS = {
  engine:   { thrust: 0.05 },                  // +5% тяги (≈ +2,5% максимальной скорости)
  armor:    { hp: 0.08, armor: 0.03 },         // +8% прочности, +3 п.п. брони
  damage:   { dmg: 0.06 },                     // +6% урона оружия
  ammo:     { ammo: 0.2 },                     // +20% патронов, +10% ракет
  accuracy: { spread: 0.15, recoil: 0.15 },    // −15% разброса и «отдачи»
};
export function upgradeCost(planeTier, level) { return Math.round((150 + planeTier * 100) * (level + 1)); }

// Масштаб мира (для приборов и сравнения с реальностью): 1 игровая единица ≈ 2,22 м, время в игре
// идёт примерно в 5 раз быстрее (поэтому скорость в км/ч = ед/с × 1,6, а высота в м = ед × 2,22).
export const UNIT_M = 2.22;
export const TIME_SCALE = 5;
export const ALT_TO_M = UNIT_M;

// Уровень игрока по опыту: уровень n требует 200*n*(n-1) опыта.
export function levelFromXp(xp) {
  let n = 1;
  while (200 * (n + 1) * n <= xp) n++;
  return n;
}
export function xpForLevel(n) { return 200 * n * (n - 1); }

export const DEFAULT_SETTINGS = {
  name: 'Новое лобби',
  password: '',
  map: 'islands',
  mode: 'tdm',
  maxPlayers: 8,
  timeLimit: 8,          // минуты
  scoreLimit: 20,
  nations: ['us', 'su', 'uk', 'de', 'jp'],
  classes: ['fighter', 'attacker', 'bomber'],
  bots: true,
  botCount: 4,
  botDifficulty: 1,      // 0 лёгкие, 1 средние, 2 асы
  respawnMode: 'timer',  // 'timer' — возрождение по таймеру, 'airfield' — только пешком через аэродром
  respawnTime: 5,
  friendlyFire: false,   // огонь по своим (в командных режимах)
};

export const BOT_DIFFICULTY = ['Новички', 'Ветераны', 'Асы'];

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
export function lerp(a, b, t) { return a + (b - a) * t; }
export function lerpAngle(a, b, t) { return a + wrapAngle(b - a) * t; }
