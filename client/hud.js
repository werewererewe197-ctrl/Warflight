// Боевой интерфейс: приборы, части самолёта, боезапас, мини-карта, лента убийств, счёт.
import { SPEED_TO_KMH, PART_NAMES, clamp } from '../shared/constants.js';

export function drawHud(r, info) {
  const ctx = r.ctx, W = r.W, H = r.H;
  ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
  ctx.textBaseline = 'alphabetic';
  const me = info.me;
  const mobile = info.mobile;

  // индикатор упреждения
  if (info.lead) {
    const { x, y, x2, y2 } = info.lead;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = info.lead.good ? '#ffec5c' : 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 14); ctx.stroke();
  }
  // прицел-стрелка носа
  if (info.aim) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(info.aim.x, info.aim.y, 4, 0, Math.PI * 2); ctx.stroke();
  }
  // стрелки на врагов за экраном
  for (const a of info.arrows || []) {
    ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.ang);
    ctx.fillStyle = a.color; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  // ---------- панель состояния ----------
  if (me && me.kind === 'plane') {
    const px = 12, py = mobile ? 12 : H - 150;
    panel(ctx, px, py, 236, 138);
    ctx.fillStyle = '#fff'; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(Math.round(me.speed * SPEED_TO_KMH) + ' км/ч', px + 10, py + 28);
    ctx.font = '600 14px system-ui, sans-serif'; ctx.fillStyle = '#cfe0f0';
    ctx.fillText('Высота ' + Math.max(0, Math.round(me.alt)) + ' м', px + 130, py + 26);
    bar(ctx, px + 10, py + 40, 140, 9, me.thr, me.boosting ? '#7bc4ff' : '#9fe07a', 'Газ ' + Math.round(me.thr * 100) + '%' + (me.boosting ? ' ФОРСАЖ' : ''));
    bar(ctx, px + 10, py + 64, 140, 9, me.heat, me.overheat ? '#ff4a3a' : '#ffb04a', me.overheat ? 'ПЕРЕГРЕВ!' : 'Нагрев двигателя');
    bar(ctx, px + 10, py + 88, 140, 9, me.gunHeat, me.gunOverheat ? '#ff4a3a' : '#ffd84a', me.gunOverheat ? 'Стволы перегреты' : 'Нагрев оружия');
    bar(ctx, px + 10, py + 112, 140, 9, me.hpFrac, me.hpFrac > 0.5 ? '#6fd36f' : me.hpFrac > 0.25 ? '#e7c94a' : '#e5533f', 'Прочность ' + Math.round(me.hpFrac * 100) + '%');
    // схема частей
    partsDiagram(ctx, px + 165, py + 40, me.parts, me.fire);
  } else if (me && me.kind === 'pilot') {
    const px = 12, py = mobile ? 12 : H - 90;
    panel(ctx, px, py, 236, 78);
    ctx.fillStyle = '#fff'; ctx.font = '700 16px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Пилот на земле', px + 10, py + 22);
    bar(ctx, px + 10, py + 36, 150, 9, me.hpFrac, '#6fd36f', 'Здоровье');
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#cfe0f0';
    ctx.fillText(me.hint || '', px + 10, py + 68);
  }

  // ---------- оружие ----------
  if (me && me.kind === 'plane' && me.weapons) {
    const w = 190, x = W - w - 12, y = mobile ? 12 + 90 : H - 26 - me.weapons.length * 20;
    if (!mobile || true) {
      const hh = me.weapons.length * 20 + 12;
      panel(ctx, x, y - 6, w, hh);
      ctx.font = '600 13px system-ui, sans-serif';
      me.weapons.forEach((wp, i) => {
        ctx.textAlign = 'left'; ctx.fillStyle = wp.n > 0 ? '#e8eef5' : '#ff7a6a';
        ctx.fillText(wp.label, x + 10, y + 12 + i * 20);
        ctx.textAlign = 'right';
        ctx.fillText(wp.max ? `${wp.n}/${wp.max}` : String(wp.n), x + w - 10, y + 12 + i * 20);
      });
    }
  }

  // ---------- мини-карта ----------
  if (info.minimap) drawMinimap(ctx, W, info.minimap, mobile);

  // ---------- счёт и таймер ----------
  ctx.textAlign = 'center';
  if (info.score) {
    ctx.font = '700 18px system-ui, sans-serif';
    const y = (mobile ? 58 : 86);
    let x = W / 2 - textWidth(ctx, info.score.map(s => s.text).join('   ')) / 2;
    ctx.textAlign = 'left';
    for (const s of info.score) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(s.text, x + 1, y + 1);
      ctx.fillStyle = s.color; ctx.fillText(s.text, x, y);
      x += textWidth(ctx, s.text + '   ');
    }
    ctx.textAlign = 'center';
  }
  if (info.timer !== undefined) {
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    const t = Math.max(0, Math.ceil(info.timer));
    ctx.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` + (info.modeLabel ? '  ·  ' + info.modeLabel : ''), W / 2, mobile ? 76 : 106);
  }

  // ---------- лента убийств ----------
  const kf = info.killfeed || [];
  ctx.font = '600 13px system-ui, sans-serif';
  kf.forEach((k, i) => {
    const y = (mobile ? 180 : 24) + i * 22;
    const txt = `${k.killer}  ${k.icon}  ${k.victim}`;
    const w = textWidth(ctx, txt) + 16;
    ctx.globalAlpha = clamp(k.ttl, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(W - w - 12, y - 15, w, 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = k.vc; ctx.fillText(k.victim, W - 20, y);
    const vw = textWidth(ctx, '  ' + k.victim);
    ctx.fillStyle = '#ddd'; ctx.fillText(k.icon, W - 20 - vw, y);
    const iw = textWidth(ctx, k.icon + '  ');
    ctx.fillStyle = k.kc; ctx.fillText(k.killer, W - 20 - vw - iw, y);
    ctx.globalAlpha = 1;
  });

  // ---------- предупреждения и сообщения ----------
  ctx.textAlign = 'center';
  let wy = H * 0.3;
  for (const w of info.warnings || []) {
    ctx.font = '800 22px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(w.text, W / 2 + 2, wy + 2);
    ctx.fillStyle = w.color || '#ff5a4a'; ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(r.time * 6));
    ctx.fillText(w.text, W / 2, wy); ctx.globalAlpha = 1;
    wy += 30;
  }
  if (info.center) {
    ctx.font = '700 26px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(info.center, W / 2 + 2, H * 0.42 + 2);
    ctx.fillStyle = '#fff'; ctx.fillText(info.center, W / 2, H * 0.42);
    if (info.center2) {
      ctx.font = '500 16px system-ui, sans-serif';
      ctx.fillText(info.center2, W / 2, H * 0.42 + 28);
    }
  }
  if (info.hitMarker > 0) {
    const cx = info.hitPos ? info.hitPos.x : W / 2, cy = info.hitPos ? info.hitPos.y : H / 2;
    ctx.strokeStyle = `rgba(255,255,255,${info.hitMarker})`; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.moveTo(cx + dx * 5, cy + dy * 5); ctx.lineTo(cx + dx * 11, cy + dy * 11); }
    ctx.stroke();
  }
  if (info.hint && !mobile) {
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.textAlign = 'center';
    ctx.fillText(info.hint, W / 2, H - 10);
  }
}

function drawMinimap(ctx, W, mm, mobile) {
  const w = Math.min(mobile ? 300 : 460, W - 40), h = mobile ? 40 : 56, x = (W - w) / 2, y = 10;
  const t = mm.terrain;
  const sx = v => x + (v / t.width) * w;
  const maxH = 2600;
  const sy = v => y + h - clamp(v / maxH, -0.05, 1) * (h - 4) - 4;
  ctx.fillStyle = 'rgba(10,20,35,0.55)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // рельеф
  ctx.fillStyle = 'rgba(120,140,90,0.85)';
  ctx.beginPath(); ctx.moveTo(x, y + h);
  for (let i = 0; i <= 120; i++) { const wx = t.width * i / 120; ctx.lineTo(sx(wx), sy(Math.max(0, t.raw(wx)))); }
  ctx.lineTo(x + w, y + h); ctx.fill();
  ctx.fillStyle = 'rgba(60,120,200,0.8)';
  for (let i = 0; i < 120; i++) { const wx = t.width * (i + 0.5) / 120; if (t.raw(wx) < 0) ctx.fillRect(sx(t.width * i / 120), sy(0), w / 120 + 1, 2); }
  // аэродромы
  for (const a of t.map.airfields) { ctx.fillStyle = mm.teamColor(a.team); ctx.fillRect(sx(a.x0), sy(a.h) - 1, Math.max(3, sx(a.x1) - sx(a.x0)), 3); }
  if (mm.zone) {
    ctx.fillStyle = 'rgba(255,40,40,0.35)';
    ctx.fillRect(x, y, sx(mm.zone[0]) - x, h); ctx.fillRect(sx(mm.zone[1]), y, x + w - sx(mm.zone[1]), h);
  }
  for (const p of mm.points) {
    ctx.fillStyle = p.color;
    const px = sx(p.x), py = sy(p.y);
    if (p.kind === 'base') { ctx.fillRect(px - 3, py - 6, 6, 6); continue; }
    if (p.kind === 'ground') { ctx.fillRect(px - 1.5, py - 3, 3, 3); continue; }
    if (p.kind === 'pilot') { ctx.fillRect(px - 1, py - 1, 2, 2); continue; }
    ctx.beginPath(); ctx.arc(px, py, p.me ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
    if (p.me) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  // область обзора
  if (mm.view) { ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.strokeRect(sx(mm.view[0]), y + 1, sx(mm.view[1]) - sx(mm.view[0]), h - 2); }
}

function partsDiagram(ctx, x, y, parts, fire) {
  const col = v => v > 0.66 ? '#6fd36f' : v > 0.33 ? '#e7c94a' : v > 0.02 ? '#e5533f' : '#555';
  ctx.save(); ctx.translate(x, y);
  // фюзеляж
  ctx.fillStyle = col(parts.fuel); ctx.fillRect(14, 22, 26, 12);
  ctx.fillStyle = col(parts.engine); ctx.fillRect(40, 22, 14, 12);
  ctx.fillStyle = col(parts.tail); ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(14, 22); ctx.lineTo(14, 34); ctx.closePath(); ctx.fill();
  ctx.fillRect(0, 10, 6, 20);
  ctx.fillStyle = col(parts.wing); ctx.fillRect(20, 36, 22, 5); ctx.fillRect(20, 15, 22, 5);
  if (fire) { ctx.fillStyle = '#ff7a1a'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'left'; ctx.fillText('ПОЖАР', 4, 58); }
  ctx.restore();
  ctx.font = '10px system-ui'; ctx.fillStyle = '#aab'; ctx.textAlign = 'left';
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,18,30,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
function bar(ctx, x, y, w, h, v, color, label) {
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * clamp(v, 0, 1), h);
  ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#e0e8f0'; ctx.textAlign = 'left';
  ctx.fillText(label, x, y + h + 11);
}
function textWidth(ctx, t) { return ctx.measureText(t).width; }
export { PART_NAMES };
