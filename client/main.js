// Точка входа клиента: экраны, сеть, переключение между меню, лобби и боем.
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { OfflineGame } from './offline.js';
import { NetGame } from './netgame.js';
import { svg } from './icons.js';
import { MAPS, getTerrain } from '../shared/maps.js';
import { NATIONS, CLASSES, DEFAULT_SETTINGS, levelFromXp } from '../shared/constants.js';

const $ = id => document.getElementById(id);

// Вставляет SVG-значки в элементы с атрибутом data-icon.
export function applyIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.iconDone) return;
    el.dataset.iconDone = '1';
    el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon));
  });
}

function token() {
  let t = localStorage.getItem('wf_token');
  if (!t) {
    const a = new Uint8Array(18); crypto.getRandomValues(a);
    t = [...a].map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[b % 64]).join('');
    localStorage.setItem('wf_token', t);
  }
  return t;
}

class App {
  constructor(data) {
    this.data = data;
    this.renderer = new Renderer($('game'));
    this.input = new Input($('game'));
    this.input.toast = t => this.toast(t);
    this.input.onKey = e => this.onKey(e);
    this.input.onTouchChat = () => this.openChat();
    this.input.onTouchMenu = () => this.togglePause();
    this.input.onTouchScore = on => this.showScoreboard(on);
    applyIcons(document);
    if (this.input.touch) document.body.classList.add('touch');
    this.ui = new UI(this);
    this.mode = null;
    this.game = null;
    this.room = null;
    this.myId = null;
    try { this.profile = JSON.parse(localStorage.getItem('wf_profile') || 'null'); } catch { this.profile = null; }
    this.last = performance.now();
    $('nick').value = localStorage.getItem('wf_name') || '';
    this.net = new Net(m => this.onMessage(m), s => this.onStatus(s));
    this.bind();
    this.show('menu');
    this.updateProfileMini();
    requestAnimationFrame(t => this.loop(t));
  }

  get name() { return $('nick').value.trim() || 'Пилот'; }
  profileUpgrades(id) { return (this.profile && this.profile.upgrades && this.profile.upgrades[id]) || {}; }

  show(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('hidden', el.id !== id);
    this.screen = id;
    $('ingame').classList.toggle('hidden', !(this.game || this.mode) || !!id);
    this.input.setTouchVisible(!id && !!(this.game || this.mode));
    this.input.enabled = !id;
  }
  toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('on');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('on'), 2400);
  }
  modal(html, buttons) {
    $('modal-body').innerHTML = html;
    $('modal-btns').innerHTML = '';
    for (const [label, fn, cls] of buttons) {
      const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label;
      b.onclick = () => { $('modal').classList.add('hidden'); fn && fn(); };
      $('modal-btns').appendChild(b);
    }
    $('modal').classList.remove('hidden');
  }

  onStatus(s) {
    $('conn-status').textContent = s === 'open' ? `Сервер: подключено (${location.host})` : s === 'connecting' ? 'Подключение к серверу…' : 'Нет связи с сервером — переподключение…';
    if (s === 'open') this.net.send({ t: 'hello', name: this.name, token: token() });
    if (s === 'closed' && (this.game || this.room)) { this.leaveToMenu(); this.toast('Соединение потеряно'); }
  }

  updateProfileMini() {
    const p = this.profile;
    $('profile-mini').innerHTML = p ? `<span class="chip">${svg('star')}${levelFromXp(p.xp)}</span> <span class="chip">${svg('coin')}${p.money}</span> <span class="chip">${svg('plane')}${p.unlocked.length}</span>` : '';
  }

  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.myId = m.id; this.setProfile(m.profile); break;
      case 'profile': this.setProfile(m.profile); if (this.screen === 'hangar') this.ui.renderHangar(); break;
      case 'rooms': this.ui.renderRooms(m.list); break;
      case 'room':
        this.room = m.room;
        this.ui.renderLobby(m.room);
        if (!this.game && (this.awaitRoom || !['lobby', 'results', 'create'].includes(this.screen))) this.show('lobby');
        this.awaitRoom = false;
        break;
      case 'left':
        if (m.reason === 'kick') this.modal('<h2>Вас исключили из лобби</h2>', [['OK']]);
        this.room = null; this.game = null; this.show('menu');
        break;
      case 'chat':
        this.ui.addChat($('lobby-chat'), m);
        if (this.game) this.addIngameChat(m);
        break;
      case 'err':
        if (m.needPassword) { this.askPassword(m.code); break; }
        this.toast(m.msg);
        break;
      case 'match':
        this.game = new NetGame(this, m);
        this.mode = null;
        this.show(null);
        break;
      case 'roster': if (this.game) this.game.setRoster(m.roster); break;
      case 's': if (this.game) this.game.onSnapshot(m); break;
      case 'end':
        if (this.game) { this.game.ended = true; }
        this.game = null;
        this.ui.renderResults(m);
        $('scoreboard').classList.add('hidden'); $('pause').classList.add('hidden');
        this.show('results');
        break;
    }
  }

  setProfile(p) {
    this.profile = p;
    try { localStorage.setItem('wf_profile', JSON.stringify(p)); } catch {}
    this.updateProfileMini();
    if (this.room) this.ui.renderLobby(this.room);
  }

  joinRoom(code, locked) {
    if (locked) return this.askPassword(code);
    this.net.send({ t: 'join', code });
  }
  askPassword(code) {
    this.modal(`<h2>Пароль лобби</h2><input id="pw-input" type="password" style="width:100%" maxlength="24">`, [
      ['Отмена', null, 'ghost'], ['Войти', () => this.net.send({ t: 'join', code, password: $('pw-input').value }), 'primary']]);
    setTimeout(() => $('pw-input') && $('pw-input').focus(), 50);
  }

  rename() {
    localStorage.setItem('wf_name', this.name);
    this.net.send({ t: 'rename', name: this.name });
  }

  bind() {
    document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => this.show(this.room ? 'lobby' : 'menu'));
    $('nick').onchange = () => this.rename();
    $('btn-quick').onclick = () => { this.rename(); this.net.send({ t: 'quick' }); };
    $('btn-create').onclick = () => { this.rename(); this.ui.fillCreateForm({ ...DEFAULT_SETTINGS, name: `Лобби ${this.name}` }, false); this.show('create'); };
    $('btn-browse').onclick = () => { this.net.send({ t: 'list' }); this.show('browser'); };
    $('btn-refresh').onclick = () => this.net.send({ t: 'list' });
    $('btn-join-code').onclick = () => { this.rename(); const c = $('join-code').value.trim().toUpperCase(); if (c.length === 6) this.net.send({ t: 'join', code: c }); else this.toast('Код состоит из 6 символов'); };
    $('btn-hangar').onclick = () => { this.ui.renderHangar(); this.show('hangar'); };
    $('btn-profile').onclick = () => { this.ui.renderProfile(); this.show('profile'); };
    $('btn-help').onclick = () => this.show('help');
    $('btn-create-cancel').onclick = () => this.show(this.ui.editMode ? 'lobby' : 'menu');
    $('btn-create-ok').onclick = () => {
      const s = this.ui.readCreateForm();
      if (this.ui.editMode) { this.net.send({ t: 'settings', settings: s }); this.show('lobby'); }
      else { this.awaitRoom = true; this.net.send({ t: 'create', settings: s }); }
    };
    $('btn-team').onclick = () => { const me = this.room && this.room.players.find(p => p.id === this.myId); if (me) this.net.send({ t: 'team', team: 1 - me.team }); };
    $('btn-ready').onclick = () => { const me = this.room.players.find(p => p.id === this.myId); this.net.send({ t: 'ready', ready: !me.ready }); };
    $('btn-start').onclick = () => this.net.send({ t: 'start' });
    $('btn-settings').onclick = () => { this.ui.fillCreateForm(this.room.settings, true); this.show('create'); };
    $('btn-leave').onclick = () => { this.net.send({ t: 'leave' }); this.room = null; this.show('menu'); };
    const sendLobbyChat = () => { const v = $('lobby-chat-input').value.trim(); if (v) this.net.send({ t: 'chat', text: v }); $('lobby-chat-input').value = ''; };
    $('lobby-chat-send').onclick = sendLobbyChat;
    $('lobby-chat-input').onkeydown = e => { if (e.key === 'Enter') sendLobbyChat(); };
    $('btn-results-ok').onclick = () => this.show(this.room ? 'lobby' : 'menu');
    $('btn-resume').onclick = () => { $('pause').classList.add('hidden'); this.input.enabled = true; };
    $('btn-quit').onclick = () => { $('pause').classList.add('hidden'); this.leaveToMenu(); };
    $('btn-offline').onclick = () => {
      $('o-map').innerHTML = Object.values(MAPS).map(m => `<option value="${m.id}">${m.name}</option>`).join('');
      $('o-plane').innerHTML = this.data.planes.map(p => `<option value="${p.id}">${NATIONS[p.nation].name} — ${p.name} (${CLASSES[p.class].name})</option>`).join('');
      this.show('offline');
    };
    $('btn-offline-go').onclick = () => { this.mode = new OfflineGame(this, $('o-map').value, $('o-plane').value); this.input.setTouchMode('plane'); this.show(null); };
    const ci = $('chat-input');
    ci.onkeydown = e => {
      if (e.key === 'Enter') { const v = ci.value.trim(); if (v) this.net.send({ t: 'chat', text: v, team: e.shiftKey ? 1 : 0 }); this.closeChat(); e.preventDefault(); }
      if (e.key === 'Escape') { this.closeChat(); e.preventDefault(); }
      e.stopPropagation();
    };
    ci.onblur = () => this.closeChat();
  }

  leaveToMenu() {
    if (this.room) this.net.send({ t: 'leave' });
    this.game = null; this.room = null; this.mode = null;
    this.show('menu');
  }

  openChat() {
    if (!this.game) return;
    const ci = $('chat-input'); ci.classList.remove('hidden'); ci.value = ''; ci.focus();
    this.input.enabled = false; this.input.keys.clear();
  }
  closeChat() { const ci = $('chat-input'); ci.classList.add('hidden'); ci.blur(); if (!this.screen) this.input.enabled = true; }

  togglePause() {
    const p = $('pause');
    p.classList.toggle('hidden');
    this.input.enabled = p.classList.contains('hidden');
    this.input.keys.clear();
  }

  addIngameChat(m) {
    const el = this.ui.addChat($('chat-log'), m);
    setTimeout(() => el.remove(), 12000);
  }

  showScoreboard(on) {
    const sb = $('scoreboard');
    if (on && this.game) { sb.innerHTML = this.game.scoreboardHtml(); sb.classList.remove('hidden'); }
    else sb.classList.add('hidden');
  }

  onKey(e) {
    if (e.type !== 'keydown') return false;
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return false;
    if (this.mode instanceof OfflineGame && e.code === 'Escape') { this.mode = null; this.show('menu'); return true; }
    if (!this.game || this.screen) return false;
    if (e.code === 'Enter') { e.preventDefault(); this.openChat(); return true; }
    if (e.code === 'Escape') { this.togglePause(); return true; }
    if (e.code === 'Tab') {
      e.preventDefault();
      this.showScoreboard(true);
      const up = ev => { if (ev.code === 'Tab') { this.showScoreboard(false); window.removeEventListener('keyup', up); } };
      window.addEventListener('keyup', up);
      return true;
    }
    return false;
  }

  loop(t) {
    const dt = Math.min(0.1, (t - this.last) / 1000); this.last = t;
    try {
      if (this.game) this.game.frame(dt);
      else if (this.mode) this.mode.frame(dt);
      else this.idle(dt);
    } catch (e) { console.error(e); }
    requestAnimationFrame(t2 => this.loop(t2));
  }

  idle(dt) {
    const r = this.renderer;
    if (!this.bgT) { this.bgT = getTerrain('islands'); r.setTerrain(this.bgT); this.bgX = 600; }
    if (r.terrain !== this.bgT) r.setTerrain(this.bgT);
    this.bgX = (this.bgX + dt * 60) % this.bgT.width;
    r.follow(this.bgX, 700, 0, dt);
    r.update(dt);
    r.draw({ planes: [], pilots: [], ground: [] });
  }
}

fetch('/shared/planes.json').then(r => r.json()).then(data => { window.app = new App(data); });
