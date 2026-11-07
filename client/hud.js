// Боевой интерфейс: компактные панели со значками — приборы, части самолёта, боезапас,
// мини-карта, счёт, лента убийств, предупреждения.
import { SPEED_TO_KMH, clamp } from '../shared/constants.js';
import { drawIcon } from './icons.js';

const PANEL = 'rgba(10,18,30,0.62)';
const EDGE = 'rgba(255,255,255,0.10)';
const DIM = '#9fb2c8';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function drawHud(r, info) {
  const ctx = r.ctx;
  ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  ctx.textBaseline = 'middle';
  const mobile = info.mobile;

  // ---- элементы в экранных координатах ----
  if (info.lead) drawLead(ctx, info.lead);
  if (info.aim) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(info.aim.x, info.aim.y, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  for (const a of info.arrows || []) {
    ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.ang);
    ctx.fillStyle = a.color; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-5, -5.5); ctx.lineTo(-2, 0); ctx.lineTo(-5, 5.5); ctx.closePath(); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1;
  }
  if (info.hitMarker > 0) {
    const cx = info.hitPos ? info.hitPos.x : r.W / 2, cy = info.hitPos ? info.hitPos.y : r.H / 2;
    ctx.strokeStyle = `rgba(255,255,255,${info.hitMarker})`; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.moveTo(cx + dx * 5, cy + dy * 5); ctx.lineTo(cx + dx * 10, cy + dy * 10); }
    ctx.stroke();
  }

  // ---- панели: на маленьких экранах масштабируются ----
  const k = mobile || r.W < 900 ? clamp(r.W / 1100, 0.6, 1) : 1;
  ctx.setTransform(r.dpr * k, 0, 0, r.dpr * k, 0, 0);
  const W = r.W / k, H = r.H / k;
  const me = info.me;

  if (me && me.kind === 'plane') {
    const w = 262, h = 108, x = 12, y = mobile ? 12 : H - h - 12;
    drawCluster(ctx, x, y, w, h, me);
    const chips = me.weapons || [];
    if (mobile) drawChips(ctx, chips, x, y + h + 8, 'left', false);
    else drawChips(ctx, chips, W - 12, H - 12 - 38, 'right', true);
  } else if (me && me.kind === 'pilot') {
    const w = 262, h = 62, x = 12, y = mobile ? 12 : H - h - 12;
    panel(ctx, x, y, w, h);
    drawIcon(ctx, 'health', x + 20, y + 20, 16, '#8fe09a', 1.8);
    bar(ctx, x + 36, y + 20, 160, 6, me.hpFrac, hpColor(me.hpFrac));
    ctx.font = `600 12px ${FONT}`; ctx.fillStyle = '#e8eef5'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(me.hpFrac * 100) + '%', x + w - 12, y + 20);
    drawIcon(ctx, me.hintIcon || 'help', x + 20, y + 44, 15, '#e9c46a', 1.8);
    ctx.textAlign = 'left'; ctx.fillStyle = '#e8eef5'; ctx.font = `500 12px ${FONT}`;
    ctx.fillText(fit(ctx, me.hint || '', w - 48), x + 36, y + 44);
  }

  // ---- мини-карта и счёт ----
  let topY = 10;
  if (info.minimap) topY = drawMinimap(ctx, W, info.minimap, mobile) + 6;
  drawScore(ctx, W / 2, topY, info);

  // ---- лента убийств ----
  const kf = info.killfeed || [];
  let ky = mobile ? Math.max(64 / k, topY + 40) : 14;
  for (const e of kf) {
    ctx.globalAlpha = clamp(e.ttl, 0, 1);
    ctx.font = `600 12px ${FONT}`;
    const kw = e.killer ? ctx.measureText(e.killer).width : 0, vw = ctx.measureText(e.victim).width;
    const w = kw + vw + 40 + (e.killer ? 8 : 0), h = 22, x = W - 12 - w;
    panel(ctx, x, ky, w, h, 11);
    let cx = x + 10;
    ctx.textAlign = 'left';
    if (e.killer) { ctx.fillStyle = e.kc; ctx.fillText(e.killer, cx, ky + h / 2 + 0.5); cx += kw + 8; }
    drawIcon(ctx, e.icon, cx + 8, ky + h / 2, 14, '#e8eef5', 1.6); cx += 22;
    ctx.fillStyle = e.vc; ctx.fillText(e.victim, cx, ky + h / 2 + 0.5);
    ky += h + 4;
    ctx.globalAlpha = 1;
  }

  // ---- предупреждения ----
  let wy = H * 0.26;
  const blink = 0.75 + 0.25 * Math.sin(r.time * 7);
  for (const w of info.warnings || []) {
    ctx.font = `700 15px ${FONT}`;
    const tw = ctx.measureText(w.text).width, pw = tw + 46, ph = 30, px = W / 2 - pw / 2;
    const col = w.color || '#ff5a4a';
    ctx.globalAlpha = blink;
    panel(ctx, px, wy, pw, ph, 15, 'rgba(20,8,8,0.6)', col);
    drawIcon(ctx, w.icon || 'warning', px + 18, wy + ph / 2, 16, col, 2);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(w.text, px + 34, wy + ph / 2 + 0.5);
    ctx.globalAlpha = 1;
    wy += ph + 6;
  }

  // ---- сообщение по центру (гибель, выбывание) ----
  if (info.center) {
    const cy = H * 0.42;
    ctx.font = `800 26px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillText(info.center, W / 2 + 1.5, cy + 1.5);
    ctx.fillStyle = '#fff'; ctx.fillText(info.center, W / 2, cy);
    if (info.centerProgress !== undefined) {
      const R = 20, py = cy + 46;
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.arc(W / 2, py, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#e9c46a';
      ctx.beginPath(); ctx.arc(W / 2, py, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(info.centerProgress, 0, 1)); ctx.stroke();
      ctx.font = `700 14px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(info.center2 || '', W / 2, py + 1);
    } else if (info.center2) {
      ctx.font = `500 15px ${FONT}`; ctx.fillStyle = DIM; ctx.fillText(info.center2, W / 2, cy + 30);
    }
  }

  // ---- подсказка по клавишам (первые секунды) ----
  if (info.hint && !mobile) {
    ctx.font = `500 12px ${FONT}`;
    const tw = ctx.measureText(info.hint).width;
    panel(ctx, W / 2 - tw / 2 - 12, H - 34, tw + 24, 24, 12);
    ctx.fillStyle = '#cfdbe8'; ctx.textAlign = 'center'; ctx.fillText(info.hint, W / 2, H - 22 + 0.5);
  }
  ctx.textBaseline = 'alphabetic';
}

// ---------- приборная панель ----------
function drawCluster(ctx, x, y, w, h, me) {
  panel(ctx, x, y, w, h);
  ctx.textAlign = 'left';
  ctx.font = `800 26px ${FONT}`; ctx.fillStyle = '#fff';
  const sp = String(Math.round(me.speed * SPEED_TO_KMH));
  ctx.fillText(sp, x + 14, y + 24);
  const sw = ctx.measureText(sp).width;
  ctx.font = `600 11px ${FONT}`; ctx.fillStyle = DIM; ctx.fillText('км/ч', x + 18 + sw, y + 28);
  drawIcon(ctx, 'alt', x + 128, y + 24, 15, DIM, 1.7);
  ctx.font = `700 15px ${FONT}`; ctx.fillStyle = '#e8eef5';
  ctx.fillText(Math.max(0, Math.round(me.alt)) + ' м', x + 141, y + 24.5);
  if (me.boosting || me.overheat) drawIcon(ctx, 'boost', x + w - 22, y + 22, 18, me.overheat ? '#ff5a4a' : '#7bc4ff', 2);

  const rows = [
    ['throttle', me.thr, me.boosting ? '#7bc4ff' : '#9fe07a', Math.round(me.thr * 100) + '%'],
    ['temp', me.heat, me.overheat ? '#ff4a3a' : '#ffb04a', me.overheat ? '!' : Math.round(me.heat * 100) + '%'],
    ['gunheat', me.gunHeat, me.gunOverheat ? '#ff4a3a' : '#ffd84a', me.gunOverheat ? '!' : Math.round(me.gunHeat * 100) + '%'],
    ['health', me.hpFrac, hpColor(me.hpFrac), Math.round(me.hpFrac * 100) + '%'],
  ];
  rows.forEach(([icon, v, col, label], i) => {
    const ry = y + 50 + i * 15;
    drawIcon(ctx, icon, x + 20, ry, 12, label === '!' ? '#ff5a4a' : DIM, 1.6);
    bar(ctx, x + 32, ry, 118, 5, v, col);
    ctx.font = `600 10px ${FONT}`; ctx.fillStyle = label === '!' ? '#ff5a4a' : '#c9d6e3'; ctx.textAlign = 'right';
    ctx.fillText(label, x + 180, ry + 0.5);
    ctx.textAlign = 'left';
  });
  drawParts(ctx, x + 192, y + 46, me.parts, me.fire);
}

// Силуэт самолёта, раскрашенный по состоянию частей.
function drawParts(ctx, x, y, parts, fire) {
  const col = v => v > 0.66 ? '#6fd36f' : v > 0.33 ? '#e7c94a' : v > 0.02 ? '#e5533f' : '#4a4f55';
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = col(parts.tail);
  ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(4, 22); ctx.lineTo(16, 22); ctx.lineTo(16, 16); ctx.lineTo(8, 16); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(parts.fuel);
  ctx.beginPath(); ctx.moveTo(17, 15.5); ctx.lineTo(42, 14); ctx.lineTo(42, 26); ctx.lineTo(17, 23.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(parts.engine);
  ctx.beginPath(); ctx.moveTo(43, 14); ctx.quadraticCurveTo(58, 14, 60, 20); ctx.quadraticCurveTo(58, 26, 43, 26); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(parts.wing);
  ctx.beginPath(); ctx.ellipse(33, 28.5, 15, 3.2, 0, 0, Math.PI * 2); ctx.fill();
  if (fire) drawIcon(ctx, 'boost', 30, 6, 14, '#ff8a2a', 2);
  ctx.restore();
}

function drawChips(ctx, chips, x, y, align, keys) {
  const h = 38;
  ctx.font = `700 15px ${FONT}`;
  const widths = chips.map(c => Math.max(64, 44 + ctx.measureText(String(c.n)).width + (keys && c.key ? 12 : 0)));
  let cx = align === 'right' ? x - widths.reduce((a, b) => a + b + 6, -6) : x;
  chips.forEach((c, i) => {
    const w = widths[i];
    const empty = c.n <= 0;
    ctx.globalAlpha = empty ? 0.45 : 1;
    panel(ctx, cx, y, w, h, 10, PANEL, c.warn ? '#ff5a4a' : EDGE);
    drawIcon(ctx, c.icon, cx + 18, y + h / 2, 18, c.warn ? '#ff5a4a' : '#e9c46a', 1.8);
    ctx.font = `700 15px ${FONT}`; ctx.fillStyle = empty ? '#ff7a6a' : '#fff'; ctx.textAlign = 'left';
    ctx.fillText(String(c.n), cx + 32, y + h / 2 + (c.sub ? -4 : 0.5));
    if (c.sub) { ctx.font = `600 9px ${FONT}`; ctx.fillStyle = DIM; ctx.fillText(c.sub, cx + 32, y + h / 2 + 10); }
    if (keys && c.key) {
      ctx.font = `700 9px ${FONT}`; ctx.fillStyle = DIM; ctx.textAlign = 'right';
      ctx.fillText(c.key, cx + w - 6, y + 9);
    }
    ctx.globalAlpha = 1;
    cx += w + 6;
  });
}

// ---------- мини-карта ----------
function drawMinimap(ctx, W, mm, mobile) {
  const w = Math.min(mobile ? 320 : 440, W - 40), h = mobile ? 40 : 50, x = (W - w) / 2, y = 10;
  const t = mm.terrain;
  const sx = v => x + (v / t.width) * w;
  const sy = v => y + h - clamp(v / 2600, -0.05, 1) * (h - 6) - 4;
  ctx.save();
  roundRect(ctx, x, y, w, h, 9); ctx.fillStyle = 'rgba(10,20,35,0.6)'; ctx.fill();
  ctx.clip();
  ctx.fillStyle = 'rgba(110,135,90,0.9)';
  ctx.beginPath(); ctx.moveTo(x, y + h);
  for (let i = 0; i <= 120; i++) { const wx = t.width * i / 120; ctx.lineTo(sx(wx), sy(Math.max(0, t.raw(wx)))); }
  ctx.lineTo(x + w, y + h); ctx.fill();
  ctx.fillStyle = 'rgba(60,120,200,0.85)';
  for (let i = 0; i < 120; i++) { const wx = t.width * (i + 0.5) / 120; if (t.raw(wx) < 0) ctx.fillRect(sx(t.width * i / 120), sy(0), w / 120 + 1, 3); }
  for (const a of t.map.airfields) { ctx.fillStyle = mm.teamColor(a.team); ctx.fillRect(sx(a.x0), sy(a.h) - 1.5, Math.max(3, sx(a.x1) - sx(a.x0)), 3); }
  if (mm.zone) {
    ctx.fillStyle = 'rgba(255,40,40,0.35)';
    ctx.fillRect(x, y, sx(mm.zone[0]) - x, h); ctx.fillRect(sx(mm.zone[1]), y, x + w - sx(mm.zone[1]), h);
  }
  if (mm.view) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(sx(mm.view[0]), y, sx(mm.view[1]) - sx(mm.view[0]), h); }
  for (const p of mm.points) {
    ctx.fillStyle = p.color;
    const px = sx(p.x), py = sy(p.y);
    if (p.kind === 'base') { ctx.fillRect(px - 3, py - 6, 6, 6); continue; }
    if (p.kind === 'ground') { ctx.fillRect(px - 1.5, py - 3, 3, 3); continue; }
    if (p.kind === 'pilot') { ctx.fillRect(px - 1, py - 1, 2, 2); continue; }
    ctx.beginPath(); ctx.arc(px, py, p.me ? 3.5 : 2.4, 0, Math.PI * 2); ctx.fill();
    if (p.me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  ctx.restore();
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 9); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
  return y + h;
}

// ---------- счёт и таймер ----------
function drawScore(ctx, cx, y, info) {
  const s = info.score;
  const h = 28;
  let tw = 0;
  if (info.timer !== undefined) {
    const t = Math.max(0, Math.ceil(info.timer));
    const txt = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    ctx.font = `700 14px ${FONT}`;
    tw = ctx.measureText(txt).width + 40;
    panel(ctx, cx - tw / 2, y, tw, h, 14);
    drawIcon(ctx, 'clock', cx - tw / 2 + 15, y + h / 2, 13, t <= 30 ? '#ff7a6a' : DIM, 1.7);
    ctx.fillStyle = t <= 30 ? '#ff9a8a' : '#fff'; ctx.textAlign = 'left'; ctx.fillText(txt, cx - tw / 2 + 26, y + h / 2 + 0.5);
  }
  if (!s) return;
  const side = (txt, color, icon, left, barV) => {
    ctx.font = `800 15px ${FONT}`;
    const w = Math.max(56, ctx.measureText(txt).width + (icon ? 40 : 24) + (barV !== undefined ? 46 : 0));
    const x = left ? cx - tw / 2 - 6 - w : cx + tw / 2 + 6;
    panel(ctx, x, y, w, h, 14, PANEL, color);
    let ix = x + 12;
    if (icon) { drawIcon(ctx, icon, ix + 4, y + h / 2, 14, color, 1.8); ix += 16; }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(txt, ix + 2, y + h / 2 + 0.5);
    if (barV !== undefined) bar(ctx, x + w - 50, y + h / 2, 38, 5, barV, color);
  };
  if (s.kind === 'teams') {
    if (s.hq) {
      side(s.hq[0] + '%', s.colors[0], 'shield', true, s.hq[0] / 100);
      side(s.hq[1] + '%', s.colors[1], 'shield', false, s.hq[1] / 100);
    } else {
      side(String(s.vals[0]), s.colors[0], null, true);
      side(String(s.vals[1]), s.colors[1], null, false);
    }
  } else if (s.kind === 'ffa') {
    ctx.font = `800 15px ${FONT}`;
    side(`${fit(ctx, s.leader.name, 110)} ${s.leader.val}`, s.leader.color, 'crown', true);
    side(`${s.mine.val} · #${s.mine.place}`, '#ffe04a', 'user', false);
  } else if (s.kind === 'br') {
    side(String(s.alive), '#e8eef5', 'people', true);
    side(String(s.kills), '#ffe04a', 'fire', false);
  }
}

function drawLead(ctx, L) {
  const { x, y, x2, y2, good } = L;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
  const col = good ? '#ffec5c' : 'rgba(255,255,255,0.85)';
  ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * 11, y + dy * 11); ctx.lineTo(x + dx * 15, y + dy * 15); }
  ctx.stroke();
  if (good) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
}

// ---------- примитивы ----------
function hpColor(v) { return v > 0.5 ? '#6fd36f' : v > 0.25 ? '#e7c94a' : '#e5533f'; }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function panel(ctx, x, y, w, h, r = 12, fill = PANEL, edge = EDGE) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = edge; ctx.lineWidth = 1; ctx.stroke();
}
function bar(ctx, x, cy, w, h, v, color) {
  roundRect(ctx, x, cy - h / 2, w, h, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
  const fw = w * clamp(v, 0, 1);
  if (fw > 0.5) { roundRect(ctx, x, cy - h / 2, Math.max(h, fw), h, h / 2); ctx.fillStyle = color; ctx.fill(); }
}
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
