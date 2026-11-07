// Профили игроков: опыт, валюта, открытые самолёты, улучшения, статистика.
// Хранение — простой JSON-файл data/profiles.json (запись с задержкой).
// Токены хранятся только в виде SHA-256: утечка файла не позволяет войти в чужой профиль.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { levelFromXp, upgradeCost, UPGRADE_TRACKS, UPGRADE_MAX } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_RE = /^[A-Za-z0-9_-]{12,64}$/;
const NEW_PROFILES_PER_IP_HOUR = +(process.env.WF_NEW_PROFILES_PER_IP || 30);

export const hashToken = t => crypto.createHash('sha256').update('warflight:' + t).digest('hex');

export class ProfileStore {
  constructor(data, file = process.env.PROFILES_FILE || path.resolve(__dirname, '..', 'data', 'profiles.json')) {
    this.data = data;
    this.file = file;
    this.profiles = {};
    this.dirty = false;
    this.newByIp = new Map();
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        if (raw.v === 2 && raw.p) this.profiles = raw.p;
        else {
          // миграция старого формата: ключом был сам токен
          for (const [k, v] of Object.entries(raw)) this.profiles[TOKEN_RE.test(k) ? hashToken(k) : k] = v;
          this.dirty = true;
        }
      }
    } catch (e) { console.warn('Не удалось прочитать профили:', e.message); }
    this.timer = setInterval(() => this.flush(), 5000);
    this.timer.unref();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 2, p: this.profiles }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.dirty = true; console.warn('Не удалось сохранить профили:', e.message); }
  }

  defaultUnlocked() { return this.data.planes.filter(p => p.cost === 0).map(p => p.id); }

  blank(name) {
    return {
      name, xp: 0, money: 500, unlocked: this.defaultUnlocked(), upgrades: {},
      stats: { matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, ground: 0, pilotKills: 0 }, created: Date.now(),
    };
  }

  // Профиль по токену (без ограничений — для тестов и внутренних вызовов). null — если токен неверный.
  get(token, name) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const h = hashToken(token);
    let p = this.profiles[h];
    if (!p) { p = this.profiles[h] = this.blank(name); this.dirty = true; }
    for (const id of this.defaultUnlocked()) if (!p.unlocked.includes(id)) p.unlocked.push(id);
    if (name && p.name !== name) { p.name = name; this.dirty = true; }
    return p;
  }

  // Вход: валидный токен → сохраняемый профиль; иначе (или при превышении лимита новых профилей с IP) — гостевой.
  login(token, name, ip = '?') {
    if (typeof token === 'string' && TOKEN_RE.test(token)) {
      const h = hashToken(token);
      if (!this.profiles[h]) {
        const now = Date.now();
        const list = (this.newByIp.get(ip) || []).filter(t => now - t < 3600000);
        if (list.length >= NEW_PROFILES_PER_IP_HOUR) return { profile: this.guest(name), hash: null, guest: true };
        list.push(now); this.newByIp.set(ip, list);
      }
      return { profile: this.get(token, name), hash: h, guest: false };
    }
    return { profile: this.guest(name), hash: null, guest: true };
  }

  // Гость: прогресс не сохраняется, доступны только стартовые самолёты.
  guest(name) { const p = this.blank(name); p.money = 0; p.guest = true; return p; }

  rename(p, name) { if (p && !p.guest && p.name !== name) { p.name = name; this.dirty = true; } }

  view(p) { return p ? { ...p, level: levelFromXp(p.xp) } : null; }

  unlock(p, planeId) {
    const def = this.data.planes.find(x => x.id === planeId);
    if (!def) return 'Нет такого самолёта';
    if (p.unlocked.includes(planeId)) return 'Уже открыт';
    const lvl = levelFromXp(p.xp);
    if (lvl < def.level) return `Нужен уровень ${def.level}`;
    // внутри ветки нации: нужен самолёт предыдущего ранга
    const prev = this.data.planes.filter(x => x.nation === def.nation && x.tier === def.tier - 1);
    if (prev.length && !prev.some(x => p.unlocked.includes(x.id))) return 'Сначала откройте самолёт предыдущего ранга';
    if (p.money < def.cost) return 'Недостаточно средств';
    p.money -= def.cost;
    p.unlocked.push(planeId);
    this.dirty = true;
    return null;
  }

  upgrade(p, planeId, track) {
    const def = this.data.planes.find(x => x.id === planeId);
    if (!def || !UPGRADE_TRACKS.includes(track)) return 'Неверное улучшение';
    if (!p.unlocked.includes(planeId)) return 'Самолёт не открыт';
    const u = Object.prototype.hasOwnProperty.call(p.upgrades, planeId) ? p.upgrades[planeId] : (p.upgrades[planeId] = {});
    const lvl = u[track] || 0;
    if (lvl >= UPGRADE_MAX) return 'Максимальный уровень';
    const cost = upgradeCost(def.tier, lvl);
    if (p.money < cost) return 'Недостаточно средств';
    p.money -= cost;
    u[track] = lvl + 1;
    this.dirty = true;
    return null;
  }

  // Начисление наград по итогам матча.
  applyMatch(p, r, won) {
    const xp = Math.round(50 + r.kills * 100 + r.pilotKills * 40 + r.ground * 45 + r.damage / 8 + (won ? 200 : 0));
    const money = Math.round(xp * 0.8);
    p.xp += xp; p.money += money;
    const s = p.stats;
    s.matches++; if (won) s.wins++;
    s.kills += r.kills; s.deaths += r.deaths; s.damage += Math.round(r.damage); s.ground += r.ground; s.pilotKills += r.pilotKills;
    if (!p.guest) this.dirty = true;
    return { xp, money };
  }
}
