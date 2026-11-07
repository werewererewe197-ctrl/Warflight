// Протокол сообщений клиент <-> сервер (JSON поверх WebSocket).
// Каждое сообщение: { t: <тип>, ...поля }.
export const C2S = {
  HELLO: 'hello',         // { name, token }
  RENAME: 'rename',       // { name }
  LIST: 'list',           // {}
  CREATE: 'create',       // { settings }
  JOIN: 'join',           // { code, password }
  QUICK: 'quick',         // {}
  LEAVE: 'leave',         // {}
  TEAM: 'team',           // { team }
  PLANE: 'plane',         // { planeId }
  READY: 'ready',         // { ready }
  CHAT: 'chat',           // { text, team? }
  KICK: 'kick',           // { id }
  SETTINGS: 'settings',   // { settings }
  START: 'start',         // {}
  INPUT: 'in',            // { s: seq, p, t, ta, f, b, r, fl, e, bo, mx, j, aim, k }
  UNLOCK: 'unlock',       // { planeId }
  UPGRADE: 'upgrade',     // { planeId, track }
  PING: 'ping',           // { c: clientTime }
};

export const S2C = {
  WELCOME: 'welcome',     // { id, profile }
  PROFILE: 'profile',     // { profile }
  ROOMS: 'rooms',         // { list: [...] }
  ROOM: 'room',           // { room }
  LEFT: 'left',           // { reason }
  CHAT: 'chat',           // { from, name, text, sys, team }
  ERROR: 'err',           // { msg }
  MATCH: 'match',         // { map, mode, settings, roster, ground, you }
  ROSTER: 'roster',       // { roster }
  SNAP: 's',              // снапшот мира
  END: 'end',             // { results, winner, reason }
  PONG: 'pong',           // { c, s }
};

// Флаги самолёта в снапшоте
export const PF = { BOOST: 1, FIRE: 2, DEAD: 4, STALL: 8, CLOUD: 16, GROUND: 32, SMOKE: 64 };
// Флаги пилота
export const CF = { CHUTE: 1, GROUND: 2, SWIM: 4, CLOUD: 8 };
// Типы снарядов
export const PROJ = { bomb: 1, rocket: 2, shell: 3 };
export const PROJ_NAMES = { 1: 'bomb', 2: 'rocket', 3: 'shell' };

// Ограничения для защиты от флуда/читов
export const LIMITS = {
  MSG_PER_SEC: 120,
  CHAT_PER_10S: 6,
  INPUT_QUEUE: 6,
  NAME_LEN: 16,
  CHAT_LEN: 140,
};

export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
