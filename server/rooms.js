// Лобби и комнаты: создание, поиск, вход по коду, команды, готовность, чат, кик, смена хоста, запуск матча.
import { DEFAULT_SETTINGS, MODES, NATIONS, CLASSES, clamp } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { makeRoomCode } from '../shared/protocol.js';
import { Game } from './game.js';
import { sanitizeText } from './anticheat.js';

export class RoomManager {
  constructor(data, profiles) {
    this.data = data;
    this.profiles = profiles;
    this.rooms = new Map();
  }

  sanitizeSettings(s, prev = DEFAULT_SETTINGS) {
    s = s || {};
    const out = { ...prev };
    if (typeof s.name === 'string') out.name = sanitizeText(s.name).slice(0, 32) || prev.name;
    if (typeof s.password === 'string') out.password = s.password.slice(0, 24);
    if (MAPS[s.map]) out.map = s.map;
    if (MODES[s.mode]) out.mode = s.mode;
    const n = (v, a, b, d) => (typeof v === 'number' && isFinite(v)) ? clamp(Math.round(v), a, b) : d;
    out.maxPlayers = n(s.maxPlayers, 2, 16, out.maxPlayers);
    out.timeLimit = n(s.timeLimit, 2, 30, out.timeLimit);
    out.scoreLimit = n(s.scoreLimit, 3, 200, out.scoreLimit);
    out.botCount = n(s.botCount, 0, 15, out.botCount);
    out.botDifficulty = n(s.botDifficulty, 0, 2, out.botDifficulty);
    out.respawnTime = n(s.respawnTime, 2, 30, out.respawnTime);
    if (typeof s.bots === 'boolean') out.bots = s.bots;
    if (s.respawnMode === 'timer' || s.respawnMode === 'airfield') out.respawnMode = s.respawnMode;
    if (Array.isArray(s.nations)) { const v = s.nations.filter(x => NATIONS[x]); if (v.length) out.nations = [...new Set(v)]; }
    if (Array.isArray(s.classes)) { const v = s.classes.filter(x => CLASSES[x]); if (v.length) out.classes = [...new Set(v)]; }
    return out;
  }

  create(client, settings) {
    let code;
    do code = makeRoomCode(); while (this.rooms.has(code));
    const room = new Room(this, code, this.sanitizeSettings(settings));
    this.rooms.set(code, room);
    room.join(client);
    return room;
  }

  list() {
    return [...this.rooms.values()].map(r => r.summary());
  }

  quick(client) {
    const open = [...this.rooms.values()]
      .filter(r => !r.settings.password && r.players.size < r.settings.maxPlayers && r.settings.mode !== 'br')
      .sort((a, b) => (b.state === 'playing') - (a.state === 'playing') || b.players.size - a.players.size);
    if (open.length) { open[0].join(client); return open[0]; }
    const maps = Object.keys(MAPS);
    const room = this.create(client, {
      ...DEFAULT_SETTINGS, name: 'Быстрая игра ' + client.name, map: maps[Math.floor(Math.random() * maps.length)],
      mode: 'tdm', bots: true, botCount: 7, maxPlayers: 12, quick: true,
    });
    room.quick = true;
    room.startMatch(true);
    return room;
  }

  remove(room) { if (room.game) room.game.stop(); this.rooms.delete(room.code); }
}

class Room {
  constructor(mgr, code, settings) {
    this.mgr = mgr;
    this.code = code;
    this.settings = settings;
    this.players = new Map();     // id -> client
    this.hostId = null;
    this.state = 'lobby';         // lobby | playing
    this.game = null;
    this.chat = [];
    this.lastResults = null;
  }

  summary() {
    return {
      code: this.code, name: this.settings.name, mode: this.settings.mode, map: this.settings.map,
      players: this.players.size, max: this.settings.maxPlayers, locked: !!this.settings.password, state: this.state,
      bots: this.settings.bots ? this.settings.botCount : 0,
    };
  }

  view() {
    return {
      code: this.code, settings: { ...this.settings, password: this.settings.password ? '••••' : '' }, hasPassword: !!this.settings.password,
      hostId: this.hostId, state: this.state,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, planeId: p.planeId, ready: p.ready, level: p.level })),
    };
  }

  broadcast(msg) { const raw = JSON.stringify(msg); for (const p of this.players.values()) p.sendRaw(raw); }
  update() { this.broadcast({ t: 'room', room: this.view() }); }
  system(text) { this.pushChat({ t: 'chat', sys: true, text }); }
  pushChat(m) { this.chat.push(m); if (this.chat.length > 50) this.chat.shift(); this.broadcast(m); }

  teamCounts() {
    const c = [0, 0];
    for (const p of this.players.values()) if (p.team === 0 || p.team === 1) c[p.team]++;
    return c;
  }

  join(client, password) {
    if (this.players.has(client.id)) return null;
    if (this.players.size >= this.settings.maxPlayers) return 'Лобби заполнено';
    if (this.settings.password && password !== this.settings.password) return 'Неверный пароль';
    if (client.room) client.room.leave(client);
    client.room = this;
    const c = this.teamCounts();
    client.team = c[0] <= c[1] ? 0 : 1;
    client.ready = false;
    this.ensurePlane(client);
    this.players.set(client.id, client);
    if (!this.hostId) this.hostId = client.id;
    client.send({ t: 'room', room: this.view() });
    for (const m of this.chat) client.send(m);
    this.system(`${client.name} присоединился`);
    this.update();
    if (this.state === 'playing' && this.game) {
      this.game.addHuman(client);
      client.send(this.game.matchInfo(this.game.users.get(client.id)));
    }
    return null;
  }

  ensurePlane(client) {
    const allowed = this.mgr.data.planes.filter(p => this.settings.nations.includes(p.nation) && this.settings.classes.includes(p.class));
    const own = allowed.filter(p => !client.profile || client.profile.unlocked.includes(p.id));
    if (!own.some(p => p.id === client.planeId)) client.planeId = (own[0] || allowed[0] || this.mgr.data.planes[0]).id;
  }

  leave(client, reason) {
    if (!this.players.has(client.id)) return;
    this.players.delete(client.id);
    client.room = null;
    if (this.game) this.game.removeHuman(client.id);
    client.send({ t: 'left', reason: reason || null });
    if (this.players.size === 0) { this.mgr.remove(this); return; }
    if (this.hostId === client.id) {
      // хостом становится следующий игрок
      this.hostId = this.players.keys().next().value;
      this.system(`${this.players.get(this.hostId).name} теперь хост`);
    }
    this.system(`${client.name} ${reason === 'kick' ? 'исключён' : 'вышел'}`);
    this.update();
  }

  handle(client, m) {
    const isHost = client.id === this.hostId;
    switch (m.t) {
      case 'team':
        if (m.team === 0 || m.team === 1) { client.team = m.team; client.ready = false; this.update(); }
        break;
      case 'plane': {
        const def = this.mgr.data.planes.find(p => p.id === m.planeId);
        if (!def || !this.settings.nations.includes(def.nation) || !this.settings.classes.includes(def.class)) return client.error('Самолёт запрещён в этом лобби');
        if (client.profile && !client.profile.unlocked.includes(def.id)) return client.error('Самолёт не открыт в ангаре');
        client.planeId = def.id;
        if (this.game && this.game.users.has(client.id)) {
          const u = this.game.users.get(client.id);
          if (u.state === 'dead' || u.state === 'pilot') this.game.setPlane(u, def.id);
          else u.pendingPlane = def.id;
        }
        this.update();
        break;
      }
      case 'ready': client.ready = !!m.ready; this.update(); this.autoStart(); break;
      case 'chat': {
        const text = sanitizeText(m.text);
        if (!text) return;
        if (!client.limiter.allowChat(Date.now())) return client.error('Слишком часто');
        const msg = { t: 'chat', from: client.id, name: client.name, text, team: m.team ? client.team : undefined };
        if (m.team && this.game) {
          const raw = JSON.stringify(msg);
          for (const p of this.players.values()) if (p.team === client.team) p.sendRaw(raw);
        } else this.pushChat(msg);
        break;
      }
      case 'kick': {
        if (!isHost) return;
        const target = this.players.get(m.id);
        if (target && target !== client) this.leave(target, 'kick');
        break;
      }
      case 'settings':
        if (!isHost || this.state !== 'lobby') return;
        this.settings = this.mgr.sanitizeSettings(m.settings, this.settings);
        if (typeof m.settings.password === 'string' && m.settings.password === '••••') { /* не меняем */ }
        for (const p of this.players.values()) { this.ensurePlane(p); p.ready = false; }
        this.system('Хост изменил настройки');
        this.update();
        break;
      case 'start':
        if (!isHost) return;
        if (this.state !== 'lobby') return;
        if (![...this.players.values()].every(p => p.ready || p.id === this.hostId)) return client.error('Не все игроки готовы');
        this.startMatch();
        break;
    }
  }

  autoStart() {}

  startMatch() {
    if (this.state === 'playing') return;
    this.state = 'playing';
    for (const p of this.players.values()) this.ensurePlane(p);
    this.game = new Game(this, this.mgr.data, res => this.endMatch(res));
    for (const p of this.players.values()) p.send(this.game.matchInfo(this.game.users.get(p.id)));
    this.system('Матч начался!');
    this.update();
  }

  endMatch(res) {
    const game = this.game;
    this.game = null;
    this.state = 'lobby';
    // награды за матч
    for (const r of res.results) {
      if (r.bot) continue;
      const cl = this.players.get(r.id);
      if (!cl || !cl.profile) continue;
      const reward = this.mgr.profiles.applyMatch(cl.profile, r, r.won);
      r.xp = reward.xp; r.money = reward.money;
      cl.send({ t: 'profile', profile: this.mgr.profiles.view(cl.profile) });
    }
    for (const p of this.players.values()) p.ready = false;
    this.lastResults = res;
    this.broadcast({ t: 'end', ...res });
    this.update();
    if (game) game.stop();
    if (this.quick) {
      // быстрая игра: следующий раунд стартует автоматически
      setTimeout(() => { if (this.players.size && this.state === 'lobby' && this.quick) this.startMatch(); }, 20000);
    }
  }
}
