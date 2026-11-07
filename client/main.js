// Точка входа клиента.
import { Renderer } from './render.js';
import { Input } from './input.js';
import { OfflineGame } from './offline.js';
import { MAPS, getTerrain } from '../shared/maps.js';
import { NATIONS, CLASSES } from '../shared/constants.js';

const $ = id => document.getElementById(id);

class App {
  constructor(data) {
    this.data = data;
    this.renderer = new Renderer($('game'));
    this.input = new Input($('game'));
    this.input.toast = t => this.toast(t);
    this.mode = null;
    this.last = performance.now();
    this.bindMenu();
    this.show('menu');
    requestAnimationFrame(t => this.loop(t));
  }
  profileUpgrades() { return {}; }
  show(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('hidden', el.id !== id);
    this.screen = id;
  }
  toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('on');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('on'), 2200);
  }
  bindMenu() {
    document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => this.show('menu'));
    $('btn-help').onclick = () => this.show('help');
    $('btn-offline').onclick = () => {
      $('o-map').innerHTML = Object.values(MAPS).map(m => `<option value="${m.id}">${m.name}</option>`).join('');
      $('o-plane').innerHTML = this.data.planes.map(p => `<option value="${p.id}">${NATIONS[p.nation].name} — ${p.name} (${CLASSES[p.class].name})</option>`).join('');
      this.show('offline');
    };
    $('btn-offline-go').onclick = () => {
      this.show(null);
      this.mode = new OfflineGame(this, $('o-map').value, $('o-plane').value);
      this.input.setTouchVisible(true);
    };
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape' && this.mode instanceof OfflineGame) { this.mode = null; this.input.setTouchVisible(false); this.show('menu'); }
    });
  }
  loop(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000); this.last = t;
    if (this.mode) this.mode.frame(dt);
    else this.idle(dt);
    requestAnimationFrame(t2 => this.loop(t2));
  }
  idle(dt) {
    // фон меню: медленный пролёт над картой
    const r = this.renderer;
    if (!r.terrain) { r.setTerrain(getTerrain('islands')); this.bgX = 600; }
    this.bgX = (this.bgX + dt * 60) % r.terrain.width;
    r.follow(this.bgX, 700, 0, dt);
    r.update(dt);
    r.draw({ planes: [], pilots: [], ground: [] });
  }
}

fetch('/shared/planes.json').then(r => r.json()).then(data => { window.app = new App(data); });
