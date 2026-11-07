// Обёртка WebSocket с автопереподключением.
export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.queue = [];
    this.rtt = 0;
    this.connect();
    setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.onStatus('connecting');
    this.ws.onopen = () => {
      this.onStatus('open');
      for (const m of this.queue) this.ws.send(m);
      this.queue = [];
    };
    this.ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') { this.rtt = performance.now() - m.c; return; }
      this.onMessage(m);
    };
    this.ws.onclose = e => {
      if (e.code === 4001) { this.stopped = true; this.onStatus('replaced'); return; }   // вход с другой вкладки/устройства
      this.onStatus('closed');
      if (!this.stopped) setTimeout(() => this.connect(), e.code === 1013 ? 5000 : 1500);
    };
  }
  get open() { return this.ws && this.ws.readyState === 1; }
  send(m) {
    const s = JSON.stringify(m);
    if (this.open) this.ws.send(s);
    else if (m.t !== 'in' && m.t !== 'ping') this.queue.push(s);
  }
}
