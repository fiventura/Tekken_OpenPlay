'use strict';
/*
 * Tekken Open Play queue server. Zero dependencies: needs only Node 18+.
 *   - Public:  GET /, GET /api/state, GET /api/events (live updates, server-sent events)
 *   - Admin:   POST /api/admin/login {pin} -> token, POST /api/admin/action, GET /api/admin/export
 * All queue/table logic lives here, so seating happens even when no admin page is open.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const INDEX = path.join(__dirname, 'public', 'index.html');

let PIN = process.env.ADMIN_PIN;
if (!PIN) {
  PIN = String(crypto.randomInt(100000, 1000000));
  console.log('[setup] ADMIN_PIN is not set. Temporary admin PIN for this run: ' + PIN);
}

/* ---------------- state ---------------- */
const DEF = { eventName: 'Tekken Open Play', tableCount: 4, firstTo: 2, winnerStays: true, maxStreak: 3,
  autoAssign: true, ptsWin: 3, ptsLoss: 1, matchMins: 8 };
const STATUSES = ['queued', 'playing', 'away'];
const now = () => Date.now();
const newTable = (n) => ({ id: 't' + String(n).padStart(2, '0'), n, p1: null, p2: null, s1: 0, s2: 0, holder: null, streak: 0, startedAt: null });

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function cleanConfig(c) {
  c = c || {};
  return {
    eventName: str(c.eventName, 60) || DEF.eventName,
    tableCount: int(c.tableCount, 1, 24, DEF.tableCount),
    firstTo: int(c.firstTo, 1, 5, DEF.firstTo),
    winnerStays: c.winnerStays !== false && c.winnerStays !== 'false' && c.winnerStays !== 0,
    maxStreak: int(c.maxStreak, 0, 20, DEF.maxStreak),
    autoAssign: c.autoAssign !== false && c.autoAssign !== 'false' && c.autoAssign !== 0,
    ptsWin: int(c.ptsWin, 0, 20, DEF.ptsWin),
    ptsLoss: int(c.ptsLoss, 0, 20, DEF.ptsLoss),
    matchMins: int(c.matchMins, 1, 60, DEF.matchMins),
  };
}
function blank() {
  const s = { config: cleanConfig(DEF), players: [], tables: [], matches: [], seq: 0 };
  for (let i = 1; i <= s.config.tableCount; i++) s.tables.push(newTable(i));
  return s;
}
/* Used for the saved file and for imported backups: never trust the shape. */
function sanitize(j) {
  const s = blank();
  if (!j || typeof j !== 'object') return s;
  s.config = cleanConfig(j.config);
  s.players = (Array.isArray(j.players) ? j.players : []).slice(0, 2000).map((p) => ({
    id: str(p.id, 40) || 'p_' + crypto.randomBytes(4).toString('hex'),
    name: str(p.name, 20) || 'Player', character: str(p.character, 24),
    status: STATUSES.includes(p.status) ? p.status : 'queued',
    queuedAt: Number(p.queuedAt) || now(), createdAt: Number(p.createdAt) || now(), demo: !!p.demo,
  }));
  const tables = (Array.isArray(j.tables) ? j.tables : []).slice(0, 24).map((t) => ({
    id: 't' + String(int(t.n, 1, 24, 1)).padStart(2, '0'), n: int(t.n, 1, 24, 1),
    p1: str(t.p1, 40) || null, p2: str(t.p2, 40) || null, s1: int(t.s1, 0, 9, 0), s2: int(t.s2, 0, 9, 0),
    holder: str(t.holder, 40) || null, streak: int(t.streak, 0, 99, 0), startedAt: Number(t.startedAt) || null,
  }));
  s.tables = tables.length ? tables.sort((a, b) => a.n - b.n) : s.tables;
  s.matches = (Array.isArray(j.matches) ? j.matches : []).slice(-5000).map((m) => ({
    id: int(m.id, 0, 1e9, 0), at: Number(m.at) || now(), table: int(m.table, 1, 24, 1), w: str(m.w, 40), l: str(m.l, 40),
    wn: str(m.wn, 20), ln: str(m.ln, 20), ws: int(m.ws, 0, 9, 0), ls: int(m.ls, 0, 9, 0), demo: !!m.demo,
  }));
  s.seq = Math.max(int(j.seq, 0, 1e9, 0), ...s.matches.map((m) => m.id), 0);
  const ids = new Set(s.players.map((p) => p.id));
  s.tables.forEach((t) => {
    ['p1', 'p2'].forEach((k) => { if (t[k] && !ids.has(t[k])) t[k] = null; });
    if (t.holder && !ids.has(t.holder)) { t.holder = null; t.streak = 0; }
  });
  s.players.forEach((p) => { p.status = s.tables.some((t) => t.p1 === p.id || t.p2 === p.id) ? 'playing' : (p.status === 'playing' ? 'queued' : p.status); });
  return s;
}
function load() {
  try { return sanitize(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { return blank(); }
}
let S = load();

let saveTimer = null;
function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { console.error('[save] failed:', e.message); }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 300); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { writeNow(); process.exit(0); });

/* ---------------- queue + table logic ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m, c) => { throw new HttpError(c || 400, m); };
const P = (id) => S.players.find((p) => p.id === id);
const T = (id) => S.tables.find((t) => t.id === id);
const queued = () => S.players.filter((p) => p.status === 'queued').sort((a, b) => (a.queuedAt - b.queuedAt) || a.name.localeCompare(b.name));
const headTime = () => { const q = queued(); return (q.length ? q[0].queuedAt : now()) - 1; };
const needT = (id) => T(id) || bad('Unknown table', 404);
const needP = (id) => P(id) || bad('Unknown player', 404);
const needSlot = (s) => (s === 'p1' || s === 'p2') ? s : bad('Bad seat');

function seat(t, slot, p) {
  if (t[slot] || p.status !== 'queued') return false;
  const other = slot === 'p1' ? t.p2 : t.p1;
  t[slot] = p.id; p.status = 'playing';
  if (other) { t.s1 = 0; t.s2 = 0; t.startedAt = now(); }
  return true;
}
function fill() {
  if (!S.config.autoAssign) return;
  const order = S.tables.slice().sort((a, b) => {
    const ao = (a.p1 ? 1 : 0) + (a.p2 ? 1 : 0), bo = (b.p1 ? 1 : 0) + (b.p2 ? 1 : 0);
    return ((bo === 1) - (ao === 1)) || a.n - b.n;   // tables with a waiting winner first
  });
  for (const t of order) for (const slot of ['p1', 'p2']) {
    if (t[slot]) continue;
    const nx = queued()[0]; if (!nx) return;
    seat(t, slot, nx);
  }
}
function unseat(t, slot) {
  const p = P(t[slot]); if (!p) { t[slot] = null; return; }
  p.status = 'queued'; p.queuedAt = headTime();
  t[slot] = null; t.s1 = 0; t.s2 = 0; t.startedAt = null;
  if (t.holder === p.id) { t.holder = null; t.streak = 0; }
}
function finish(t, wslot) {
  if (!t.p1 || !t.p2) bad('That table needs two players first.');
  const lslot = wslot === 'p1' ? 'p2' : 'p1', wp = P(t[wslot]), lp = P(t[lslot]);
  let ws = wslot === 'p1' ? t.s1 : t.s2; const ls = lslot === 'p1' ? t.s1 : t.s2;
  if (ws <= ls) ws = S.config.firstTo;
  S.matches.push({ id: ++S.seq, at: now(), table: t.n, w: wp.id, l: lp.id, wn: wp.name, ln: lp.name, ws, ls, demo: !!(wp.demo && lp.demo) });
  if (S.matches.length > 5000) S.matches.shift();
  const streak = (t.holder === wp.id ? t.streak : 0) + 1;
  const stay = S.config.winnerStays && (S.config.maxStreak === 0 || streak < S.config.maxStreak);
  lp.status = 'queued'; lp.queuedAt = now();
  if (stay) {
    t[lslot] = null; t.s1 = 0; t.s2 = 0; t.holder = wp.id; t.streak = streak; t.startedAt = null;
  } else {
    wp.status = 'queued'; wp.queuedAt = now() + 1;
    t.p1 = null; t.p2 = null; t.s1 = 0; t.s2 = 0; t.holder = null; t.streak = 0; t.startedAt = null;
  }
  fill();
  return wp.name + ' wins on Table ' + t.n;
}
function applyTables(n) {
  for (let i = 1; i <= n; i++) if (!S.tables.some((t) => t.n === i)) S.tables.push(newTable(i));
  S.tables.filter((t) => t.n > n).forEach((t) => { unseat(t, 'p1'); unseat(t, 'p2'); });
  S.tables = S.tables.filter((t) => t.n <= n).sort((a, b) => a.n - b.n);
}
function move(p, dir) {
  if (p.status !== 'queued') return;
  if (dir === 'front') { p.queuedAt = headTime(); return; }
  const q = queued(), i = q.findIndex((x) => x.id === p.id), j = i + dir;
  if (i < 0 || j < 0 || j >= q.length) return;
  const a = q[i], b = q[j];
  if (a.queuedAt === b.queuedAt) { a.queuedAt += dir < 0 ? -1 : 1; return; }
  [a.queuedAt, b.queuedAt] = [b.queuedAt, a.queuedAt];
}
const DEMO = [['Kuro', 'Kazuya'], ['Mika', 'Nina'], ['Dante', 'Paul'], ['Rin', 'Xiaoyu'], ['Ghost', 'Yoshimitsu'], ['Sol', 'Jin'], ['Vex', 'Lars'], ['Nova', 'Reina']];
function demoAdd() {
  DEMO.forEach(([name, character], i) => {
    const id = 'demo_' + (i + 1); if (P(id)) return;
    S.players.push({ id, name, character, status: 'queued', queuedAt: now() + i, createdAt: now(), demo: true });
  });
  const R = [[0, 1, 2, 1], [2, 3, 2, 0], [0, 2, 2, 1], [4, 5, 2, 1], [0, 4, 2, 0], [1, 3, 2, 1], [6, 7, 2, 0], [5, 7, 2, 1], [0, 6, 2, 1], [2, 5, 2, 0]];
  R.forEach(([a, b, ws, ls], k) => S.matches.push({ id: ++S.seq, at: now() - 3600e3 + k * 300e3, table: (k % S.tables.length) + 1,
    w: 'demo_' + (a + 1), l: 'demo_' + (b + 1), wn: DEMO[a][0], ln: DEMO[b][0], ws, ls, demo: true }));
  S.matches.sort((x, y) => x.at - y.at);
  fill();
}
function demoClear() {
  S.tables.forEach((t) => ['p1', 'p2'].forEach((s) => { if (P(t[s]) && P(t[s]).demo) {
    const id = t[s]; t[s] = null; t.s1 = 0; t.s2 = 0; t.startedAt = null; if (t.holder === id) { t.holder = null; t.streak = 0; } } }));
  S.players = S.players.filter((p) => !p.demo);
  S.matches = S.matches.filter((m) => !m.demo);
  fill();
}

const ACTIONS = {
  addPlayer(a) {
    const name = str(a.name, 20); if (name.length < 2) bad('Use a tag with at least 2 characters.');
    if (S.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) bad('That tag is already in use.');
    if (S.players.length >= 2000) bad('Too many players. Remove some first.');
    S.players.push({ id: 'p_' + crypto.randomBytes(5).toString('hex'), name, character: str(a.character, 24), status: 'queued', queuedAt: now(), createdAt: now(), demo: false });
    fill(); return name + ' added to the queue';
  },
  removePlayer(a) {
    const p = needP(a.id);
    S.tables.forEach((t) => ['p1', 'p2'].forEach((s) => { if (t[s] === p.id) { t[s] = null; t.s1 = 0; t.s2 = 0; t.startedAt = null; if (t.holder === p.id) { t.holder = null; t.streak = 0; } } }));
    S.players = S.players.filter((x) => x.id !== p.id); fill();
  },
  setStatus(a) {
    const p = needP(a.id); if (p.status === 'playing') bad('Send them back from the table first.');
    if (a.status === 'away') p.status = 'away'; else if (a.status === 'queued') { p.status = 'queued'; p.queuedAt = now(); } else bad('Bad status');
    fill();
  },
  move(a) { move(needP(a.id), a.dir === 'front' ? 'front' : a.dir < 0 ? -1 : 1); },
  seat(a) { const t = needT(a.tableId), p = needP(a.playerId); if (!seat(t, needSlot(a.slot), p)) bad('That seat is taken.'); },
  seatNext(a) { const t = needT(a.tableId), nx = queued()[0]; if (!nx) return; seat(t, t.p1 ? 'p2' : 'p1', nx); },
  unseat(a) { unseat(needT(a.tableId), needSlot(a.slot)); },
  clearTable(a) { const t = needT(a.tableId); unseat(t, 'p1'); unseat(t, 'p2'); t.holder = null; t.streak = 0; return 'Table cleared'; },
  score(a) {
    const t = needT(a.tableId), key = needSlot(a.slot) === 'p1' ? 's1' : 's2', i = int(a.i, 0, 8, 0);
    if (!t.p1 || !t.p2) return; t[key] = t[key] === i + 1 ? i : i + 1;
  },
  win(a) { return finish(needT(a.tableId), needSlot(a.slot)); },
  settings(a) {
    S.config = cleanConfig(a.config); applyTables(S.config.tableCount); fill(); return 'Settings saved';
  },
  demoAdd() { demoAdd(); return 'Demo data added'; },
  demoClear() { demoClear(); return 'Demo data removed'; },
  resetBoard() { S.matches = []; return 'Leaderboard reset'; },
  clearQueue() {
    S.players = S.players.filter((p) => p.status === 'playing'); return 'Queue cleared';
  },
  import(a) { S = sanitize(a.state); return 'Backup restored'; },
};

/* ---------------- public view ---------------- */
function board() {
  const c = S.config, m = new Map();
  const get = (id, name) => {
    if (!m.has(id)) m.set(id, { id, name, w: 0, l: 0, pts: 0, cur: 0, best: 0 });
    const r = m.get(id), p = P(id); r.name = (p && p.name) || name || r.name; return r;
  };
  S.matches.forEach((x) => {
    const w = get(x.w, x.wn), l = get(x.l, x.ln);
    w.w++; w.pts += c.ptsWin; w.cur++; w.best = Math.max(w.best, w.cur);
    l.l++; l.pts += c.ptsLoss; l.cur = 0;
  });
  return [...m.values()].sort((a, b) => (b.pts - a.pts) || (b.w / (b.w + b.l) - a.w / (a.w + a.l)) || (b.w - a.w) || a.name.localeCompare(b.name));
}
let cache = null;
function snapshot() {
  if (!cache) cache = JSON.stringify({
    config: S.config, players: S.players, tables: S.tables, board: board(),
    recent: S.matches.slice(-8).reverse(), matchCount: S.matches.length, serverTime: now(),
  });
  return cache;
}
const clients = new Set();
function changed() {
  cache = null; save();
  const msg = 'data: ' + snapshot() + '\n\n';
  clients.forEach((res) => { try { res.write(msg); } catch (e) { clients.delete(res); } });
}
setInterval(() => { clients.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } }); }, 25000);
setInterval(() => { cache = null; }, 60000);   // keeps serverTime fresh for the next snapshot

/* ---------------- auth ---------------- */
const sessions = new Map();           // token -> expiry
const attempts = new Map();           // ip -> {n, reset}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function authed(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || ''); if (!m) return false;
  const exp = sessions.get(m[1]); if (!exp) return false;
  if (exp < now()) { sessions.delete(m[1]); return false; }
  return true;
}
setInterval(() => { const t = now(); sessions.forEach((e, k) => { if (e < t) sessions.delete(k); }); attempts.forEach((a, k) => { if (a.reset < t) attempts.delete(k); }); }, 600000);

/* ---------------- http ---------------- */
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC, extra || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new HttpError(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (req.method === 'GET' && p === '/api/state') { cache = null; return send(res, 200, snapshot()); }
    if (req.method === 'GET' && p === '/api/events') {
      if (clients.size > 3000) return json(res, 503, { error: 'Busy' });
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, SEC));
      cache = null; res.write('retry: 3000\n\ndata: ' + snapshot() + '\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST' && p === '/api/admin/login') {
      const ip = ipOf(req), a = attempts.get(ip) || { n: 0, reset: now() + 600000 };
      if (a.reset < now()) { a.n = 0; a.reset = now() + 600000; }
      if (a.n >= 8) return json(res, 429, { error: 'Too many attempts' });
      const body = await readBody(req, 2000);
      if (crypto.timingSafeEqual(sha(body.pin), sha(PIN))) {
        const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, now() + 12 * 3600e3);
        attempts.delete(ip); return json(res, 200, { token });
      }
      a.n++; attempts.set(ip, a); return json(res, 401, { error: 'Wrong PIN' });
    }
    if (p === '/api/admin/action' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { error: 'Not signed in' });
      const body = await readBody(req, 2 * 1024 * 1024), fn = Object.prototype.hasOwnProperty.call(ACTIONS, body.type) && ACTIONS[body.type];
      if (!fn) return json(res, 400, { error: 'Unknown action' });
      const msg = fn(body) || null; changed();
      return json(res, 200, { ok: true, msg, state: JSON.parse(snapshot()) });
    }
    if (p === '/api/admin/export' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: 'Not signed in' });
      return send(res, 200, JSON.stringify(S, null, 1), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tekken-queue-backup.json"' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(e); json(res, 500, { error: 'Server error' });
  }
});
server.listen(PORT, () => console.log('Tekken queue listening on port ' + PORT));
