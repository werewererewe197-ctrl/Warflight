// Профили игроков: опыт, валюта, открытые самолёты, улучшения, статистика.
// Хранение — простой JSON-файл data/profiles.json (запись с задержкой).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { levelFromXp, upgradeCost, UPGRADE_TRACKS, UPGRADE_MAX } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.PROFILES_FILE || path.resolve(__dirname, '..', 'data', 'profiles.json');

export class ProfileStore {
  constructor(data) {
    this.data = data;
    this.profiles = {};
    this.dirty = false;
    try {
      if (fs.existsSync(FILE)) this.profiles = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    } catch (e) { console.warn('Не удалось прочитать профили:', e.message); }
    setInterval(() => this.flush(), 5000).unref();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(this.profiles));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('Не удалось сохранить профили:', e.message); }
  }

  defaultUnlocked() { return this.data.planes.filter(p => p.cost === 0).map(p => p.id); }

  get(token, name) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/.test(token)) return null;
    let p = this.profiles[token];
    if (!p) {
      p = this.profiles[token] = {
        name, xp: 0, money: 500, unlocked: this.defaultUnlocked(), upgrades: {},
        stats: { matches: 0, wins: 0, kills: 0, deaths: 0, damage: 0, ground: 0, pilotKills: 0 }, created: Date.now(),
      };
      this.dirty = true;
    }
    for (const id of this.defaultUnlocked()) if (!p.unlocked.includes(id)) p.unlocked.push(id);
    if (name && p.name !== name) { p.name = name; this.dirty = true; }
    return p;
  }

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
    const u = p.upgrades[planeId] || (p.upgrades[planeId] = {});
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
    this.dirty = true;
    return { xp, money };
  }
}
