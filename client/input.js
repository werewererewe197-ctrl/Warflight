// Ввод: клавиатура, мышь, сенсорное управление. Формирует команды на каждый тик.
import { clamp, wrapAngle } from '../shared/constants.js';

export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.edges = {};
    this.mouse = { x: 0, y: 0, down: false, right: false, moved: 0 };
    this.enabled = true;
    this.mouseSteer = localStorage.getItem('wf_mouseSteer') === '1';
    this.touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.autoFlip = this.touch ? true : localStorage.getItem('wf_autoFlip') === '1';
    this.joy = { active: false, x: 0, y: 0, id: null };
    this.aimJoy = { active: false, x: 0, y: 0, id: null };
    this.lastAim = Math.PI / 2;
    this.tbtn = {};
    this.throttleTarget = null;
    this.onKey = null; // внешний обработчик (чат и т.п.)
    this._flipHold = 0;

    window.addEventListener('keydown', e => {
      if (this.onKey && this.onKey(e)) return;
      if (!this.enabled) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.code;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) e.preventDefault();
      if (!this.keys.has(k)) {
        if (k === 'KeyB') this.edges.b = 1;
        if (k === 'KeyR') this.edges.r = 1;
        if (k === 'KeyF') this.edges.fl = 1;
        if (k === 'KeyE') this.edges.e = 1;
        if (k === 'KeyW' || k === 'ArrowUp') this.edges.j = 1;
        if (k === 'KeyK') this.edges.k = 1;
        if (k === 'KeyM') { this.mouseSteer = !this.mouseSteer; localStorage.setItem('wf_mouseSteer', this.mouseSteer ? '1' : '0'); this.toast && this.toast('Управление мышью: ' + (this.mouseSteer ? 'вкл' : 'выкл')); }
        if (k === 'KeyG') { this.autoFlip = !this.autoFlip; localStorage.setItem('wf_autoFlip', this.autoFlip ? '1' : '0'); this.toast && this.toast('Автопереворот: ' + (this.autoFlip ? 'вкл' : 'выкл')); }
      }
      this.keys.add(k);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; });
    canvas.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.moved = performance.now(); });
    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) { this.mouse.right = true; this.edges.r = 1; }
    });
    window.addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; if (e.button === 2) this.mouse.right = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    if (this.touch) this.buildTouch();
  }

  key(...codes) { return codes.some(c => this.keys.has(c)); }

  takeEdges() { const e = this.edges; this.edges = {}; return e; }

  // Ввод для самолёта. pos — экранная позиция своего самолёта, plane — состояние.
  planeInput(pos, plane) {
    const e = this.takeEdges();
    if (!this.enabled) return { p: 0, t: 0 };
    let p = 0, t = 0;
    if (this.key('KeyA', 'ArrowLeft')) p += 1;
    if (this.key('KeyD', 'ArrowRight')) p -= 1;
    if (this.key('KeyW', 'ArrowUp')) t += 1;
    if (this.key('KeyS', 'ArrowDown')) t -= 1;
    let target = null;
    if (p === 0 && this.mouseSteer && pos) target = Math.atan2(-(this.mouse.y - pos.y), this.mouse.x - pos.x);
    if (this.joy.active && Math.hypot(this.joy.x, this.joy.y) > 0.25) target = Math.atan2(-this.joy.y, this.joy.x);
    if (target !== null && plane) p = clamp(wrapAngle(target - plane.a) * 3.5, -1, 1);
    const inp = {
      p, t,
      f: (this.key('Space') || this.mouse.down || this.tbtn.fire) ? 1 : 0,
      bo: (this.key('ShiftLeft', 'ShiftRight') || this.tbtn.boost) ? 1 : 0,
    };
    if (this.throttleTarget !== null) inp.ta = this.throttleTarget;
    if (e.b) inp.b = 1;
    if (e.r) inp.r = 1;
    if (e.fl) inp.fl = 1;
    if (e.e) inp.e = 1;
    if (e.k) inp.k = 1;
    // автопереворот: держим «живот» к земле
    if (this.autoFlip && plane && !plane.ground && !inp.fl) {
      const want = Math.cos(plane.a) >= 0 ? 1 : -1;
      if (Math.abs(Math.cos(plane.a)) > 0.35 && plane.rollT !== want) {
        this._flipHold += 1;
        if (this._flipHold > 8) { inp.fl = 1; this._flipHold = 0; }
      } else this._flipHold = 0;
    }
    return inp;
  }

  pilotInput(pos) {
    const e = this.takeEdges();
    if (!this.enabled) return { mx: 0, aim: this.lastAim };
    let mx = 0;
    if (this.key('KeyA', 'ArrowLeft')) mx -= 1;
    if (this.key('KeyD', 'ArrowRight')) mx += 1;
    if (this.joy.active) { if (this.joy.x < -0.3) mx = -1; else if (this.joy.x > 0.3) mx = 1; }
    let aim = this.lastAim, f = this.key('Space') || this.mouse.down;
    if (this.touch) {
      // правый джойстик: направление стрельбы, отклонение — огонь
      const m = Math.hypot(this.aimJoy.x, this.aimJoy.y);
      if (this.aimJoy.active && m > 0.25) { aim = Math.atan2(-this.aimJoy.y, this.aimJoy.x); if (m > 0.45) f = true; }
    } else if (pos) aim = Math.atan2(-(this.mouse.y - pos.y), this.mouse.x - pos.x);
    this.lastAim = aim;
    const inp = { mx, aim, f: f ? 1 : 0 };
    // прыжок: W, кнопка или левый джойстик вверх
    const up = this.joy.active && this.joy.y < -0.6;
    if (e.j || (up && !this._jumped)) inp.j = 1;
    this._jumped = up;
    if (e.e) inp.e = 1;
    if (e.k) inp.k = 1;
    return inp;
  }

  // ---------- сенсорное управление ----------
  bindStick(el, st) {
    const knob = el.querySelector('.knob');
    const R = 46;
    const setKnob = () => { knob.style.transform = `translate(${st.x * R}px, ${st.y * R}px)`; };
    const upd = t => {
      const r = el.getBoundingClientRect();
      let dx = (t.clientX - (r.left + r.width / 2)) / R, dy = (t.clientY - (r.top + r.height / 2)) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      st.x = dx; st.y = dy; setKnob();
    };
    el.addEventListener('touchstart', e => { e.preventDefault(); const t = e.changedTouches[0]; st.id = t.identifier; st.active = true; upd(t); }, { passive: false });
    el.addEventListener('touchmove', e => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === st.id) upd(t); }, { passive: false });
    const end = e => { for (const t of e.changedTouches) if (t.identifier === st.id) { st.active = false; st.x = st.y = 0; setKnob(); } };
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
  }

  buildTouch() {
    const root = this.touchRoot = document.getElementById('touch');
    this.aimJoy = { active: false, x: 0, y: 0, id: null };
    this.bindStick(root.querySelector('.stick.move'), this.joy);
    this.bindStick(root.querySelector('.stick.aim'), this.aimJoy);

    root.querySelectorAll('[data-btn]').forEach(b => {
      const name = b.dataset.btn;
      const on = e => {
        e.preventDefault(); b.classList.add('pressed');
        if (name === 'fire' || name === 'boost') this.tbtn[name] = true;
        else if (name === 'bomb') this.edges.b = 1;
        else if (name === 'rocket') this.edges.r = 1;
        else if (name === 'flip') this.edges.fl = 1;
        else if (name === 'eject' || name === 'spawn') this.edges.e = 1;
        else if (name === 'jump') this.edges.j = 1;
        else if (name === 'chat') this.onTouchChat && this.onTouchChat();
        else if (name === 'menu') this.onTouchMenu && this.onTouchMenu();
        else if (name === 'score') this.onTouchScore && this.onTouchScore(true);
      };
      const off = e => {
        e.preventDefault(); b.classList.remove('pressed'); this.tbtn[name] = false;
        if (name === 'score') this.onTouchScore && this.onTouchScore(false);
      };
      b.addEventListener('touchstart', on, { passive: false });
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    });
    const thr = root.querySelector('.throttle'), fill = thr.querySelector('.fill'), val = thr.querySelector('.thr-val');
    const setThr = t => {
      const r = thr.getBoundingClientRect();
      const v = clamp(1 - (t.clientY - r.top - 8) / (r.height - 16), 0, 1);
      this.throttleTarget = v; fill.style.height = (v * 100) + '%'; val.textContent = Math.round(v * 100);
    };
    thr.addEventListener('touchstart', e => { e.preventDefault(); setThr(e.changedTouches[0]); }, { passive: false });
    thr.addEventListener('touchmove', e => { e.preventDefault(); setThr(e.changedTouches[0]); }, { passive: false });
    this.throttleTarget = 0.85; fill.style.height = '85%';
  }

  // Режим сенсорных элементов: 'plane' | 'pilot' | 'none'.
  setTouchMode(mode) {
    if (this.touchRoot && this.touchRoot.dataset.mode !== mode) {
      this.touchRoot.dataset.mode = mode;
      this.tbtn = {};
      this.joy.active = false; this.joy.x = this.joy.y = 0;
      if (this.aimJoy) { this.aimJoy.active = false; this.aimJoy.x = this.aimJoy.y = 0; }
      this.touchRoot.querySelectorAll('.knob').forEach(k => k.style.transform = '');
    }
  }

  // Состояние кнопок оружия: наличие и счётчики.
  setTouchInfo(o) {
    if (!this.touchRoot) return;
    const key = JSON.stringify(o);
    if (key === this._tiKey) return;
    this._tiKey = key;
    const set = (sel, has, n) => {
      const b = this.touchRoot.querySelector(sel); if (!b) return;
      b.style.display = has ? '' : 'none';
      b.classList.toggle('off', has && n <= 0);
      const badge = b.querySelector('.badge'); if (badge) badge.textContent = has ? String(n) : '';
    };
    set('.rb.bomb', o.hasBombs, o.bombs);
    set('.rb.rocket', o.hasRockets, o.rockets);
    this.touchRoot.classList.toggle('can-spawn', !!o.canSpawn);
  }

  setTouchVisible(v) {
    const root = document.getElementById('touch');
    if (root) root.style.display = this.touch && v ? '' : 'none';
  }
}
