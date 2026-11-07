// Защита от читов и флуда. Сервер авторитарен: клиент присылает только ввод,
// позиция/скорость/попадания считаются здесь. Модуль проверяет поток сообщений и
// санирует ввод; скорострельность ограничивается в game.js таймерами оружия.
import { LIMITS } from '../shared/protocol.js';
import { clamp } from '../shared/constants.js';

export class RateLimiter {
  constructor() { this.win = 0; this.count = 0; this.chat = []; this.strikes = 0; this.inputs = 0; this.inputWin = 0; }
  // false — сообщение отброшено
  allow(now) {
    if (now - this.win > 1000) { this.win = now; this.count = 0; }
    this.count++;
    if (this.count > LIMITS.MSG_PER_SEC) { this.strikes++; return false; }
    return true;
  }
  allowChat(now) {
    this.chat = this.chat.filter(t => now - t < 10000);
    if (this.chat.length >= LIMITS.CHAT_PER_10S) return false;
    this.chat.push(now); return true;
  }
  // Учёт частоты пакетов ввода: клиент не может прислать заметно больше, чем тиков в секунду.
  countInput(now, tickRate) {
    if (now - this.inputWin > 2000) {
      if (this.inputs > tickRate * 2 * 1.6) this.strikes++;
      this.inputWin = now; this.inputs = 0;
    }
    this.inputs++;
  }
  get abusive() { return this.strikes > 40; }
}

const num = (v, a, b, d = 0) => (typeof v === 'number' && isFinite(v)) ? clamp(v, a, b) : d;
const bit = v => (v ? 1 : 0);

// Санирует сырой ввод клиента.
export function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = Math.floor(num(raw.s, 0, 1e9, -1));
  if (s < 0) return null;
  const inp = {
    s,
    p: num(raw.p, -1, 1), t: Math.round(num(raw.th, -1, 1)),
    f: bit(raw.f), b: bit(raw.b), r: bit(raw.r), fl: bit(raw.fl), e: bit(raw.e), bo: bit(raw.bo),
    mx: Math.round(num(raw.mx, -1, 1)), j: bit(raw.j), k: bit(raw.k),
    aim: num(raw.aim, -4, 4),
  };
  if (typeof raw.ta === 'number') inp.ta = num(raw.ta, 0, 1);
  return inp;
}

export function sanitizeName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, LIMITS.NAME_LEN);
  return n || 'Пилот' + Math.floor(Math.random() * 900 + 100);
}
export function sanitizeText(t) {
  return String(t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, LIMITS.CHAT_LEN);
}

// Проверка правдоподобности состояния после шага физики (защита от багов/эксплойтов).
export function sanityCheckPlane(p, st) {
  const v = Math.hypot(p.vx, p.vy);
  const vmaxAbs = st.vmax * 2.2;
  if (!isFinite(v) || !isFinite(p.x) || !isFinite(p.y)) { p.vx = 0; p.vy = 0; p.x = isFinite(p.x) ? p.x : 0; p.y = 500; return false; }
  if (v > vmaxAbs) { p.vx *= vmaxAbs / v; p.vy *= vmaxAbs / v; return false; }
  return true;
}
