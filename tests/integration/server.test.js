// Интеграционные тесты сервера: безопасность HTTP, устойчивость к мусору, лобби, античит, сохранение.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'net';
import { startServer, connect, createRoom, TestClient, makeToken, wait, inputStream, DATA } from '../helpers.js';

let srv;
beforeAll(async () => { srv = await startServer({ WF_MAX_CONN_PER_IP: '64' }); });
afterAll(async () => { await srv.stop(); });

// «Сырой» HTTP-запрос без нормализации пути (как curl --path-as-is).
function rawGet(port, pathStr) {
  return new Promise(res => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${pathStr} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); s.on('error', () => res(''));
  });
}

describe('HTTP: безопасность', () => {
  it('нельзя выйти за пределы client/ и shared/ (обход путей)', async () => {
    for (const p of ['/client/../data/profiles.json', '/client/../server/index.js', '/client/../package.json', '/shared/%2e%2e/server/index.js', '/client/..%2fpackage.json']) {
      const r = await rawGet(srv.port, p);
      expect(r.split('\r\n')[0], p).not.toMatch(/ 200 /);
    }
  });
  it('отдаёт заголовки безопасности (CSP, nosniff)', async () => {
    const r = await fetch(srv.url + '/');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBeTruthy();
  });
});

describe('устойчивость к мусорным сообщениям', () => {
  it('сервер не падает от мусора, пустых, огромных и неверно типизированных сообщений', async () => {
    const c = await connect(srv, 'Fuzz');
    const junk = ['', 'null', '[]', '1', '"x"', '{', '{"t":5}', '{"t":null}', '{"t":"in"}', '{"t":"in","s":"x","p":"1"}',
      '{"t":"create","settings":"x"}', '{"t":"create","settings":{"maxPlayers":"99","mode":{"a":1},"nations":"us","classes":[1,2]}}',
      '{"t":"join","code":{"a":1}}', '{"t":"join","code":12345}', '{"t":"settings","settings":null}', '{"t":"settings"}',
      '{"t":"chat","text":{"x":1}}', '{"t":"chat","text":["a"]}', '{"t":"kick","id":null}', '{"t":"plane","planeId":[]}',
      '{"t":"team","team":"1"}', '{"t":"upgrade","planeId":null,"track":"__proto__"}', '{"t":"unlock","planeId":"__proto__"}',
      '{"t":"hello","token":{"x":1},"name":{"y":2}}', '{"t":"__proto__"}', '{"t":"constructor"}', '{"__proto__":{"t":"x"}}',
      JSON.stringify({ t: 'chat', text: 'a'.repeat(15000) }), JSON.stringify({ t: 'in', s: 1e300, p: Infinity, aim: -1e308 })];
    for (const j of junk) c.sendRaw(j);
    c.sendRaw(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await createRoom(c, {});
    for (const j of junk) c.sendRaw(j);
    c.send({ t: 'start' });
    await wait(300);
    for (const j of junk) c.sendRaw(j);
    await wait(300);
    // огромное сообщение (> maxPayload) — соединение закрывается, но сервер жив
    const big = new TestClient(srv.ws); await big.opened;
    big.sendRaw('{"t":"chat","text":"' + 'x'.repeat(200000) + '"}');
    await wait(300);
    expect(big.closed).toBe(true);
    expect(srv.alive()).toBe(true);
    const ok = await connect(srv, 'After');
    expect(ok.id).toBeTruthy();
    expect(srv.logs.err).not.toMatch(/Ошибка обработки/);
    c.close(); ok.close();
  });
});

describe('лобби', () => {
  it('настройки лобби применяются в матче', async () => {
    const h = await connect(srv, 'Host');
    const settings = { name: 'Cfg', map: 'mountains', mode: 'base', maxPlayers: 6, timeLimit: 3, scoreLimit: 7, nations: ['de', 'jp'], classes: ['fighter', 'bomber'],
      bots: true, botCount: 3, botDifficulty: 2, respawnMode: 'airfield', respawnTime: 9 };
    const room = await createRoom(h, settings);
    for (const k of Object.keys(settings)) expect(room.settings[k], k).toEqual(settings[k]);
    h.send({ t: 'start' });
    const m = await h.next('match');
    expect(m.map).toBe('mountains'); expect(m.mode).toBe('base');
    expect(m.settings.timeLimit).toBe(3); expect(m.settings.respawnTime).toBe(9);
    expect(m.roster.filter(r => r.bot).length).toBe(3);
    for (const r of m.roster) {
      const d = DATA.planes.find(p => p.id === r.planeId);
      expect(['de', 'jp']).toContain(d.nation); expect(['fighter', 'bomber']).toContain(d.class);
    }
    const s = await h.snapshot();
    expect(s.tl).toBeLessThanOrEqual(180);
    h.close();
  });

  it('вход по коду, по паролю; неверный пароль; несуществующий код; полное лобби', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, { password: 'secret', maxPlayers: 2 });
    const a = await connect(srv, 'A');
    a.send({ t: 'join', code: 'ZZZZZZ' });
    expect((await a.next('err')).msg).toMatch(/не найдено/);
    a.send({ t: 'join', code: room.code, password: 'wrong' });
    expect((await a.next('err')).needPassword).toBe(true);
    a.send({ t: 'join', code: room.code.toLowerCase(), password: 'secret' });
    expect((await a.next(m => m.t === 'room' && m.room.players.length === 2)).room.code).toBe(room.code);
    const b = await connect(srv, 'B');
    b.send({ t: 'join', code: room.code, password: 'secret' });
    expect((await b.next('err')).msg).toMatch(/заполнено/);
    // список лобби: замок и X/Y
    b.send({ t: 'list' });
    const list = (await b.next('rooms')).list;
    const it = list.find(r => r.code === room.code);
    expect(it.locked).toBe(true); expect(it.players).toBe(2); expect(it.max).toBe(2);
    h.close(); a.close(); b.close();
  });

  it('два игрока одновременно занимают последнее место — входит только один', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, { maxPlayers: 2 });
    const [a, b] = await Promise.all([connect(srv, 'A'), connect(srv, 'B')]);
    a.send({ t: 'join', code: room.code }); b.send({ t: 'join', code: room.code });
    await wait(400);
    const okA = (a.log || []).some(m => m.t === 'room'), okB = (b.log || []).some(m => m.t === 'room');
    expect(okA !== okB).toBe(true);
    h.send({ t: 'list' });
    const list = (await h.next('rooms')).list;
    expect(list.find(r => r.code === room.code).players).toBe(2);
    h.close(); a.close(); b.close();
  });

  it('хост выходит в лобби и во время матча — хостом становится следующий', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, {});
    const a = await connect(srv, 'A'), b = await connect(srv, 'B');
    a.send({ t: 'join', code: room.code }); await a.next('room');
    b.send({ t: 'join', code: room.code }); await b.next('room');
    h.send({ t: 'leave' });
    const r1 = await a.future(m => m.t === 'room' && m.room.players.length === 2);
    expect(r1.room.hostId).toBe(a.id);
    a.send({ t: 'ready', ready: true }); b.send({ t: 'ready', ready: true });
    await wait(100);
    a.send({ t: 'start' });
    await a.next('match');
    a.close();
    const r2 = await b.future(m => m.t === 'room' && m.room.players.length === 1, 4000);
    expect(r2.room.hostId).toBe(b.id);
    b.close();
  });

  it('кик: игрок исключён и не может сразу зайти обратно', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, {});
    const a = await connect(srv, 'Bad');
    a.send({ t: 'join', code: room.code }); await a.next('room');
    // не-хост не может кикать
    a.send({ t: 'kick', id: h.id });
    await wait(100);
    h.send({ t: 'kick', id: a.id });
    expect((await a.next('left')).reason).toBe('kick');
    a.clear();
    a.send({ t: 'join', code: room.code });
    const r = await a.next(m => m.t === 'err' || m.t === 'room');
    expect(r.t).toBe('err');
    h.close(); a.close();
  });

  it('ники: пустой, 500 символов, HTML, эмодзи, дубли', async () => {
    const h = await connect(srv, '<img src=x onerror=alert(1)>');
    const room = await createRoom(h, {});
    const names = ['', 'x'.repeat(500), '"><script>alert(1)</script>', '😀😀😀😀😀😀😀😀😀', 'Дубль', 'Дубль', '‮gnp.exe'];
    const cs = [];
    for (const n of names) { const c = await connect(srv, n); c.send({ t: 'join', code: room.code }); await c.next('room'); cs.push(c); }
    await wait(200);
    h.send({ t: 'list' }); await h.next('rooms');
    const last = h.log.filter(m => m.t === 'room').pop().room;
    for (const p of last.players) {
      expect(p.name.length).toBeGreaterThan(0);
      expect([...p.name].length).toBeLessThanOrEqual(16);
      expect(p.name).not.toMatch(/[<>]/);
      expect(p.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);   // нет «разрезанных» эмодзи
      expect(p.name).not.toMatch(/[‪-‮⁦-⁩]/);           // нет символов смены направления
    }
    const dups = last.players.map(p => p.name).filter(n => n.startsWith('Дубль'));
    expect(new Set(dups).size).toBe(dups.length);
    h.close(); cs.forEach(c => c.close());
  });

  it('чат: спам ограничен, длинное сообщение обрезано, HTML не превращается в разметку на сервере', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, {});
    const a = await connect(srv, 'A'); a.send({ t: 'join', code: room.code }); await a.next('room');
    for (let i = 0; i < 20; i++) a.send({ t: 'chat', text: 'spam ' + i });
    a.send({ t: 'chat', text: 'L'.repeat(1000) });
    a.send({ t: 'chat', text: '<b>hi</b>' });
    await wait(400);
    const got = h.log.filter(m => m.t === 'chat' && m.from === a.id);
    expect(got.length).toBeLessThanOrEqual(7);
    for (const m of got) expect(m.text.length).toBeLessThanOrEqual(140);
    expect(a.log.some(m => m.t === 'err' && /часто/.test(m.msg))).toBe(true);
    h.close(); a.close();
  });

  it('закрытая вкладка — игрок выходит сразу, пустое лобби удаляется', async () => {
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, {});
    h.close();                                   // штатное закрытие
    await wait(300);
    const o = await connect(srv, 'Other');
    o.send({ t: 'list' });
    const list = (await o.next('rooms')).list;
    expect(list.find(r => r.code === room.code)).toBeUndefined();
    o.close();
  });

  it('обрыв связи без переподключения — лобби удаляется после окна ожидания', async () => {
    const gs = await startServer({ WF_RECONNECT_GRACE_MS: '800' });
    const h = await connect(gs, 'Host');
    const room = await createRoom(gs === gs ? h : h, {});
    h.terminate();                               // обрыв (код 1006)
    await wait(300);
    const o = await connect(gs, 'Other');
    o.send({ t: 'list' });
    expect((await o.next('rooms')).list.find(r => r.code === room.code)).toBeTruthy();   // ещё ждём
    await wait(900);
    o.send({ t: 'list' });
    expect((await o.next('rooms')).list.find(r => r.code === room.code)).toBeUndefined();
    o.close();
    await gs.stop();
  });

  it('после матча — итоги, награда один раз, возврат в то же лобби и повторный старт', async () => {
    const hs = await startServer({ WF_TEST_HOOKS: '1' });
    const h = await connect(hs, 'Host');
    const a = await connect(hs, 'Mate');
    const room = await createRoom(h, { timeLimit: 2 });
    a.send({ t: 'join', code: room.code }); await a.next('room');
    a.send({ t: 'ready', ready: true }); await wait(100);
    h.send({ t: 'start' }); await h.next('match');
    h.send({ t: '__end' }); h.send({ t: '__end' });
    const end = await h.next('end', 5000);
    expect(end.results.length).toBe(2);
    const prof = await h.next('profile');
    const xp1 = prof.profile.xp;
    await wait(300);
    expect(h.msgs.filter(m => m.t === 'end').length).toBe(0);           // итоги пришли один раз
    expect(h.msgs.filter(m => m.t === 'profile').length).toBe(0);       // награда начислена один раз
    const r = h.log.filter(m => m.t === 'room').pop().room;
    expect(r.state).toBe('lobby'); expect(r.code).toBe(room.code); expect(r.players.length).toBe(2);
    a.send({ t: 'ready', ready: true }); await wait(100);
    h.send({ t: 'start' });
    const m2 = await h.next('match', 4000);
    expect(m2.mode).toBe(room.settings.mode);
    expect(xp1).toBeGreaterThan(0);
    h.close(); a.close();
    await hs.stop();
  });

  it('обрыв связи: игрок переподключается и возвращается в тот же матч', async () => {
    const token = makeToken('recon');
    const h = await connect(srv, 'Host');
    const room = await createRoom(h, {});
    const a = await connect(srv, 'Lossy', token);
    a.send({ t: 'join', code: room.code }); await a.next('room');
    a.send({ t: 'ready', ready: true }); await wait(100);
    h.send({ t: 'start' }); await a.next('match');
    const oldId = a.id;
    a.terminate();                       // «пропал интернет»
    await wait(800);
    const b = await connect(srv, 'Lossy', token);
    const m = await b.next(x => x.t === 'match', 4000).catch(() => null);
    expect(m, 'после переподключения матч не возобновился').toBeTruthy();
    expect(m.you).toBe(oldId);
    h.close(); b.close();
  });
  it('смена команды во время матча запрещена', async () => {
    const h = await connect(srv, 'Host');
    await createRoom(h, { mode: 'tdm' });
    h.send({ t: 'start' }); await h.next('match');
    h.send({ t: 'team', team: 1 });
    expect((await h.next('err')).msg).toMatch(/лобби/);
    h.close();
  });

  it('один токен в двух вкладках: новая вкладка перехватывает сеанс, старая отключается', async () => {
    const token = makeToken('twotabs');
    const a = await connect(srv, 'Twin', token);
    const room = await createRoom(a, {});
    const b = await connect(srv, 'Twin', token);
    expect(b.id).toBe(a.id);
    await wait(200);
    expect(a.closed).toBe(true);
    expect(a.closeCode).toBe(4001);
    b.send({ t: 'list' });
    const it = (await b.next('rooms')).list.find(r => r.code === room.code);
    expect(it.players).toBe(1);
    b.close();
  });
});

describe('античит', () => {
  it('гость без токена (или с неверным) не может выбрать закрытый самолёт', async () => {
    const c = new TestClient(srv.ws); await c.opened;
    c.send({ t: 'hello', name: 'Guest', token: 'bad' });
    await c.next('welcome');
    const room = await createRoom(c, {});
    c.send({ t: 'plane', planeId: 'uk_b3' });
    await wait(150);
    const last = c.log.filter(m => m.t === 'room').pop()?.room || room;
    const me = last.players[0];
    expect(DATA.planes.find(p => p.id === me.planeId).cost).toBe(0);
    c.close();
  });

  it('без hello нельзя создать комнату и играть', async () => {
    const c = new TestClient(srv.ws); await c.opened;
    c.send({ t: 'create', settings: {} });
    const r = await c.next(m => m.t === 'room' || m.t === 'err').catch(() => ({ t: 'none' }));
    expect(r.t).not.toBe('room');
    c.close();
  });

  it('клиент не может прислать позицию/здоровье/урон/боезапас — поля игнорируются', async () => {
    const c = await connect(srv, 'Cheater');
    await createRoom(c, {});
    c.send({ t: 'start' }); await c.next('match');
    const s0 = await c.snapshot(s => s.me && s.me.s === 'plane', 6000);
    let seq = 1;
    for (let i = 0; i < 40; i++) {
      c.send({ t: 'in', s: seq++, x: 99999, y: 99999, hp: 99999, vx: 5000, am: [99999], dmg: 1e6, ammo: 1e6, speed: 5000, th: 1, ta: 1 });
      await wait(33);
    }
    c.send({ t: 'damage', target: 'x', amount: 1e9 });
    const s1 = await c.snapshot(s => s.me && s.me.s === 'plane');
    const [x0] = s0.me.pl, [x1, y1, vx1, vy1] = s1.me.pl;
    expect(Math.abs(x1 - x0)).toBeLessThan(800);
    expect(Math.hypot(vx1, vy1)).toBeLessThan(600);
    expect(s1.me.hp).toBeLessThanOrEqual(s1.me.mhp);
    expect(Math.max(...s1.me.am)).toBeLessThan(1000);
    c.close();
  });

  it('ввод чаще нормы не ускоряет самолёт (спидхак)', async () => {
    const run = async perTick => {
      const c = await connect(srv, 'Speed' + perTick);
      await createRoom(c, {});
      c.send({ t: 'start' }); await c.next('match');
      await c.snapshot(s => s.me && s.me.s === 'plane', 6000);
      const a = await c.snapshot(s => s.me && s.me.s === 'plane');
      let seq = 1;
      const iv = setInterval(() => { for (let k = 0; k < perTick; k++) c.send({ t: 'in', s: seq++, th: 1, ta: 1, p: 0 }); }, 33);
      await wait(1500);
      clearInterval(iv);
      const b = await c.snapshot(s => s.me && s.me.s === 'plane');
      c.close();
      const ticksPassed = b.k - a.k;
      return Math.hypot(b.me.pl[0] - a.me.pl[0], b.me.pl[1] - a.me.pl[1]) / ticksPassed;
    };
    const normal = await run(1), fast = await run(4);
    expect(fast).toBeLessThan(normal * 1.25);
  });

  it('прогресс и валюту нельзя подделать сообщениями', async () => {
    const c = await connect(srv, 'Rich');
    c.send({ t: 'profile', profile: { money: 1e9, xp: 1e9, unlocked: DATA.planes.map(p => p.id) } });
    c.send({ t: 'unlock', planeId: 'us_b3' });
    expect((await c.next('err')).msg).toBeTruthy();
    c.send({ t: 'upgrade', planeId: 'us_f1', track: 'engine' });
    c.send({ t: 'upgrade', planeId: 'us_f1', track: 'engine' });
    await wait(200);
    const prof = c.log.filter(m => m.t === 'profile').pop()?.profile;
    if (prof) expect(prof.money).toBeGreaterThanOrEqual(0);
    c.close();
  });

  it('флуд сообщениями приводит к отключению', async () => {
    const c = await connect(srv, 'Flood');
    for (let i = 0; i < 6000; i++) c.send({ t: 'ping', c: i });
    await wait(1500);
    expect(c.closed).toBe(true);
    expect(srv.alive()).toBe(true);
  });

  it('флуд подключениями с одного IP ограничен', async () => {
    const lim = await startServer({ WF_MAX_CONN_PER_IP: '8' });
    const cs = [];
    for (let i = 0; i < 20; i++) { const c = new TestClient(lim.ws); cs.push(c); await c.opened.catch(() => {}); }
    await wait(300);
    const open = cs.filter(c => !c.closed && c.ws.readyState === 1).length;
    expect(open).toBeLessThanOrEqual(8);
    cs.forEach(c => c.terminate());
    await lim.stop();
  });

  it('создание комнат ограничено по частоте', async () => {
    const c = await connect(srv, 'Spawner');
    for (let i = 0; i < 50; i++) c.send({ t: 'create', settings: {} });
    await wait(500);
    const codes = new Set(c.log.filter(m => m.t === 'room').map(m => m.room.code));
    expect(codes.size).toBeLessThanOrEqual(1);
    expect(c.log.some(m => m.t === 'err' && /часто/.test(m.msg))).toBe(true);
    c.close();
  });
});

describe('сохранение прогресса между перезапусками', () => {
  it('опыт и деньги сохраняются после перезапуска сервера', async () => {
    const s1 = await startServer({ WF_TEST_HOOKS: '1' });
    const token = makeToken('persist');
    const c = await connect(s1, 'Saver', token);
    await createRoom(c, {});
    c.send({ t: 'start' }); await c.next('match');
    c.send({ t: '__end' });
    const p = (await c.next('profile', 5000)).profile;
    expect(p.xp).toBeGreaterThan(0);
    c.close();
    await s1.stop('SIGTERM');
    const s2 = await startServer({ PROFILES_FILE: s1.profiles });
    const c2 = await connect(s2, 'Saver', token);
    expect(c2.profile.xp).toBe(p.xp);
    expect(c2.profile.money).toBe(p.money);
    c2.close();
    await s2.stop();
  });
});
