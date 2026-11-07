// DOM-интерфейс: меню, список лобби, настройки, комната, ангар, профиль, итоги.
import { MODES, NATIONS, CLASSES, TEAM_COLORS, TEAM_NAMES, DEFAULT_SETTINGS, BOT_DIFFICULTY, UPGRADE_TRACKS, UPGRADE_NAMES, UPGRADE_MAX,
  UPGRADE_EFFECTS, upgradeCost, levelFromXp, xpForLevel, SPEED_TO_KMH } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { drawPlaneShape } from './render.js';
import { esc } from './netgame.js';
import { svg } from './icons.js';

const $ = id => document.getElementById(id);
const UPG_ICON = { engine: 'engine', armor: 'shield', damage: 'fire', ammo: 'bullet', accuracy: 'target' };
// Заявленный эффект одного уровня улучшения (те же числа использует физика/сервер).
const pct = v => Math.round(v * 100) + '%';
export function upgradeEffectText(t) {
  const e = UPGRADE_EFFECTS[t];
  switch (t) {
    case 'engine': return `+${pct(e.thrust)} тяги`;
    case 'armor': return `+${pct(e.hp)} прочности, +${Math.round(e.armor * 100)} п.п. брони`;
    case 'damage': return `+${pct(e.dmg)} урона`;
    case 'ammo': return `+${pct(e.ammo)} патронов`;
    case 'accuracy': return `−${pct(e.spread)} разброса и отдачи`;
  }
  return '';
}

export function planePreview(canvas, def, parts) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 140, h = canvas.clientHeight || 50;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = Math.min(w / 55, h / 22) / Math.max(1, def.size * 0.85);
  ctx.translate(w / 2, h / 2 + 2);
  ctx.scale(s * def.size, s * def.size);
  drawPlaneShape(ctx, def, parts || { engine: 1, wing: 1, tail: 1, fuel: 1 }, 0, 0.6, false, def.bombs ? 1 : 0, def.rockets ? 2 : 0);
}

export function planeFirepower(def, data) {
  let dps = 0;
  for (const g of def.guns) { const w = data.weapons[g.w]; dps += w.dmg * g.count * w.rof; }
  return dps;
}

export class UI {
  constructor(app) {
    this.app = app;
    this.hangarNation = 'us';
    this.editMode = false;
  }

  // ---------- форма настроек лобби ----------
  fillCreateForm(s, edit) {
    this.editMode = edit;
    $('create-title').textContent = edit ? 'Настройки лобби' : 'Создать лобби';
    $('btn-create-ok').textContent = edit ? 'Сохранить' : 'Создать';
    $('s-map').innerHTML = Object.values(MAPS).map(m => `<option value="${m.id}">${esc(m.name)} (${(m.width / 1000).toFixed(0)} км)</option>`).join('');
    $('s-mode').innerHTML = Object.entries(MODES).map(([k, m]) => `<option value="${k}">${esc(m.name)}</option>`).join('');
    $('s-name').value = s.name; $('s-password').value = edit ? '' : (s.password || '');
    $('s-password').placeholder = edit && s.password ? 'оставьте пустым, чтобы не менять' : 'без пароля';
    $('s-map').value = s.map; $('s-mode').value = s.mode; $('s-max').value = s.maxPlayers; $('s-time').value = s.timeLimit;
    $('s-score').value = s.scoreLimit; $('s-respawn').value = s.respawnMode; $('s-rtime').value = s.respawnTime;
    $('s-bots').checked = s.bots; $('s-botcount').value = s.botCount; $('s-botdiff').value = s.botDifficulty;
    $('s-ff').checked = !!s.friendlyFire;
    $('s-nations').innerHTML = Object.entries(NATIONS).map(([k, n]) => `<label><input type="checkbox" value="${k}" ${s.nations.includes(k) ? 'checked' : ''}> ${esc(n.name)}</label>`).join('');
    $('s-classes').innerHTML = Object.entries(CLASSES).map(([k, n]) => `<label><input type="checkbox" value="${k}" ${s.classes.includes(k) ? 'checked' : ''}> ${esc(n.name)}</label>`).join('');
  }

  readCreateForm() {
    const s = {
      name: $('s-name').value.trim() || DEFAULT_SETTINGS.name, map: $('s-map').value, mode: $('s-mode').value,
      maxPlayers: +$('s-max').value, timeLimit: +$('s-time').value, scoreLimit: +$('s-score').value,
      respawnMode: $('s-respawn').value, respawnTime: +$('s-rtime').value, bots: $('s-bots').checked,
      botCount: +$('s-botcount').value, botDifficulty: +$('s-botdiff').value, friendlyFire: $('s-ff').checked,
      nations: [...$('s-nations').querySelectorAll('input:checked')].map(i => i.value),
      classes: [...$('s-classes').querySelectorAll('input:checked')].map(i => i.value),
    };
    const pw = $('s-password').value;
    if (!this.editMode || pw) s.password = pw;
    return s;
  }

  // ---------- список лобби ----------
  renderRooms(list) {
    const tb = $('room-list');
    if (!list.length) { tb.innerHTML = `<tr><td colspan="7" class="muted">Открытых лобби нет — создайте своё или нажмите «Быстрая игра».</td></tr>`; return; }
    tb.innerHTML = list.map(r => `<tr class="clickable" data-code="${r.code}" data-locked="${r.locked ? 1 : 0}">
      <td>${r.locked ? svg('lock') : ''}</td><td>${esc(r.name)}</td><td>${MODES[r.mode].short}</td><td>${esc(MAPS[r.map].name)}</td>
      <td>${svg('people')} ${r.players}/${r.max}${r.bots ? ` <span class="muted">${svg('robot')} ${r.bots}</span>` : ''}</td>
      <td>${r.state === 'playing' ? `<span title="идёт бой">${svg('fire')}</span>` : `<span title="в лобби">${svg('clock')}</span>`}</td>
      <td><button class="btn small">${svg('play')}Войти</button></td></tr>`).join('');
    tb.querySelectorAll('tr[data-code]').forEach(tr => tr.onclick = () => this.app.joinRoom(tr.dataset.code, tr.dataset.locked === '1'));
  }

  // ---------- комната ----------
  renderLobby(room) {
    const app = this.app, s = room.settings, me = room.players.find(p => p.id === app.myId);
    const isHost = room.hostId === app.myId;
    $('lobby-name').textContent = s.name;
    $('lobby-code').textContent = room.code;
    const chip = (ic, text, title, cls = '') => `<span class="chip ${cls}" title="${esc(title)}">${svg(ic)}${text}</span>`;
    $('lobby-info').innerHTML = `<div class="lobby-desc">${esc(MODES[s.mode].desc)}</div><div class="chips">
      ${chip('target', esc(MODES[s.mode].name), 'Режим', 'mode')}
      ${chip('map', esc(MAPS[s.map].name), 'Карта')}
      ${chip('people', `${room.players.length}/${s.maxPlayers}`, 'Игроки')}
      ${chip('clock', `${s.timeLimit} мин`, 'Лимит времени')}
      ${chip('star', s.scoreLimit, 'Лимит очков')}
      ${chip('robot', s.bots ? `${s.botCount} · ${BOT_DIFFICULTY[s.botDifficulty]}` : 'нет', 'Боты')}
      ${chip(s.respawnMode === 'timer' ? 'refresh' : 'takeoff', s.respawnMode === 'timer' ? `${s.respawnTime} с` : 'аэродром', 'Возрождение')}
      ${s.friendlyFire ? chip('warning', 'огонь по своим', 'Огонь по своим включён') : ''}
      ${room.hasPassword ? chip('lock', 'пароль', 'Лобби с паролем') : ''}
      ${room.state === 'playing' ? chip('fire', 'идёт бой', 'Матч уже идёт', 'mode') : ''}
      ${chip('plane', s.nations.map(n => NATIONS[n].name).join(', '), 'Разрешённые нации')}
      ${chip('hangar', s.classes.map(c => CLASSES[c].name).join(', '), 'Разрешённые классы')}
    </div>`;
    const teams = MODES[s.mode].teams;
    const row = p => {
      const def = app.data.planes.find(d => d.id === p.planeId);
      const kick = isHost && p.id !== app.myId ? `<button class="btn small danger" data-kick="${p.id}" title="Исключить">${svg('close')}</button>` : '';
      const host = p.id === room.hostId;
      return `<div class="pl">${host ? `<span class="crown" title="Хост">${svg('crown')}</span>` : ''}<span class="nm">${esc(p.name)}<span class="lvl">${p.level}</span>${p.away ? ' <span class="away">нет связи</span>' : ''}</span>
        <span class="plane">${def ? esc(def.name) : ''}</span><span class="rdy ${p.ready || host ? 'ok' : ''}" title="${host ? 'хост' : p.ready ? 'готов' : 'не готов'}">${svg(p.ready || host ? 'check' : 'clock')}</span>${kick}</div>`;
    };
    if (teams) {
      $('lobby-teams').innerHTML = [0, 1].map(t => `<div class="team-box"><h4 style="color:${TEAM_COLORS[t]}">${TEAM_NAMES[t]}</h4>
        ${room.players.filter(p => p.team === t).map(row).join('') || '<div class="muted">—</div>'}</div>`).join('');
    } else {
      $('lobby-teams').innerHTML = `<div class="team-box"><h4>Все против всех</h4>${room.players.map(row).join('')}</div>`;
    }
    $('lobby-teams').querySelectorAll('[data-kick]').forEach(b => b.onclick = () => app.net.send({ t: 'kick', id: b.dataset.kick }));
    $('btn-team').style.display = teams ? '' : 'none';
    document.querySelectorAll('.host-only').forEach(el => el.style.display = isHost ? '' : 'none');
    $('btn-ready').style.display = isHost ? 'none' : '';
    $('btn-ready').innerHTML = svg(me && me.ready ? 'close' : 'check') + (me && me.ready ? 'Не готов' : 'Готов');
    $('btn-start').innerHTML = svg('play') + (room.state === 'playing' ? 'Идёт бой…' : 'Начать матч');
    const allReady = room.players.every(p => p.ready || p.id === room.hostId);
    $('btn-start').disabled = room.state === 'playing' || !allReady;
    $('btn-settings').disabled = room.state === 'playing';
    if (room.state === 'playing' && app.screen === 'lobby' && !app.game) { /* ждём MATCH */ }
    this.renderPlanePicker(room, me);
  }

  renderPlanePicker(room, me) {
    const app = this.app, s = room.settings, prof = app.profile;
    const list = app.data.planes.filter(p => s.nations.includes(p.nation) && s.classes.includes(p.class));
    const grid = $('lobby-planes');
    const key = list.map(p => p.id).join() + '|' + (me && me.planeId) + '|' + (prof ? prof.unlocked.join() : '');
    if (grid.dataset.key === key) return;
    grid.dataset.key = key;
    grid.innerHTML = list.map(p => {
      const locked = prof && !prof.unlocked.includes(p.id);
      return `<div class="pcard ${me && me.planeId === p.id ? 'sel' : ''} ${locked ? 'locked' : ''}" data-id="${p.id}" title="${esc(p.desc)}">
        <canvas></canvas><div class="nm">${esc(p.name)}</div><div class="cls">${esc(NATIONS[p.nation].name)} · ${esc(CLASSES[p.class].name)}${locked ? ' ' + svg('lock') : ''}</div></div>`;
    }).join('');
    grid.querySelectorAll('.pcard').forEach(c => {
      const def = app.data.planes.find(p => p.id === c.dataset.id);
      requestAnimationFrame(() => planePreview(c.querySelector('canvas'), def));
      if (!c.classList.contains('locked')) c.onclick = () => app.net.send({ t: 'plane', planeId: def.id });
      else c.onclick = () => app.toast('Откройте этот самолёт в ангаре');
    });
  }

  addChat(el, m) {
    const d = document.createElement('div');
    if (m.sys) { d.className = 'sys'; d.textContent = m.text; }
    else d.innerHTML = `<b style="color:${m.team !== undefined ? TEAM_COLORS[m.team] : '#e9c46a'}">${esc(m.name)}${m.team !== undefined ? ' [команда]' : ''}:</b> ${esc(m.text)}`;
    el.appendChild(d);
    while (el.children.length > 60) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
    return d;
  }

  // ---------- ангар ----------
  renderHangar() {
    const app = this.app, prof = app.profile, data = app.data;
    if (!prof) { $('hangar-list').innerHTML = '<div class="muted">Профиль загружается… (нужно подключение к серверу)</div>'; return; }
    const lvl = levelFromXp(prof.xp);
    $('hangar-money').innerHTML = `${svg('star')} ${lvl} &nbsp; ${svg('coin')} ${prof.money}`;
    $('hangar-tabs').innerHTML = Object.entries(NATIONS).map(([k, n]) => `<button class="btn ${k === this.hangarNation ? 'sel' : ''}" data-n="${k}">${esc(n.name)}</button>`).join('');
    $('hangar-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { this.hangarNation = b.dataset.n; this.renderHangar(); });
    const planes = data.planes.filter(p => p.nation === this.hangarNation).sort((a, b) => a.tier - b.tier);
    // манёвр ∝ √gmax / Vs (скорость разворота на угловой скорости), скороподъёмность ∝ удельной тяге
    const man = p => Math.sqrt(p.gmax || 4) / p.vstall;
    const maxV = Math.max(...data.planes.map(p => p.vmax)), maxT = Math.max(...data.planes.map(man)), maxH = Math.max(...data.planes.map(p => p.hp));
    const maxC = Math.max(...data.planes.map(p => p.thrust));
    const maxF = Math.max(...data.planes.map(p => planeFirepower(p, data)));
    $('hangar-list').innerHTML = planes.map(p => {
      const own = prof.unlocked.includes(p.id);
      const ups = prof.upgrades[p.id] || {};
      const prev = data.planes.filter(x => x.nation === p.nation && x.tier === p.tier - 1);
      const prevOk = !prev.length || prev.some(x => prof.unlocked.includes(x.id));
      const bar = (name, v, ic) => `<div class="stat"><span>${svg(ic)}${name}</span><div class="b"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;
      const weapons = p.guns.map(g => `${data.weapons[g.w].name} ×${g.count}`).concat(p.bombs ? [`${data.bombs[p.bombs.type].name} ×${p.bombs.count}`] : [])
        .concat(p.rockets ? [`${data.rockets[p.rockets.type].name} ×${p.rockets.count}`] : []).concat(p.gunners.length ? [`стрелков: ${p.gunners.length}`] : []);
      return `<div class="hcard"><div class="title"><b>${esc(p.name)}</b><span class="muted">${esc(CLASSES[p.class].name)} · ранг ${p.tier}</span></div>
        <canvas></canvas><div class="desc">${esc(p.desc)}</div>
        ${bar('Скорость', p.vmax / maxV, 'speed')}${bar('Манёвр', man(p) / maxT, 'flip')}${bar('Подъём', p.thrust / maxC, 'alt')}${bar('Прочность', p.hp / maxH, 'shield')}${bar('Огонь', planeFirepower(p, data) / maxF, 'fire')}
        <div class="muted" style="font-size:12px;margin:4px 0">${Math.round(p.vmax * SPEED_TO_KMH)} км/ч · ${weapons.join(', ')}</div>
        ${own ? UPGRADE_TRACKS.map(t => {
          const l = ups[t] || 0;
          return `<div class="upg" title="${upgradeEffectText(t)} за уровень"><span>${svg(UPG_ICON[t])}${UPGRADE_NAMES[t]} <small class="muted">${upgradeEffectText(t)}</small></span><span class="pips">${[...Array(UPGRADE_MAX)].map((_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('')}</span>
            ${l < UPGRADE_MAX ? `<button class="btn small" data-up="${p.id}" data-track="${t}" ${prof.money < upgradeCost(p.tier, l) ? 'disabled' : ''}>${svg('coin')}${upgradeCost(p.tier, l)}</button>` : `<span class="muted" title="максимум">${svg('star')}</span>`}</div>`;
        }).join('') : `<div class="row"><button class="btn primary" data-unlock="${p.id}" ${lvl < p.level || prof.money < p.cost || !prevOk ? 'disabled' : ''}>
            ${svg(lvl < p.level || !prevOk ? 'lock' : 'coin')}Открыть · ${p.cost}</button></div><div class="muted" style="font-size:12px">${svg('star')} уровень ${p.level}${prevOk ? '' : ' · нужен самолёт предыдущего ранга'}</div>`}
      </div>`;
    }).join('');
    $('hangar-list').querySelectorAll('.hcard').forEach((c, i) => requestAnimationFrame(() => planePreview(c.querySelector('canvas'), planes[i])));
    $('hangar-list').querySelectorAll('[data-unlock]').forEach(b => b.onclick = () => app.net.send({ t: 'unlock', planeId: b.dataset.unlock }));
    $('hangar-list').querySelectorAll('[data-up]').forEach(b => b.onclick = () => app.net.send({ t: 'upgrade', planeId: b.dataset.up, track: b.dataset.track }));
  }

  renderProfile() {
    const p = this.app.profile;
    if (!p) { $('profile-body').innerHTML = '<div class="muted">Нет подключения к серверу.</div>'; return; }
    const lvl = levelFromXp(p.xp), cur = xpForLevel(lvl), next = xpForLevel(lvl + 1);
    const s = p.stats;
    $('profile-body').innerHTML = `<h3>${esc(p.name)} — уровень ${lvl}</h3>
      <div class="stat"><span>Опыт</span><div class="b"><i style="width:${Math.round((p.xp - cur) / (next - cur) * 100)}%"></i></div><span style="width:auto">${p.xp}/${next}</span></div>
      <table class="list"><tbody>
      <tr><td>${svg('coin')} Валюта</td><td>${p.money}</td></tr>
      <tr><td>Матчей / побед</td><td>${s.matches} / ${s.wins}</td></tr>
      <tr><td>Сбито самолётов</td><td>${s.kills}</td></tr><tr><td>Убито пилотов</td><td>${s.pilotKills}</td></tr>
      <tr><td>Смертей</td><td>${s.deaths}</td></tr><tr><td>K/D</td><td>${(s.kills / Math.max(1, s.deaths)).toFixed(2)}</td></tr>
      <tr><td>Наземных целей</td><td>${s.ground}</td></tr><tr><td>Нанесённый урон</td><td>${s.damage}</td></tr>
      <tr><td>Открыто самолётов</td><td>${p.unlocked.length} из ${this.app.data.planes.length}</td></tr>
      </tbody></table>`;
  }

  renderResults(res) {
    const app = this.app;
    const teams = MODES[res.mode].teams;
    let title = 'Итоги матча';
    if (teams) title = res.winnerTeam === null || res.winnerTeam === undefined ? 'Ничья' : `Победа: ${TEAM_NAMES[res.winnerTeam]}`;
    else { const w = res.results.find(r => r.id === res.winnerId); title = w ? `Победитель: ${w.name}` : 'Итоги матча'; }
    $('results-title').textContent = title + (res.reason ? ` — ${res.reason}` : '');
    const th = (ic, t) => `<th title="${t}">${svg(ic)}</th>`;
    $('results-table').innerHTML = `<thead><tr><th>Пилот</th>${teams ? '<th></th>' : ''}${th('fire', 'Сбито самолётов')}${th('eject', 'Убито пилотов')}${th('skull', 'Смерти')}${th('burst', 'Урон')}${th('tank', 'Наземные цели')}${th('star', 'Очки')}${th('user', 'Опыт')}</tr></thead><tbody>` +
      res.results.map(r => `<tr class="${r.id === app.myId ? 'me' : ''}"><td style="color:${r.color}">${r.won ? svg('crown') + ' ' : ''}${esc(r.name)}</td>
        ${teams ? `<td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${TEAM_COLORS[r.team]}" title="${TEAM_NAMES[r.team]}"></span></td>` : ''}<td>${r.kills}</td><td>${r.pilotKills}</td><td>${r.deaths}</td>
        <td>${r.damage}</td><td>${r.ground}</td><td>${r.score}</td><td>${r.xp !== undefined ? '+' + r.xp : '—'}</td></tr>`).join('') + '</tbody>';
    const mine = res.results.find(r => r.id === app.myId);
    $('results-reward').innerHTML = mine && mine.xp !== undefined ? `${svg('star')} +${mine.xp} &nbsp; ${svg('coin')} +${mine.money}` : '';
  }
}
