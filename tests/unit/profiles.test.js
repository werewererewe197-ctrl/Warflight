// Прокачка и экономика: открытие самолётов, улучшения, награды, сохранение.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DATA, tmpFile } from '../helpers.js';
import { levelFromXp, upgradeCost, UPGRADE_MAX } from '../../shared/constants.js';
import * as C from '../../shared/constants.js';
import { buildStats } from '../../shared/physics.js';

async function freshStore(file = tmpFile('profiles.json')) {
  process.env.PROFILES_FILE = file;
  const mod = await import('../../server/profiles.js?' + Math.random());
  return { store: new mod.ProfileStore(DATA), file, mod };
}
const TOKEN = 'unit_token_ABCDEFGHIJ';

describe('профиль', () => {
  it('новый профиль: стартовые деньги, открыты только истребители 1-го ранга', async () => {
    const { store } = await freshStore();
    const p = store.get(TOKEN, 'Ace');
    expect(p.money).toBe(500);
    expect(p.unlocked.sort()).toEqual(DATA.planes.filter(d => d.cost === 0).map(d => d.id).sort());
  });

  it('неверный токен не создаёт профиль', async () => {
    const { store } = await freshStore();
    for (const t of [undefined, '', 'short', 'x'.repeat(200), '<script>', { a: 1 }]) expect(store.get(t, 'n')).toBeNull();
  });

  it('открытие: нужен уровень, деньги и самолёт предыдущего ранга; деньги не уходят в минус', async () => {
    const { store } = await freshStore();
    const p = store.get(TOKEN, 'Ace');
    expect(store.unlock(p, 'us_a2')).toMatch(/уровень/);
    p.xp = 400; // уровень 2
    expect(levelFromXp(p.xp)).toBe(2);
    expect(store.unlock(p, 'us_a2')).toMatch(/средств/);
    p.money = 1500;
    expect(store.unlock(p, 'us_a2')).toBeNull();
    expect(p.money).toBe(0);
    expect(store.unlock(p, 'us_a2')).toMatch(/Уже/);
    p.xp = 2400; p.money = 100000;
    expect(store.unlock(p, 'su_b3')).toMatch(/предыдущего/);
    expect(store.unlock(p, 'nope')).toBeTruthy();
  });

  it('улучшения: стоимость по формуле, максимум 3 уровня, без денег — отказ', async () => {
    const { store } = await freshStore();
    const p = store.get(TOKEN, 'Ace');
    p.money = 1e6;
    for (let l = 0; l < UPGRADE_MAX; l++) {
      const before = p.money;
      expect(store.upgrade(p, 'us_f1', 'engine')).toBeNull();
      expect(before - p.money).toBe(upgradeCost(1, l));
    }
    expect(store.upgrade(p, 'us_f1', 'engine')).toMatch(/Максимальный/);
    expect(store.upgrade(p, 'us_f1', 'hack')).toBeTruthy();
    expect(store.upgrade(p, 'us_b3', 'engine')).toMatch(/не открыт/);
    p.money = 0;
    expect(store.upgrade(p, 'us_f1', 'armor')).toMatch(/средств/);
  });

  it('улучшения меняют характеристики ровно на заявленную величину', () => {
    expect(C.UPGRADE_EFFECTS, 'в constants.js нет таблицы заявленных эффектов улучшений').toBeTruthy();
    const E = C.UPGRADE_EFFECTS;
    for (const d of DATA.planes) {
      const b = buildStats(d, {}, DATA), u = buildStats(d, { engine: 3, armor: 3, damage: 3, ammo: 3, accuracy: 3 }, DATA);
      expect(u.thrust / b.thrust).toBeCloseTo(1 + 3 * E.engine.thrust, 6);
      expect(u.maxHp / b.maxHp).toBeCloseTo(1 + 3 * E.armor.hp, 1);
      expect(u.dmgMul / b.dmgMul).toBeCloseTo(1 + 3 * E.damage.dmg, 6);
      expect(u.ammoMul / b.ammoMul).toBeCloseTo(1 + 3 * E.ammo.ammo, 6);
      expect(u.spreadMul / b.spreadMul).toBeCloseTo(1 - 3 * E.accuracy.spread, 6);
    }
  });

  it('награда за матч начисляется по формуле один раз на вызов', async () => {
    const { store } = await freshStore();
    const p = store.get(TOKEN, 'Ace');
    const r = { kills: 2, pilotKills: 1, ground: 3, damage: 800, deaths: 1 };
    const rw = store.applyMatch(p, r, true);
    expect(rw.xp).toBe(Math.round(50 + 200 + 40 + 135 + 100 + 200));
    expect(p.xp).toBe(rw.xp);
    expect(p.money).toBe(500 + rw.money);
    expect(p.stats.matches).toBe(1);
  });

  it('прогресс сохраняется на диск и загружается после перезапуска', async () => {
    const file = tmpFile('profiles.json');
    const a = await freshStore(file);
    const p = a.store.get(TOKEN, 'Ace');
    p.money = 1234; a.store.dirty = true;
    a.store.flush();
    const b = await freshStore(file);
    expect(b.store.get(TOKEN, 'Ace').money).toBe(1234);
  });

  it('файл профилей не хранит токены в открытом виде', async () => {
    const file = tmpFile('profiles.json');
    const a = await freshStore(file);
    a.store.get(TOKEN, 'Ace'); a.store.dirty = true; a.store.flush();
    expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
  });
});
