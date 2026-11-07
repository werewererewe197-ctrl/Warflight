// Карты: рельеф, вода, аэродромы, объекты, облака. Данные детерминированы (общие для клиента и сервера).

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MAPS = {
  islands: {
    id: 'islands', name: 'Коралловый архипелаг', desc: 'Море с островами. Короткая карта, падение в воду смертельно.',
    width: 10000, seed: 11, theme: 'sea',
    sky: ['#2f6db5', '#9fd0f0'], far: '#6f9cbf', mid: '#5d8a6a', ground: '#7a8a4a', dirt: '#b8a070', water: '#2b6fa0',
    points: [[0, -220], [300, -140], [560, 25], [700, 45], [2150, 45], [2350, 15], [2600, -160], [3600, -190], [3900, -40],
      [4100, 50], [4350, 150], [4600, 80], [4800, 70], [5300, 70], [5550, 160], [5850, 60], [6100, -60], [6400, -190],
      [7400, -170], [7650, 15], [7850, 45], [9300, 45], [9440, 25], [9700, -140], [10000, -220]],
    airfields: [{ team: 0, x0: 900, x1: 1850 }, { team: 1, x0: 8150, x1: 9100 }],
    objects: [
      { type: 'hq', team: 0, x: 780 }, { type: 'hq', team: 1, x: 9220 },
      { type: 'aa', team: 0, x: 720 }, { type: 'aa', team: 0, x: 2080 }, { type: 'hangar', team: 0, x: 1960 },
      { type: 'aa', team: 1, x: 9280 }, { type: 'aa', team: 1, x: 7920 }, { type: 'hangar', team: 1, x: 8040 },
      { type: 'artillery', team: 0, x: 2120 }, { type: 'artillery', team: 1, x: 7880 },
      { type: 'building', x: 4850 }, { type: 'building', x: 4950 }, { type: 'building', x: 5060 }, { type: 'building', x: 5170 },
      { type: 'aa', team: -1, x: 5260 },
    ],
    tankSpawns: [720, 9280],
  },
  plains: {
    id: 'plains', name: 'Поля и город', desc: 'Холмистые поля с городом посередине. Танковые сражения.',
    width: 13000, seed: 23, theme: 'fields',
    sky: ['#3d78c0', '#d6e8f5'], far: '#8aa6c4', mid: '#6f9358', ground: '#5f8a3a', dirt: '#8a6a40', water: '#3a78a8',
    points: [[0, 120], [400, 70], [700, 60], [2200, 60], [2600, 110], [3200, 180], [3700, 95], [4300, 70], [5000, 60],
      [6300, 60], [6500, 20], [6650, -30], [6800, -30], [6950, 20], [7100, 60], [8200, 60], [8800, 90], [9400, 170],
      [9900, 90], [10600, 60], [12300, 60], [12600, 70], [13000, 120]],
    airfields: [{ team: 0, x0: 900, x1: 2000 }, { team: 1, x0: 11000, x1: 12100 }],
    objects: [
      { type: 'hq', team: 0, x: 560 }, { type: 'hq', team: 1, x: 12440 },
      { type: 'aa', team: 0, x: 800 }, { type: 'aa', team: 0, x: 2150 }, { type: 'hangar', team: 0, x: 2080 }, { type: 'hangar', team: 0, x: 700 },
      { type: 'aa', team: 1, x: 12200 }, { type: 'aa', team: 1, x: 10850 }, { type: 'hangar', team: 1, x: 10920 }, { type: 'hangar', team: 1, x: 12300 },
      { type: 'artillery', team: 0, x: 2350 }, { type: 'artillery', team: 0, x: 4400 },
      { type: 'artillery', team: 1, x: 10650 }, { type: 'artillery', team: 1, x: 8600 },
      { type: 'tank', team: 0, x: 2700 }, { type: 'tank', team: 1, x: 10300 },
      ...[5100, 5200, 5310, 5420, 5530, 5650, 5760, 5880, 6000, 6120, 7200, 7320, 7440, 7560, 7690, 7810, 7940].map(x => ({ type: 'building', x })),
      { type: 'aa', team: -1, x: 6200 },
    ],
    tankSpawns: [560, 12440],
  },
  mountains: {
    id: 'mountains', name: 'Горный перевал', desc: 'Длинная карта с высокими хребтами. Нужно набирать высоту.',
    width: 15000, seed: 37, theme: 'mountains',
    sky: ['#26508f', '#c7d9ea'], far: '#7d8ea8', mid: '#5f6f6a', ground: '#6a7a50', dirt: '#7a6a5a', water: '#3a6a90',
    points: [[0, 500], [300, 300], [600, 120], [800, 100], [2000, 100], [2300, 160], [2800, 380], [3300, 520], [3800, 420],
      [4300, 650], [4800, 900], [5200, 760], [5700, 1000], [6300, 1350], [6800, 1150], [7300, 1450], [7800, 1200],
      [8300, 1380], [8800, 1050], [9400, 920], [9900, 660], [10400, 780], [11000, 480], [11600, 380], [12200, 200],
      [12700, 100], [14200, 100], [14400, 120], [14700, 300], [15000, 500]],
    airfields: [{ team: 0, x0: 950, x1: 1900 }, { team: 1, x0: 12900, x1: 13850 }],
    objects: [
      { type: 'hq', team: 0, x: 730 }, { type: 'hq', team: 1, x: 14270 },
      { type: 'aa', team: 0, x: 860 }, { type: 'aa', team: 0, x: 2060 }, { type: 'hangar', team: 0, x: 1980 },
      { type: 'aa', team: 1, x: 14140 }, { type: 'aa', team: 1, x: 12780 }, { type: 'hangar', team: 1, x: 12870 },
      { type: 'artillery', team: 0, x: 2200 }, { type: 'artillery', team: 1, x: 12500 },
      { type: 'aa', team: 0, x: 4800 }, { type: 'aa', team: 1, x: 10200 },
      { type: 'building', x: 7280 }, { type: 'building', x: 7360 }, { type: 'aa', team: -1, x: 7320 },
      { type: 'tank', team: 0, x: 2400 }, { type: 'tank', team: 1, x: 12450 },
    ],
    tankSpawns: [730, 14270],
  },
};

const STEP = 8;
const cache = {};

// Строит карту рельефа (кешируется).
export function getTerrain(mapId) {
  if (cache[mapId]) return cache[mapId];
  const m = MAPS[mapId] || MAPS.islands;
  const n = Math.ceil(m.width / STEP) + 2;
  const h = new Float32Array(n);
  const pts = m.points;
  const r = rng(m.seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  for (let i = 0; i < n; i++) {
    const x = i * STEP;
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1][0] < x) k++;
    const [x0, h0] = pts[k], [x1, h1] = pts[k + 1];
    const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0 || 1)));
    const s = (1 - Math.cos(t * Math.PI)) / 2;
    let y = h0 + (h1 - h0) * s;
    // мелкий детерминированный шум рельефа (на возвышенностях больше)
    const amp = y > 0 ? Math.min(40, 6 + y * 0.04) : 0;
    y += amp * (Math.sin(x * 0.011 + ph[0]) * 0.5 + Math.sin(x * 0.027 + ph[1]) * 0.3 + Math.sin(x * 0.061 + ph[2]) * 0.2);
    h[i] = y;
  }
  // аэродромы и объекты — ровные площадки
  const flatten = (x0, x1) => {
    const i0 = Math.max(0, Math.floor(x0 / STEP)), i1 = Math.min(n - 1, Math.ceil(x1 / STEP));
    let avg = 0; for (let i = i0; i <= i1; i++) avg += h[i]; avg /= (i1 - i0 + 1);
    avg = Math.max(avg, 8);
    for (let i = i0; i <= i1; i++) h[i] = avg;
    // плавный переход к окружающему рельефу
    const B = 10;
    for (let k = 1; k <= B; k++) {
      const t = k / (B + 1), s = (1 - Math.cos(t * Math.PI)) / 2;
      if (i0 - k >= 0) h[i0 - k] = avg + (h[i0 - k] - avg) * s;
      if (i1 + k < n) h[i1 + k] = avg + (h[i1 + k] - avg) * s;
    }
    return avg;
  };
  for (const a of m.airfields) a.h = flatten(a.x0 - 40, a.x1 + 40);
  for (const o of m.objects) if (o.type !== 'tank') flatten(o.x - 30, o.x + 30);

  const clouds = [];
  const cr = rng(m.seed * 7 + 3);
  const nc = Math.round(m.width / 900);
  for (let i = 0; i < nc; i++) {
    const w = 260 + cr() * 420;
    const x = (i + 0.2 + cr() * 0.6) * (m.width / nc);
    let base = 0;
    for (let xx = x - w / 2; xx <= x + w / 2; xx += 50) base = Math.max(base, sample(h, xx));
    clouds.push({ x, y: Math.max(base + 350, 650 + cr() * 1300), w, h: 90 + cr() * 90, seed: Math.floor(cr() * 1e6) });
  }

  const terrain = {
    map: m, width: m.width, heights: h, step: STEP, clouds,
    ground: x => { const v = sample(h, x); return v < 0 ? 0 : v; },   // поверхность (вода = 0)
    raw: x => sample(h, x),
    water: x => sample(h, x) < 0,
    airfieldAt(x, y) {
      for (const a of m.airfields) if (x >= a.x0 && x <= a.x1 && (y === undefined || y < a.h + 40)) return a;
      return null;
    },
    inCloud(x, y) {
      for (const c of clouds) {
        const dx = (x - c.x) / (c.w * 0.5), dy = (y - c.y) / (c.h * 0.6);
        if (dx * dx + dy * dy < 1) return true;
      }
      return false;
    },
  };
  cache[mapId] = terrain;
  return terrain;
}

function sample(h, x) {
  const f = x / STEP;
  let i = Math.floor(f);
  if (i < 0) return h[0];
  if (i >= h.length - 1) return h[h.length - 1];
  const t = f - i;
  return h[i] * (1 - t) + h[i + 1] * t;
}
