// Лобби и комнаты: создание, поиск, вход по коду, команды, готовность, чат, кик, смена хоста, запуск матча.
import { DEFAULT_SETTINGS, MODES, NATIONS, CLASSES, clamp } from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { makeRoomCode } from '../shared/protocol.js';
import { Game } from './game.js';
import { sanitizeText } from './anticheat.js';

const MAX_ROOMS = +(process.env.WF_MAX_ROOMS || 300);
const KICK_BAN_MS = 5 * 60 * 1000;

export class RoomManager {
  constructor(data, profiles) {
    this.data = data;
    this.profiles = profiles;
    this.rooms = new Map();
  }

  sanitizeSettings(s, prev = DEFAULT_SETTINGS) {
    s = s && typeof s === 'object' ? s : {};
    const out = { ...DEFAULT_SETTINGS, ...prev };
    if (typeof s.name === 'string') out.name = sanitizeText(s.name).slice(0, 32) || prev.name;
    if (typeof s.password === 'string') out.password = s.password.slice(0, 24);
    if (typeof s.map === 'string' && Object.hasOwn(MAPS, s.map)) out.map = s.map;
    if (typeof s.mode === 'string' && Object.hasOwn(MODES, s.mode)) out.mode = s.mode;
    const n = (v, a, b, d) => (typeof v === 'number' && isFinite(v)) ? clamp(Math.round(v), a, b) : d;
    out.maxPlayers = n(s.maxPlayers, 2, 16, out.maxPlayers);
    out.timeLimit = n(s.timeLimit, 2, 30, out.timeLimit);
    out.scoreLimit = n(s.scoreLimit, 3, 200, out.scoreLimit);
    out.botCount = n(s.botCount, 0, 15, out.botCount);
    out.botDifficulty = n(s.botDifficulty, 0, 2, out.botDifficulty);
    out.respawnTime = n(s.respawnTime, 2, 30, out.respawnTime);
    if (typeof s.bots === 'boolean') out.bots = s.bots;
    if (typeof s.friendlyFire === 'boolean') out.friendlyFire = s.friendlyFire;
    if (s.respawnMode === 'timer' || s.respawnMode === 'airfield') out.respawnMode = s.respawnMode;
    if (Array.isArray(s.nations)) { const v = s.nations.filter(x => typeof x === 'string' && Object.hasOwn(NATIONS, x)); if (v.length) out.nations = [...new Set(v)]; }
    if (Array.isArray(s.classes)) { const v = s.classes.filter(x => typeof x === 'string' && Object.hasOwn(CLASSES, x)); if (v.length) out.classes = [...new Set(v)]; }
    return out;
  }

  // Возвращает комнату или строку с ошибкой.
  create(client, settings, opts = {}) {
    if (this.rooms.size >= MAX_ROOMS) return 'Сервер переполнен: слишком много лобби';
    let code;
    do code = makeRoomCode(); while (this.rooms.has(code));
    const room = new Room(this, code, this.sanitizeSettings(settings));
    if (opts.quick) room.quick = true;
    this.rooms.set(code, room);
    const err = room.join(client, room.settings.password, { creator: true });
    if (err) { this.rooms.delete(code); return err; }
    return room;
  }

  list() {
    return [...this.rooms.values()].map(r => r.summary());
  }

  quick(client) {
    const open = [...this.rooms.values()]
      .filter(r => !r.settings.password && r.players.size < r.settings.maxPlayers && r.settings.mode !== 'br' && !r.isBanned(client))
      .sort((a, b) => (b.state === 'playing') - (a.state === 'playing') || b.players.size - a.players.size);
    if (open.length && !open[0].join(client)) return open[0];
    const maps = Object.keys(MAPS);
    const room = this.create(client, {
      ...DEFAULT_SETTINGS, name: 'Быстрая игра ' + client.name, map: maps[Math.floor(Math.random() * maps.length)],
      mode: 'tdm', bots: true, botCount: 7, maxPlayers: 12,
    }, { quick: true });
    if (typeof room === 'string') { client.error(room); return null; }
    room.startMatch();
    return room;
  }

  remove(room) { if (room.game) room.game.stop(); clearTimeout(room.restartTimer); this.rooms.delete(room.code); }
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
    this.bans = new Map();        // ключ (хеш токена или ip) -> до какого времени запрещён вход
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
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, team: p.team, planeId: p.planeId, ready: p.ready, level: p.level, away: !!p.disconnected })),
    };
  }

  broadcast(msg) { const raw = JSON.stringify(msg); for (const p of this.players.values()) p.sendRaw(raw); }
  update() { this.broadcast({ t: 'room', room: this.view() }); }
  system(text) { this.pushChat({ t: 'chat', sys: true, text }); }
  pushChat(m) { this.chat.push(m); if (this.chat.length > 50) this.chat.shift(); this.broadcast(m); }

  banKey(client) { return client.tokenHash || 'ip:' + client.ip; }
  isBanned(client) {
    const until = this.bans.get(this.banKey(client));
    if (!until) return false;
    if (Date.now() > until) { this.bans.delete(this.banKey(client)); return false; }
    return true;
  }

  teamCounts() {
    const c = [0, 0];
    for (const p of this.players.values()) if (p.team === 0 || p.team === 1) c[p.team]++;
    return c;
  }

  // Делает ник уникальным в пределах комнаты: «Ace», «Ace (2)», …
  uniqueName(client, name) {
    const taken = new Set([...this.players.values()].filter(p => p !== client).map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 100; i++) { const n = `${Array.from(name).slice(0, 12).join('')} (${i})`; if (!taken.has(n)) return n; }
    return name + '*';
  }

  join(client, password, opts = {}) {
    if (this.players.has(client.id)) return null;
    if (this.isBanned(client)) return 'Вы исключены из этого лобби';
    if (this.players.size >= this.settings.maxPlayers) return 'Лобби заполнено';
    if (this.settings.password && password !== this.settings.password && !opts.creator) return 'Неверный пароль';
    if (client.room) client.room.leave(client);
    client.room = this;
    const c = this.teamCounts();
    client.team = c[0] <= c[1] ? 0 : 1;
    client.ready = false;
    client.name = this.uniqueName(client, client.name);
    this.ensurePlane(client);
    this.players.set(client.id, client);
    if (!this.hostId) this.hostId = client.id;
    for (const m of this.chat) client.send(m);
    this.system(`${client.name} присоединился`);
    this.update();
    if (this.state === 'playing' && this.game) {
      this.game.addHuman(client);
      client.send(this.game.matchInfo(this.game.users.get(client.id)));
    }
    return null;
  }

  // Игрок пропал (ждём переподключения): хост сразу переходит к тому, кто на связи.
  away(client) {
    if (this.hostId === client.id) {
      const next = [...this.players.values()].find(p => !p.disconnected);
      if (next) { this.hostId = next.id; this.system(`${next.name} теперь хост`); }
    }
    this.system(`${client.name} потерял связь…`);
    this.update();
  }

  // Переподключение: отправляем текущее состояние комнаты и матча.
  resume(client) {
    for (const m of this.chat) client.send(m);
    this.update();
    if (this.state === 'playing' && this.game) {
      const u = this.game.resumeHuman(client);
      if (u) client.send(this.game.matchInfo(u));
    }
  }

  rename(client, name) {
    client.name = this.uniqueName(client, name);
    if (this.game) this.game.renameUser(client.id, client.name);
    this.update();
  }

  ensurePlane(client) {
    const allowed = this.mgr.data.planes.filter(p => this.settings.nations.includes(p.nation) && this.settings.classes.includes(p.class));
    const own = allowed.filter(p => client.profile && client.profile.unlocked.includes(p.id));
    if (!own.some(p => p.id === client.planeId)) client.planeId = (own[0] || allowed.find(p => p.cost === 0) || this.mgr.data.planes[0]).id;
  }

  leave(client, reason) {
    if (!this.players.has(client.id)) return;
    this.players.delete(client.id);
    client.room = null;
    client.disconnected = false;
    clearTimeout(client.graceTimer);
    if (this.game) this.game.removeHuman(client.id);
    client.send({ t: 'left', reason: reason || null });
    if (this.players.size === 0) { this.mgr.remove(this); return; }
    if (this.hostId === client.id) {
      // хостом становится следующий игрок (по возможности — не отключившийся)
      const next = [...this.players.values()].find(p => !p.disconnected) || this.players.values().next().value;
      this.hostId = next.id;
      this.system(`${next.name} теперь хост`);
    }
    this.system(`${client.name} ${reason === 'kick' ? 'исключён' : 'вышел'}`);
    this.update();
  }

  handle(client, m) {
    const isHost = client.id === this.hostId;
    switch (m.t) {
      case 'team':
        if (this.state !== 'lobby') return client.error('Команду можно сменить только в лобби');
        if (m.team === 0 || m.team === 1) { client.team = m.team; client.ready = false; this.update(); }
        break;
      case 'plane': {
        const def = typeof m.planeId === 'string' && this.mgr.data.planes.find(p => p.id === m.planeId);
        if (!def || !this.settings.nations.includes(def.nation) || !this.settings.classes.includes(def.class)) return client.error('Самолёт запрещён в этом лобби');
        if (!client.profile || !client.profile.unlocked.includes(def.id)) return client.error('Самолёт не открыт в ангаре');
        client.planeId = def.id;
        if (this.game && this.game.users.has(client.id)) {
          const u = this.game.users.get(client.id);
          if (u.state === 'dead' || u.state === 'pilot') this.game.setPlane(u, def.id);
          else u.pendingPlane = def.id;
        }
        this.update();
        break;
      }
      case 'ready': client.ready = !!m.ready; this.update(); break;
      case 'chat': {
        const text = sanitizeText(m.text);
        if (!text) return;
        if (!client.limiter.allowChat(Date.now())) return client.error('Слишком часто');
        const team = m.team && this.game && MODES[this.settings.mode].teams;
        const msg = { t: 'chat', from: client.id, name: client.name, text, team: team ? client.team : undefined };
        if (team) {
          const raw = JSON.stringify(msg);
          for (const p of this.players.values()) if (p.team === client.team) p.sendRaw(raw);
        } else this.pushChat(msg);
        break;
      }
      case 'kick': {
        if (!isHost || typeof m.id !== 'string') return;
        const target = this.players.get(m.id);
        if (target && target !== client) {
          this.bans.set(this.banKey(target), Date.now() + KICK_BAN_MS);
          this.leave(target, 'kick');
        }
        break;
      }
      case 'settings':
        if (!isHost || this.state !== 'lobby' || !m.settings || typeof m.settings !== 'object') return;
        this.settings = this.mgr.sanitizeSettings(m.settings, this.settings);
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

  startMatch() {
    if (this.state === 'playing') return;
    clearTimeout(this.restartTimer);
    this.state = 'playing';
    for (const p of this.players.values()) this.ensurePlane(p);
    this.game = new Game(this, this.mgr.data, res => this.endMatch(res));
    for (const p of this.players.values()) p.send(this.game.matchInfo(this.game.users.get(p.id)));
    this.system('Матч начался!');
    this.update();
  }

  endMatch(res) {
    const game = this.game;
    if (!game) return;                     // защита от повторного завершения
    this.game = null;
    this.state = 'lobby';
    // награды за матч (ровно один раз: game.finish вызывает onEnd однократно, game обнулён выше)
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
    game.stop();
    if (this.quick) {
      // быстрая игра: следующий раунд стартует автоматически
      this.restartTimer = setTimeout(() => { if (this.players.size && this.state === 'lobby' && this.quick) this.startMatch(); }, 20000);
    }
  }
}
