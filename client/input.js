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

  pilotInput(pos, autoAim) {
    const e = this.takeEdges();
    if (!this.enabled) return { mx: 0 };
    let mx = 0;
    if (this.key('KeyA', 'ArrowLeft')) mx -= 1;
    if (this.key('KeyD', 'ArrowRight')) mx += 1;
    if (this.joy.active) { if (this.joy.x < -0.3) mx = -1; else if (this.joy.x > 0.3) mx = 1; }
    let aim = pos ? Math.atan2(-(this.mouse.y - pos.y), this.mouse.x - pos.x) : 0;
    if (this.touch && autoAim !== undefined && autoAim !== null) aim = autoAim;
    const inp = { mx, aim, f: (this.key('Space') || this.mouse.down || this.tbtn.fire) ? 1 : 0 };
    if (e.j || (this.joy.active && this.joy.y < -0.6 && !this._jumped)) inp.j = 1;
    this._jumped = this.joy.active && this.joy.y < -0.6;
    if (e.e) inp.e = 1;
    if (e.k) inp.k = 1;
    return inp;
  }

  // ---------- сенсорное управление ----------
  buildTouch() {
    const root = document.getElementById('touch');
    root.classList.add('on');
    const stick = root.querySelector('.stick'), knob = root.querySelector('.knob');
    const setKnob = () => { knob.style.transform = `translate(${this.joy.x * 40}px, ${this.joy.y * 40}px)`; };
    const upd = (t) => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (t.clientX - cx) / 50, dy = (t.clientY - cy) / 50;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.joy.x = dx; this.joy.y = dy; setKnob();
    };
    stick.addEventListener('touchstart', e => { e.preventDefault(); const t = e.changedTouches[0]; this.joy.id = t.identifier; this.joy.active = true; upd(t); }, { passive: false });
    stick.addEventListener('touchmove', e => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === this.joy.id) upd(t); }, { passive: false });
    const end = e => { for (const t of e.changedTouches) if (t.identifier === this.joy.id) { this.joy.active = false; this.joy.x = this.joy.y = 0; setKnob(); } };
    stick.addEventListener('touchend', end); stick.addEventListener('touchcancel', end);

    root.querySelectorAll('[data-btn]').forEach(b => {
      const name = b.dataset.btn;
      const on = e => {
        e.preventDefault(); b.classList.add('pressed');
        if (name === 'fire' || name === 'boost') this.tbtn[name] = true;
        else if (name === 'bomb') this.edges.b = 1;
        else if (name === 'rocket') this.edges.r = 1;
        else if (name === 'flip') this.edges.fl = 1;
        else if (name === 'eject') this.edges.e = 1;
        else if (name === 'jump') this.edges.j = 1;
        else if (name === 'chat') this.onTouchChat && this.onTouchChat();
      };
      const off = e => { e.preventDefault(); b.classList.remove('pressed'); this.tbtn[name] = false; };
      b.addEventListener('touchstart', on, { passive: false });
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    });
    const thr = root.querySelector('.throttle'), fill = thr.querySelector('.fill');
    const setThr = t => {
      const r = thr.getBoundingClientRect();
      const v = clamp(1 - (t.clientY - r.top) / r.height, 0, 1);
      this.throttleTarget = v; fill.style.height = (v * 100) + '%';
    };
    thr.addEventListener('touchstart', e => { e.preventDefault(); setThr(e.changedTouches[0]); }, { passive: false });
    thr.addEventListener('touchmove', e => { e.preventDefault(); setThr(e.changedTouches[0]); }, { passive: false });
    this.throttleTarget = 0.85; fill.style.height = '85%';
  }

  setTouchVisible(v) {
    const root = document.getElementById('touch');
    if (root) root.style.display = this.touch && v ? '' : 'none';
  }
}
