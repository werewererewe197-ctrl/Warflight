// Отрисовка мира: небо, параллакс, рельеф, объекты, самолёты, пилоты, эффекты.
import { NATIONS, clamp } from '../shared/constants.js';
import { rng } from '../shared/maps.js';

export class Renderer {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, z: 1 };
    this.particles = [];
    this.tracers = [];
    this.time = 0;
    this.terrain = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.c.width = Math.round(this.W * this.dpr); this.c.height = Math.round(this.H * this.dpr);
    this.c.style.width = this.W + 'px'; this.c.style.height = this.H + 'px';
  }

  setTerrain(t) {
    this.terrain = t; this.particles = []; this.tracers = [];
    const r = rng(t.map.seed * 3 + 1);
    // силуэты дальних гор / холмов для параллакса
    this.farPh = [r() * 10, r() * 10, r() * 10];
    this.midPh = [r() * 10, r() * 10, r() * 10];
  }

  baseZoom() { return this.H < 500 ? Math.min(this.W, this.H * 2) / 1050 : Math.min(this.W, this.H * 1.6) / 1250; }

  follow(x, y, speed = 0, dt = 0.016, extraZoom = 1) {
    const alt = this.terrain ? y - this.terrain.ground(x) : 0;
    const zTarget = this.baseZoom() * clamp(1.15 - speed / 1400, 0.82, 1.1) * extraZoom * clamp(1 - (alt - 350) / 2500, 0.72, 1);
    const k = Math.min(1, dt * 3);
    this.cam.z += (zTarget - this.cam.z) * k;
    const z = this.cam.z;
    let cy = Math.max(y, this.H / (2 * z) - 110);
    const t = this.terrain;
    let cx = x;
    if (t) cx = clamp(x, this.W / (2 * z) - 400, t.width - this.W / (2 * z) + 400);
    this.cam.x = cx; this.cam.y = cy;
  }

  sx(x) { return (x - this.cam.x) * this.cam.z + this.W / 2; }
  sy(y) { return this.H / 2 - (y - this.cam.y) * this.cam.z; }
  wx(sx) { return (sx - this.W / 2) / this.cam.z + this.cam.x; }
  wy(sy) { return (this.H / 2 - sy) / this.cam.z + this.cam.y; }
  visible(x, y, m = 200) {
    const sx = this.sx(x), sy = this.sy(y);
    return sx > -m && sx < this.W + m && sy > -m && sy < this.H + m;
  }

  // ---------- эффекты ----------
  addParticle(p) { if (this.particles.length < 2200) this.particles.push(p); }
  smoke(x, y, dark = 0.5, size = 6, vx = 0, vy = 0) {
    const g = Math.round(200 - dark * 170);
    this.addParticle({ x, y, vx: vx * 0.2 + (Math.random() - 0.5) * 12, vy: vy * 0.2 + 10 + Math.random() * 10, life: 1.6 + Math.random(), max: 2.4, size, grow: 9, color: `${g},${g},${g}`, a: 0.55, kind: 'smoke' });
  }
  fire(x, y, vx = 0, vy = 0) {
    this.addParticle({ x, y, vx: vx * 0.3 + (Math.random() - 0.5) * 20, vy: vy * 0.3 + Math.random() * 20, life: 0.35 + Math.random() * 0.25, max: 0.6, size: 5 + Math.random() * 4, grow: -4, color: Math.random() < 0.5 ? '255,170,40' : '255,90,20', a: 0.9, kind: 'fire' });
  }
  explode(x, y, r = 60) {
    const n = Math.min(40, 10 + r / 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * r * 2.5;
      this.addParticle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 40, life: 0.4 + Math.random() * 0.5, max: 0.9, size: r * 0.18 + Math.random() * r * 0.15, grow: r * 0.1, color: Math.random() < 0.5 ? '255,200,80' : '255,110,30', a: 0.95, kind: 'fire' });
    }
    for (let i = 0; i < n * 0.7; i++) this.smoke(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.3) * r * 0.6, 0.75, r * 0.2 + 4);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI, s = 80 + Math.random() * 200;
      this.addParticle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1 + Math.random(), max: 2, size: 2.5, grow: 0, color: '40,35,30', a: 1, kind: 'debris', g: 1 });
    }
    this.addParticle({ x, y, vx: 0, vy: 0, life: 0.18, max: 0.18, size: r * 1.2, grow: r * 3, color: '255,255,220', a: 0.6, kind: 'flash' });
  }
  flak(x, y) {
    for (let i = 0; i < 6; i++) this.addParticle({ x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, life: 1.5 + Math.random(), max: 2.5, size: 9, grow: 8, color: '50,48,45', a: 0.75, kind: 'smoke' });
    this.addParticle({ x, y, vx: 0, vy: 0, life: 0.12, max: 0.12, size: 14, grow: 60, color: '255,220,120', a: 0.9, kind: 'flash' });
  }
  spark(x, y, big = false) {
    for (let i = 0; i < (big ? 8 : 4); i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 140;
      this.addParticle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.2 + Math.random() * 0.2, max: 0.4, size: big ? 3 : 2, grow: -2, color: '255,230,140', a: 1, kind: 'spark' });
    }
  }
  splash(x, big = false) {
    for (let i = 0; i < (big ? 30 : 8); i++) {
      const s = big ? 220 : 90;
      this.addParticle({ x: x + (Math.random() - 0.5) * (big ? 40 : 8), y: 0, vx: (Math.random() - 0.5) * s * 0.6, vy: Math.random() * s + 40, life: 0.8 + Math.random() * 0.6, max: 1.4, size: big ? 6 : 3, grow: 2, color: '220,235,255', a: 0.85, kind: 'water', g: 1 });
    }
  }
  dust(x, y, big = false) {
    for (let i = 0; i < (big ? 14 : 4); i++) this.addParticle({ x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 80, vy: Math.random() * 80, life: 0.6 + Math.random() * 0.6, max: 1.2, size: big ? 10 : 4, grow: 10, color: '150,130,100', a: 0.6, kind: 'smoke' });
  }
  addTracer(x, y, vx, vy, life, color = '255,230,150', heavy = false) {
    if (this.tracers.length < 900) this.tracers.push({ x, y, vx, vy, life, color, heavy });
  }

  // Эффекты, привязанные к состоянию самолёта (дым, огонь, выхлоп).
  planeFx(pl, dt) {
    const parts = pl.parts || { engine: 1, wing: 1, tail: 1, fuel: 1 };
    const ca = Math.cos(pl.a), sa = Math.sin(pl.a);
    const s = (pl.def ? pl.def.size : 1);
    const nx = pl.x + ca * 14 * s, ny = pl.y + sa * 14 * s;
    this._fxAcc = (this._fxAcc || 0);
    const rate = dt * 60;
    if (parts.engine < 0.75 || pl.dead) {
      const dark = pl.dead ? 0.95 : 1 - parts.engine;
      if (Math.random() < rate * (0.35 + dark * 0.6)) this.smoke(nx, ny, dark, 5 + dark * 6 * s, pl.vx, pl.vy);
    }
    if (pl.fire || pl.dead) {
      if (Math.random() < rate * 0.9) this.fire(pl.x - ca * 2 * s, pl.y - sa * 2 * s, pl.vx, pl.vy);
      if (Math.random() < rate * 0.4) this.smoke(pl.x, pl.y, 0.9, 8 * s, pl.vx, pl.vy);
    }
    if (pl.boosting && Math.random() < rate * 0.6) {
      this.addParticle({ x: pl.x + ca * 8 * s, y: pl.y + sa * 8 * s, vx: pl.vx * 0.8, vy: pl.vy * 0.8, life: 0.15, max: 0.15, size: 3, grow: -6, color: '120,180,255', a: 0.9, kind: 'fire' });
    }
    // инверсионный след на концах крыльев при резком манёвре
    if (pl.g > 3.5 && !pl.dead && Math.random() < rate * 0.8) {
      this.addParticle({ x: pl.x - ca * 4 * s, y: pl.y - sa * 4 * s, vx: 0, vy: 0, life: 0.6, max: 0.6, size: 1.6, grow: 0.5, color: '255,255,255', a: 0.45, kind: 'smoke' });
    }
  }

  update(dt) {
    this.time += dt;
    const t = this.terrain;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles[i] = this.particles[this.particles.length - 1]; this.particles.pop(); continue; }
      if (p.g) p.vy -= 220 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === 'smoke') { p.vx *= 1 - dt * 0.8; p.vy *= 1 - dt * 0.5; }
      p.size = Math.max(0.5, p.size + p.grow * dt);
      if (p.g && t && p.y < t.ground(p.x)) { p.life = 0; }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const b = this.tracers[i];
      b.life -= dt;
      b.vy -= 30 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.life <= 0 || (t && b.y < t.ground(b.x))) {
        if (t && b.life > 0) { if (t.water(b.x)) this.splash(b.x); else if (Math.random() < 0.3) this.dust(b.x, b.y); }
        this.tracers[i] = this.tracers[this.tracers.length - 1]; this.tracers.pop();
      }
    }
  }

  // ---------- кадр ----------
  draw(view) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSky();
    if (!this.terrain) return;
    this.drawParallax();
    this.drawClouds(0);
    this.drawZone(view.zone, false);
    this.drawTerrain();
    this.drawRunways();
    for (const o of view.ground || []) this.drawGround(o);
    for (const p of view.projectiles || []) this.drawProjectile(p);
    for (const c of view.pilots || []) this.drawPilot(c);
    for (const p of view.planes || []) this.drawPlane(p);
    this.drawTracers();
    this.drawParticles();
    this.drawWater();
    this.drawClouds(1);
    this.drawZone(view.zone, true);
    for (const p of view.planes || []) this.drawTag(p);
    for (const c of view.pilots || []) this.drawTag(c, true);
  }

  drawSky() {
    const ctx = this.ctx, t = this.terrain;
    const sky = t ? t.map.sky : ['#2f6db5', '#9fd0f0'];
    const alt = clamp(this.cam.y / 2600, 0, 1);
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, shade(sky[0], -alt * 0.35));
    g.addColorStop(1, sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
    // солнце
    const sx = this.W * 0.78 - this.cam.x * 0.01 % 50, sy = this.sy(2200) * 0.15 + this.H * 0.12;
    const sg = ctx.createRadialGradient(sx, sy, 5, sx, sy, 120);
    sg.addColorStop(0, 'rgba(255,250,220,0.95)'); sg.addColorStop(0.2, 'rgba(255,240,200,0.5)'); sg.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, 120, 0, Math.PI * 2); ctx.fill();
  }

  drawParallax() {
    const ctx = this.ctx, t = this.terrain, m = t.map;
    const layers = [
      { f: 0.12, col: m.far, base: 0.62, amp: m.theme === 'mountains' ? 230 : 110, ph: this.farPh, sc: 0.0016 },
      { f: 0.35, col: m.mid, base: 0.75, amp: m.theme === 'mountains' ? 150 : 70, ph: this.midPh, sc: 0.004 },
    ];
    for (const L of layers) {
      const horizon = this.H * L.base + (this.cam.y - 300) * this.cam.z * L.f * 1.6;
      if (horizon > this.H + 300) continue;
      ctx.fillStyle = mix(L.col, m.sky[1], L === layers[0] ? 0.55 : 0.35);
      ctx.globalAlpha = L === layers[0] ? 0.6 : 0.8;
      ctx.beginPath();
      ctx.moveTo(0, this.H);
      for (let sx = 0; sx <= this.W + 20; sx += 20) {
        const wx = (sx - this.W / 2) / this.cam.z + this.cam.x * L.f;
        const sw = wx * L.sc;
        let hh = Math.sin(sw + L.ph[0]) * 0.5 + Math.sin(sw * 2.3 + L.ph[1]) * 0.3 + Math.sin(sw * 5.1 + L.ph[2]) * 0.2;
        if (m.theme === 'mountains' && L === layers[0]) hh = Math.abs(hh) * 1.6 - 0.3;
        ctx.lineTo(sx, horizon - hh * L.amp * Math.min(1.2, this.cam.z * 1.1));
      }
      ctx.lineTo(this.W, this.H);
      ctx.fill();
      // деревья на среднем плане полей
      if (L === layers[1] && m.theme !== 'sea') {
        ctx.fillStyle = shade(L.col, -0.15);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawCloud(c, alpha) {
    const ctx = this.ctx;
    const r = rng(c.seed);
    const x = this.sx(c.x), y = this.sy(c.y), z = this.cam.z;
    const n = 9;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const ox = (r() - 0.5) * c.w * 0.75, oy = (r() - 0.5) * c.h * 0.5;
      const rad = (c.h * 0.35 + r() * c.h * 0.35);
      ctx.fillStyle = i < 3 ? '#d9e2ea' : '#ffffff';
      ctx.beginPath(); ctx.arc(x + ox * z, y + oy * z - (i < 3 ? -rad * 0.2 * z : 0), rad * z, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawClouds(layer) {
    const t = this.terrain;
    for (const c of t.clouds) {
      if (!this.visible(c.x, c.y, c.w * this.cam.z)) continue;
      this.drawCloud(c, layer === 0 ? 0.5 : 0.82);
    }
    if (layer === 0) {
      // дальние декоративные облака
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 6; i++) {
        const x = ((i * 397 - this.cam.x * 0.05) % (this.W + 400) + this.W + 400) % (this.W + 400) - 200;
        const y = this.H * (0.12 + (i % 3) * 0.08) + (this.cam.y - 800) * this.cam.z * 0.05;
        ctx.beginPath(); ctx.ellipse(x, y, 90 + i * 12, 16 + i * 2, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawTerrain() {
    const ctx = this.ctx, t = this.terrain, m = t.map, z = this.cam.z;
    const x0 = this.wx(-10), x1 = this.wx(this.W + 10);
    const step = Math.max(4, 8 / z);
    // дно/земля
    ctx.beginPath();
    ctx.moveTo(-10, this.H + 10);
    for (let x = x0; x <= x1 + step; x += step) ctx.lineTo(this.sx(x), this.sy(t.raw(x)));
    ctx.lineTo(this.W + 10, this.H + 10);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, this.sy(m.theme === 'mountains' ? 1200 : 200), 0, this.sy(-300));
    g.addColorStop(0, m.dirt); g.addColorStop(1, shade(m.dirt, -0.45));
    ctx.fillStyle = g; ctx.fill();
    // травяной слой
    ctx.lineWidth = Math.max(3, 9 * z);
    ctx.strokeStyle = m.ground;
    ctx.beginPath();
    let pen = false;
    for (let x = x0; x <= x1 + step; x += step) {
      const h = t.raw(x);
      const snow = m.theme === 'mountains' && h > 900;
      if (h < -2 || snow) { pen = false; continue; }
      if (!pen) { ctx.moveTo(this.sx(x), this.sy(h)); pen = true; } else ctx.lineTo(this.sx(x), this.sy(h));
    }
    ctx.stroke();
    if (m.theme === 'mountains') {
      ctx.strokeStyle = '#f2f4f7';
      ctx.beginPath(); pen = false;
      for (let x = x0; x <= x1 + step; x += step) {
        const h = t.raw(x);
        if (h <= 900) { pen = false; continue; }
        if (!pen) { ctx.moveTo(this.sx(x), this.sy(h)); pen = true; } else ctx.lineTo(this.sx(x), this.sy(h));
      }
      ctx.stroke();
    }
    // деревья / кусты (детерминированно)
    if (m.theme !== 'sea' || true) {
      const sp = 70;
      const start = Math.floor(x0 / sp) * sp;
      for (let x = start; x < x1; x += sp) {
        const hv = hash(x + m.seed * 1000);
        if (hv > 0.45) continue;
        const h = t.raw(x);
        if (h < 5 || t.airfieldAt(x) || (m.theme === 'mountains' && h > 1000)) continue;
        let skip = false;
        for (const o of m.objects) if (Math.abs(o.x - x) < 60) { skip = true; break; }
        if (skip) continue;
        const tx = this.sx(x), ty = this.sy(h);
        const sz = (8 + hv * 18) * z;
        if (m.theme === 'sea') { // пальмы
          ctx.strokeStyle = '#6b5233'; ctx.lineWidth = 2 * z;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx + 4 * z, ty - sz * 1.2, tx + 2 * z, ty - sz * 2); ctx.stroke();
          ctx.fillStyle = '#3f7a3a';
          for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(tx + 2 * z + Math.cos(k * 1.6) * sz * 0.5, ty - sz * 2, sz * 0.6, sz * 0.18, k * 0.8, 0, Math.PI * 2); ctx.fill(); }
        } else {
          ctx.fillStyle = '#4a3a28'; ctx.fillRect(tx - 1.5 * z, ty - sz * 0.6, 3 * z, sz * 0.6);
          ctx.fillStyle = m.theme === 'mountains' ? '#2f5236' : '#3e6e30';
          ctx.beginPath();
          if (m.theme === 'mountains') { ctx.moveTo(tx - sz * 0.5, ty - sz * 0.4); ctx.lineTo(tx, ty - sz * 2); ctx.lineTo(tx + sz * 0.5, ty - sz * 0.4); }
          else ctx.arc(tx, ty - sz, sz * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  drawWater() {
    const ctx = this.ctx, t = this.terrain, z = this.cam.z;
    const y0 = this.sy(0);
    if (y0 > this.H + 20) return;
    const x0 = this.wx(-10), x1 = this.wx(this.W + 10);
    const step = Math.max(4, 8 / z);
    ctx.fillStyle = this.terrain.map.water;
    ctx.globalAlpha = 0.82;
    let inW = false, sx0 = 0;
    ctx.beginPath();
    for (let x = x0; x <= x1 + step; x += step) {
      const w = t.raw(x) < 0;
      if (w && !inW) { inW = true; sx0 = this.sx(x - step); ctx.moveTo(sx0, this.H + 10); ctx.lineTo(sx0, y0); }
      if (inW) ctx.lineTo(this.sx(x), y0 + Math.sin(x * 0.03 + this.time * 2) * 2 * z);
      if ((!w || x > x1) && inW) { inW = false; ctx.lineTo(this.sx(x), this.H + 10); ctx.closePath(); }
    }
    if (inW) { ctx.lineTo(this.W + 10, this.H + 10); ctx.closePath(); }
    ctx.fill();
    ctx.globalAlpha = 1;
    // блики
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
    for (let x = Math.floor(x0 / 90) * 90; x < x1; x += 90) {
      if (t.raw(x) >= 0) continue;
      const off = Math.sin(x * 0.7 + this.time) * 20;
      ctx.beginPath(); ctx.moveTo(this.sx(x + off), y0 + 6 * z); ctx.lineTo(this.sx(x + off + 25), y0 + 6 * z); ctx.stroke();
    }
  }

  drawRunways() {
    const ctx = this.ctx, t = this.terrain, z = this.cam.z;
    for (const a of t.map.airfields) {
      if (this.sx(a.x1) < -50 || this.sx(a.x0) > this.W + 50) continue;
      const y = this.sy(a.h);
      ctx.fillStyle = '#55575a';
      ctx.fillRect(this.sx(a.x0), y - 2 * z, (a.x1 - a.x0) * z, 7 * z);
      ctx.fillStyle = '#e8e8e0';
      for (let x = a.x0 + 30; x < a.x1 - 30; x += 70) ctx.fillRect(this.sx(x), y + 0.5 * z, 30 * z, 1.5 * z);
      const col = a.team === 0 ? '#4b8fe8' : '#e5533f';
      for (const fx of [a.x0, a.x1]) {
        ctx.strokeStyle = '#333'; ctx.lineWidth = 2 * z;
        ctx.beginPath(); ctx.moveTo(this.sx(fx), y); ctx.lineTo(this.sx(fx), y - 40 * z); ctx.stroke();
        ctx.fillStyle = this.teamTint ? this.teamTint(a.team) : col;
        const wave = Math.sin(this.time * 4 + fx) * 3 * z;
        ctx.beginPath(); ctx.moveTo(this.sx(fx), y - 40 * z); ctx.lineTo(this.sx(fx) + 22 * z, y - 35 * z + wave); ctx.lineTo(this.sx(fx), y - 28 * z); ctx.fill();
      }
      // ветроуказатель
      const wx = this.sx((a.x0 + a.x1) / 2);
      ctx.strokeStyle = '#444'; ctx.lineWidth = 1.5 * z;
      ctx.beginPath(); ctx.moveTo(wx, y - 2 * z); ctx.lineTo(wx, y - 26 * z); ctx.stroke();
      ctx.fillStyle = '#ff8a2a';
      ctx.beginPath(); ctx.moveTo(wx, y - 26 * z); ctx.lineTo(wx + 14 * z, y - 24 * z + Math.sin(this.time * 3) * z); ctx.lineTo(wx, y - 20 * z); ctx.fill();
    }
  }

  drawGround(o) {
    if (!this.visible(o.x, o.y, 150)) return;
    const ctx = this.ctx, z = this.cam.z;
    const x = this.sx(o.x), y = this.sy(o.y);
    const col = o.color || '#888';
    ctx.save();
    ctx.translate(x, y); ctx.scale(z, z);
    const dead = o.hp <= 0;
    switch (o.type) {
      case 'hq': {
        if (dead) { rubble(ctx, 90, 22); break; }
        ctx.fillStyle = '#6b6252'; ctx.fillRect(-45, -38, 90, 38);
        ctx.fillStyle = '#585042'; ctx.fillRect(-50, -42, 100, 6);
        ctx.fillStyle = '#2a2a2a'; for (let i = -35; i < 40; i += 18) ctx.fillRect(i, -28, 8, 8);
        ctx.fillStyle = '#3a3a3a'; ctx.fillRect(-8, -16, 16, 16);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(30, -42); ctx.lineTo(30, -80); ctx.stroke();
        ctx.fillStyle = col; ctx.fillRect(30, -80, 24, 14);
        // антенна
        ctx.beginPath(); ctx.moveTo(-30, -42); ctx.lineTo(-30, -70); ctx.stroke();
        break;
      }
      case 'hangar': {
        if (dead) { rubble(ctx, 70, 16); break; }
        ctx.fillStyle = '#7d7a6d';
        ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(-40, -22); ctx.quadraticCurveTo(0, -55, 40, -22); ctx.lineTo(40, 0); ctx.fill();
        ctx.strokeStyle = '#5d5a50'; ctx.lineWidth = 1.5;
        for (let i = -30; i <= 30; i += 10) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, -22 - (1 - (i / 40) ** 2) * 14); ctx.stroke(); }
        ctx.fillStyle = '#2e2c28'; ctx.fillRect(-16, -18, 32, 18);
        ctx.fillStyle = col; ctx.fillRect(-4, -40, 8, 5);
        break;
      }
      case 'building': {
        const r = hash(o.x * 13.7);
        const w = 44 + r * 30, h = 40 + hash(o.x * 3.1) * 60;
        if (dead) { rubble(ctx, w, 14); break; }
        const cols = ['#a89a84', '#9a7d6a', '#b7ae9a', '#8c8f94'];
        ctx.fillStyle = cols[Math.floor(r * 4)]; ctx.fillRect(-w / 2, -h, w, h);
        ctx.fillStyle = '#6e4a3a';
        ctx.beginPath(); ctx.moveTo(-w / 2 - 4, -h); ctx.lineTo(0, -h - 16); ctx.lineTo(w / 2 + 4, -h); ctx.fill();
        ctx.fillStyle = '#2d3640';
        for (let yy = -h + 8; yy < -12; yy += 16) for (let xx = -w / 2 + 6; xx < w / 2 - 8; xx += 13) ctx.fillRect(xx, yy, 7, 9);
        if (o.hp < o.maxHp * 0.5) { ctx.fillStyle = 'rgba(20,15,10,0.5)'; ctx.beginPath(); ctx.arc(w * 0.2, -h * 0.6, 10, 0, 7); ctx.fill(); }
        break;
      }
      case 'aa': {
        if (dead) { rubble(ctx, 30, 8); break; }
        ctx.fillStyle = '#5a5a4a';
        ctx.beginPath(); ctx.moveTo(-16, 0); ctx.lineTo(-10, -9); ctx.lineTo(10, -9); ctx.lineTo(16, 0); ctx.fill();
        ctx.save(); ctx.translate(0, -10); ctx.rotate(-(o.dir ?? Math.PI / 2));
        ctx.fillStyle = '#3c3c34'; ctx.fillRect(0, -2, 26, 4); ctx.fillRect(0, 2.5, 24, 3);
        ctx.restore();
        ctx.fillStyle = '#4a4a3c'; ctx.beginPath(); ctx.arc(0, -10, 5, 0, 7); ctx.fill();
        ctx.fillStyle = col; ctx.fillRect(-3, -3, 6, 3);
        break;
      }
      case 'artillery': {
        if (dead) { rubble(ctx, 30, 8); break; }
        ctx.save(); ctx.translate(0, -8); ctx.rotate(-(o.dir ?? 0.7));
        ctx.fillStyle = '#3a3d30'; ctx.fillRect(0, -2.5, 34, 5);
        ctx.restore();
        ctx.fillStyle = '#4c5040'; ctx.fillRect(-12, -12, 18, 9);
        ctx.strokeStyle = '#2a2a24'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(-6, -4, 5, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(-26, 0); ctx.stroke();
        ctx.fillStyle = col; ctx.fillRect(-8, -16, 6, 3);
        break;
      }
      case 'tank': {
        if (dead) { ctx.fillStyle = '#222'; ctx.fillRect(-18, -10, 36, 10); break; }
        const f = o.face || 1;
        ctx.scale(f, 1);
        ctx.fillStyle = '#2a2a24'; roundRect(ctx, -20, -8, 40, 8, 4); ctx.fill();
        ctx.fillStyle = '#555'; for (let i = -15; i <= 15; i += 7.5) { ctx.beginPath(); ctx.arc(i, -4, 3, 0, 7); ctx.fill(); }
        ctx.fillStyle = shade(col, -0.35); ctx.fillRect(-18, -15, 36, 8);
        ctx.fillStyle = shade(col, -0.2); roundRect(ctx, -9, -22, 18, 8, 3); ctx.fill();
        ctx.save(); ctx.translate(6, -18); ctx.rotate(-(o.dir ?? 0.05));
        ctx.fillStyle = '#333'; ctx.fillRect(0, -1.5, 22, 3);
        ctx.restore();
        break;
      }
    }
    ctx.restore();
    if (!dead && o.hp < o.maxHp && o.type !== 'building') {
      const w = 40 * z;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x - w / 2, y + 4 * z, w, 3);
      ctx.fillStyle = o.hp / o.maxHp > 0.5 ? '#6c6' : '#e63'; ctx.fillRect(x - w / 2, y + 4 * z, w * o.hp / o.maxHp, 3);
    }
    if (dead && Math.random() < 0.08) this.smoke(o.x + (Math.random() - 0.5) * 30, o.y + 5, 0.8, 8);
  }

  drawProjectile(p) {
    if (!this.visible(p.x, p.y, 50)) return;
    const ctx = this.ctx, z = this.cam.z;
    const x = this.sx(p.x), y = this.sy(p.y);
    const a = Math.atan2(p.vy, p.vx);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-a); ctx.scale(z, z);
    if (p.type === 'bomb') {
      ctx.fillStyle = '#3a3a30';
      ctx.beginPath(); ctx.ellipse(0, 0, 7, 2.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-10, -3, 3, 6);
    } else if (p.type === 'rocket') {
      ctx.fillStyle = '#ddd'; ctx.fillRect(-6, -1.2, 12, 2.4);
      ctx.fillStyle = '#c33'; ctx.fillRect(4, -1.2, 3, 2.4);
      if (Math.random() < 0.8) this.smoke(p.x - Math.cos(a) * 8, p.y - Math.sin(a) * 8, 0.1, 3);
      ctx.fillStyle = 'rgba(255,180,60,0.9)'; ctx.beginPath(); ctx.moveTo(-6, -1.5); ctx.lineTo(-14 - Math.random() * 5, 0); ctx.lineTo(-6, 1.5); ctx.fill();
    } else {
      ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  drawTracers() {
    const ctx = this.ctx, z = this.cam.z;
    ctx.lineCap = 'round';
    for (const b of this.tracers) {
      if (!this.visible(b.x, b.y, 40)) continue;
      const x = this.sx(b.x), y = this.sy(b.y);
      ctx.strokeStyle = `rgba(${b.color},0.95)`;
      ctx.lineWidth = (b.heavy ? 3 : 2) * Math.max(0.7, z);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - b.vx * 0.032 * z, y + b.vy * 0.032 * z); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  drawParticles() {
    const ctx = this.ctx, z = this.cam.z;
    for (const p of this.particles) {
      if (!this.visible(p.x, p.y, 60)) continue;
      const k = p.life / p.max;
      ctx.fillStyle = `rgba(${p.color},${(p.a * (p.kind === 'smoke' ? k : Math.min(1, k * 2))).toFixed(3)})`;
      const s = p.size * z;
      if (p.kind === 'debris' || p.kind === 'spark') ctx.fillRect(this.sx(p.x) - s / 2, this.sy(p.y) - s / 2, s, s);
      else { ctx.beginPath(); ctx.arc(this.sx(p.x), this.sy(p.y), s, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  drawZone(zone, front) {
    if (!zone) return;
    const ctx = this.ctx;
    const l = this.sx(zone[0]), r = this.sx(zone[1]);
    ctx.fillStyle = front ? 'rgba(200,40,40,0.18)' : 'rgba(120,0,0,0.12)';
    if (l > 0) ctx.fillRect(0, 0, l, this.H);
    if (r < this.W) ctx.fillRect(r, 0, this.W - r, this.H);
    if (front) {
      ctx.strokeStyle = 'rgba(255,60,60,0.8)'; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
      ctx.beginPath(); ctx.moveTo(l, 0); ctx.lineTo(l, this.H); ctx.moveTo(r, 0); ctx.lineTo(r, this.H); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ---------- самолёт ----------
  drawPlane(p) {
    if (p.hidden || !this.visible(p.x, p.y, 120)) return;
    const ctx = this.ctx, z = this.cam.z;
    const def = p.def;
    ctx.save();
    ctx.translate(this.sx(p.x), this.sy(p.y));
    ctx.rotate(-p.a);
    const s = def.size * z * 1.25;
    let roll = p.roll;
    if (Math.abs(roll) < 0.12) roll = roll < 0 ? -0.12 : 0.12;
    ctx.scale(s, s * roll);
    drawPlaneShape(ctx, def, p.parts || { engine: 1, wing: 1, tail: 1, fuel: 1 }, this.time + (p.id || 0), p.thr ?? 1, p.dead, p.bombs, p.rockets);
    ctx.restore();
  }

  drawTag(o, pilot = false) {
    if (o.hidden || !o.name || o.isMe || !this.visible(o.x, o.y, 80)) return;
    const ctx = this.ctx;
    const x = this.sx(o.x), y = this.sy(o.y) - (pilot ? 26 : 30 * (o.def ? o.def.size : 1)) * this.cam.z;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(o.name, x + 1, y + 1);
    ctx.fillStyle = o.color || '#fff';
    ctx.fillText(o.name, x, y);
    if (!pilot && o.hpFrac !== undefined && !o.dead) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x - 18, y + 4, 36, 3);
      ctx.fillStyle = o.hpFrac > 0.5 ? '#7d7' : o.hpFrac > 0.25 ? '#ec4' : '#e44';
      ctx.fillRect(x - 18, y + 4, 36 * o.hpFrac, 3);
    }
  }

  drawPilot(c) {
    if (!this.visible(c.x, c.y, 80)) return;
    const ctx = this.ctx, z = this.cam.z;
    const x = this.sx(c.x), y = this.sy(c.y);
    ctx.save(); ctx.translate(x, y); ctx.scale(z, z);
    const col = c.color || '#fff';
    if (c.chute) {
      ctx.strokeStyle = 'rgba(60,60,60,0.8)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-16, -34); ctx.moveTo(0, -8); ctx.lineTo(16, -34); ctx.moveTo(0, -8); ctx.lineTo(0, -40); ctx.stroke();
      ctx.fillStyle = '#e9e4d6';
      ctx.beginPath(); ctx.moveTo(-20, -32); ctx.quadraticCurveTo(0, -60, 20, -32); ctx.quadraticCurveTo(0, -38, -20, -32); ctx.fill();
      ctx.fillStyle = col; ctx.fillRect(-2, -50, 4, 6);
    }
    const moving = Math.abs(c.vx) > 5 && c.ground;
    const ph = moving ? Math.sin(this.time * 14 + c.x * 0.1) * 5 : 0;
    ctx.strokeStyle = '#3b3a2c'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    if (c.swim) {
      ctx.fillStyle = '#d9b48c'; ctx.beginPath(); ctx.arc(0, -2, 3.2, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb14a'; ctx.fillRect(-5, 0, 10, 3);
    } else {
      ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(ph, 6 - 6); ctx.moveTo(0, -4); ctx.lineTo(-ph, 0); ctx.stroke();
      ctx.strokeStyle = '#55543c'; ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, -12); ctx.stroke();
      ctx.fillStyle = '#d9b48c'; ctx.beginPath(); ctx.arc(0, -15, 3, 0, 7); ctx.fill();
      ctx.fillStyle = '#4a3b2a'; ctx.beginPath(); ctx.arc(0, -16, 3.2, Math.PI, 0); ctx.fill();
      // оружие
      ctx.save(); ctx.translate(0, -10); ctx.rotate(-c.aim);
      ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9, 0); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = col; ctx.fillRect(-2.5, -9, 5, 2);
    }
    ctx.restore();
  }
}

// ---------- процедурные спрайты самолётов ----------
export function drawPlaneShape(ctx, def, parts, time, thr, dead, bombsLeft, rocketsLeft) {
  const nat = NATIONS[def.nation] || NATIONS.us;
  const body = nat.color, belly = shade(nat.color, 0.25), dark = shade(nat.color, -0.3);
  const shape = def.shape;
  const L = shape === 'bomber' ? 1.25 : 1;           // относительная длина
  ctx.lineJoin = 'round';
  // вертикальное оперение (повреждаемое)
  const tailH = 1 - (1 - parts.tail) * 0.6;
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-11 * L, -2.5);
  ctx.lineTo(-17 * L, -2.5 - 9 * tailH * (shape === 'bomber' ? 1.1 : 1));
  ctx.lineTo(-19.5 * L, -2.5 - 8.5 * tailH);
  ctx.lineTo(-18.5 * L, -0.5);
  ctx.closePath(); ctx.fill();
  if (parts.tail < 0.5) jagged(ctx, -18 * L, -2.5 - 8.5 * tailH, 3);

  // фюзеляж
  const g = ctx.createLinearGradient(0, -6, 0, 6);
  g.addColorStop(0, shade(body, 0.12)); g.addColorStop(0.55, body); g.addColorStop(1, belly);
  ctx.fillStyle = g;
  ctx.beginPath();
  if (shape === 'bomber') {
    ctx.moveTo(19, 0.5);
    ctx.quadraticCurveTo(18, -5, 10, -5.5);
    ctx.lineTo(-14 * L, -3.6); ctx.lineTo(-21 * L, -1.8); ctx.lineTo(-21 * L, 1.5); ctx.lineTo(-12 * L, 3.2);
    ctx.quadraticCurveTo(10, 6.2, 19, 2.5);
  } else if (shape === 'attacker') {
    ctx.moveTo(17.5, 0);
    ctx.quadraticCurveTo(16, -6, 7, -6.5);
    ctx.lineTo(-10, -4); ctx.lineTo(-17.5, -2.4); ctx.lineTo(-17.5, 1.4); ctx.lineTo(-10, 3);
    ctx.quadraticCurveTo(8, 6.5, 16, 4.5);
  } else {
    ctx.moveTo(17, 0);
    ctx.quadraticCurveTo(15, -5, 8, -5.2);
    ctx.lineTo(-10, -3.4); ctx.lineTo(-17, -1.8); ctx.lineTo(-17, 1.2); ctx.lineTo(-10, 2.6);
    ctx.quadraticCurveTo(8, 5, 15, 4);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5; ctx.stroke();
  // панельные линии
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.moveTo(10, -5); ctx.lineTo(10, 4.5); ctx.moveTo(-4, -4.4); ctx.lineTo(-4, 3.6); ctx.stroke();

  // кабина / остекление
  ctx.fillStyle = 'rgba(160,210,235,0.9)';
  ctx.strokeStyle = 'rgba(30,40,50,0.7)'; ctx.lineWidth = 0.6;
  if (shape === 'bomber') {
    ctx.beginPath(); ctx.moveTo(19, 0.5); ctx.quadraticCurveTo(18.5, -4.5, 13, -5.4); ctx.lineTo(13, 1.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(6, -5.6, 4.2, 2.3, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    // верхняя турель
    ctx.beginPath(); ctx.ellipse(-2, -4.9, 2.6, 2.4, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    // хвостовая турель
    ctx.beginPath(); ctx.ellipse(-21 * L, -0.2, 2, 1.7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.ellipse(shape === 'attacker' ? 2 : 1.5, -5.2, 5, 2.6, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    if (shape === 'attacker' && def.gunners && def.gunners.length) {
      ctx.beginPath(); ctx.ellipse(-4.5, -4.6, 3, 2, 0, Math.PI, 0); ctx.fill(); ctx.stroke();
    }
  }

  // опознавательный знак
  drawInsignia(ctx, nat.insignia, shape === 'bomber' ? -8 * L : -5, 0.2, shape === 'bomber' ? 2.6 : 2.4);

  // крыло (вид сбоку) и повреждения
  const wingLen = (shape === 'bomber' ? 12 : 9) * (0.55 + 0.45 * Math.max(0, parts.wing));
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.ellipse(shape === 'bomber' ? 4 : 2, 1.6, wingLen, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  if (parts.wing < 0.7) {
    ctx.fillStyle = 'rgba(20,15,10,0.85)';
    ctx.beginPath(); ctx.arc(3, 1.4, 0.9, 0, 7); ctx.arc(-1, 1.9, 0.7, 0, 7); ctx.fill();
    if (parts.wing < 0.4) jagged(ctx, (shape === 'bomber' ? 4 : 2) + wingLen, 1.6, 2);
  }
  // горизонтальный стабилизатор
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.ellipse(-15 * L, -0.4, 4.5 * tailH, 1, 0, 0, Math.PI * 2); ctx.fill();

  // мотогондола бомбардировщика
  if (shape === 'bomber') {
    ctx.fillStyle = shade(body, -0.1);
    ctx.beginPath(); ctx.moveTo(13, 0.3); ctx.lineTo(13, 4.3); ctx.lineTo(-1, 3.6); ctx.lineTo(-1, 1); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(12.5, 0.6, 1.4, 3.4);
    propeller(ctx, 14.2, 2.3, 5.5, time, thr, dead || parts.engine <= 0.02);
  } else {
    ctx.fillStyle = '#2a2a2a'; ctx.beginPath(); ctx.ellipse(17, 0.2, 1.4, 2.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = nat.accent; ctx.beginPath(); ctx.ellipse(17.6, 0.2, 1.2, 1.7, 0, -Math.PI / 2, Math.PI / 2); ctx.fill();
    propeller(ctx, 18.2, 0.2, 7, time, thr, dead || parts.engine <= 0.02);
  }
  // подвесное вооружение
  if (rocketsLeft > 0) {
    ctx.fillStyle = '#ccc';
    for (let i = 0; i < Math.min(2, rocketsLeft); i++) ctx.fillRect(-1 + i * 5, 3.3, 5, 1.1);
  }
  if (bombsLeft > 0 && shape !== 'bomber') {
    ctx.fillStyle = '#35352c'; ctx.beginPath(); ctx.ellipse(1, 5.3, 4, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  }
  // подпалины на повреждённых частях
  if (parts.engine < 0.5) { ctx.fillStyle = 'rgba(15,10,5,0.5)'; ctx.beginPath(); ctx.ellipse(shape === 'bomber' ? 8 : 12, 0, 4, 3, 0, 0, 7); ctx.fill(); }
  if (parts.fuel < 0.5) { ctx.fillStyle = 'rgba(15,10,5,0.45)'; ctx.beginPath(); ctx.ellipse(0, 0.5, 4, 2.5, 0, 0, 7); ctx.fill(); }
  if (dead) { ctx.globalAlpha = 0.45; ctx.fillStyle = '#100c08'; ctx.fillRect(-22 * L, -12, 44 * L, 18); ctx.globalAlpha = 1; }
}

function propeller(ctx, x, y, r, time, thr, stopped) {
  if (stopped) {
    ctx.fillStyle = '#2b2b2b'; ctx.fillRect(x - 0.5, y - r, 1, r * 2);
    return;
  }
  ctx.fillStyle = `rgba(40,40,40,${0.18 + 0.15 * (1 - thr)})`;
  ctx.beginPath(); ctx.ellipse(x, y, 1.2, r, 0, 0, Math.PI * 2); ctx.fill();
  const ph = (time * (20 + thr * 40)) % (Math.PI * 2);
  ctx.fillStyle = 'rgba(30,30,30,0.6)';
  const b = Math.sin(ph) * r;
  ctx.fillRect(x - 0.4, y + Math.min(0, b), 0.8, Math.abs(b));
}

function drawInsignia(ctx, kind, x, y, r) {
  ctx.save(); ctx.translate(x, y);
  switch (kind) {
    case 'us':
      circle(ctx, 0, 0, r, '#1f3a7a');
      star(ctx, 0, 0, r * 0.85, '#fff');
      ctx.fillStyle = '#fff'; ctx.fillRect(r * 0.7, -r * 0.3, r * 0.9, r * 0.6); ctx.fillRect(-r * 1.6, -r * 0.3, r * 0.9, r * 0.6);
      break;
    case 'su':
      star(ctx, 0, 0, r * 1.1, '#fff'); star(ctx, 0, 0, r * 0.9, '#c42a22');
      break;
    case 'uk':
      circle(ctx, 0, 0, r, '#e8dcb0'); circle(ctx, 0, 0, r * 0.8, '#2a3f78'); circle(ctx, 0, 0, r * 0.55, '#fff'); circle(ctx, 0, 0, r * 0.3, '#b8282a');
      break;
    case 'de':
      ctx.fillStyle = '#fff'; ctx.fillRect(-r, -r * 0.35, r * 2, r * 0.7); ctx.fillRect(-r * 0.35, -r, r * 0.7, r * 2);
      ctx.fillStyle = '#111'; ctx.fillRect(-r * 0.8, -r * 0.2, r * 1.6, r * 0.4); ctx.fillRect(-r * 0.2, -r * 0.8, r * 0.4, r * 1.6);
      break;
    case 'jp':
      circle(ctx, 0, 0, r * 1.05, '#fff'); circle(ctx, 0, 0, r * 0.9, '#c0302a');
      break;
  }
  ctx.restore();
}

function circle(ctx, x, y, r, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
function star(ctx, x, y, r, c) {
  ctx.fillStyle = c; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.42 : r, a = -Math.PI / 2 + i * Math.PI / 5;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill();
}
function jagged(ctx, x, y, r) {
  ctx.fillStyle = 'rgba(25,20,15,0.9)';
  ctx.beginPath();
  for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, rr = i % 2 ? r * 0.5 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath(); ctx.fill();
}
function rubble(ctx, w, h) {
  ctx.fillStyle = '#4a4239';
  ctx.beginPath(); ctx.moveTo(-w / 2, 0);
  for (let i = 0; i <= 8; i++) ctx.lineTo(-w / 2 + w * i / 8, -h * (0.3 + hash(i * 7 + w) * 0.7));
  ctx.lineTo(w / 2, 0); ctx.fill();
  ctx.fillStyle = '#2a2622'; ctx.fillRect(-w * 0.2, -h * 0.9, 4, h * 0.9);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
export function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
export function shade(hex, amt) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export function mix(a, b, t) {
  const p = h => { let c = h.replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; };
  const A = p(a), B = p(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
}
