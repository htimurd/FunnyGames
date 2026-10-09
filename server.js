const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = process.env.BOT_USERNAME || '';
const DB_URL = process.env.DATABASE_URL || '';
const ADMIN = 'tg' + (process.env.ADMIN_ID || '8080874290'); // админ определяется только по подписанным данным Telegram
const FILE = path.join(__dirname, 'data.json');
const SECRET = crypto.randomBytes(16).toString('hex');
const MAX_HTML = 400000;

let state = { users: {}, games: {} };
let pool = null;

/* ---------- хранение: Postgres (DATABASE_URL) или файл ---------- */
async function load() {
  if (DB_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('create table if not exists kv(k text primary key, v jsonb not null)');
    const r = await pool.query("select v from kv where k='funnygames'");
    if (r.rows[0]) state = r.rows[0].v;
    console.log('База: Postgres');
  } else {
    if (fs.existsSync(FILE)) { try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {} }
    console.log('База: файл data.json (на бесплатном Render сбрасывается при перезапуске!)');
  }
  state.users = state.users || {}; state.games = state.games || {};
  seed();
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (pool) await pool.query("insert into kv(k,v) values('funnygames',$1) on conflict(k) do update set v=excluded.v", [JSON.stringify(state)]);
      else fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (e) { console.error('save error:', e.message); }
  }, 1500);
}

/* ---------- официальные игры FunnyGames Official ---------- */
const OFFICIAL = [
  { id: 'balloon', file: 'game-balloon.html', title: 'Воздушный шар', icon: '🎈', desc: 'Лети вверх, уворачивайся от птиц и собирай звёзды. Веди шар пальцем или стрелками.' },
  { id: 'snake', file: 'game-snake.html', title: 'Змейка', icon: '🐍', desc: 'Классическая змейка: ешь яблоки, расти и не врезайся. Свайпы или стрелки.' }
];
function seed() {
  state.users.official = Object.assign({ lib: {} }, state.users.official, { id: 'official', name: 'FunnyGames Official', verified: true, official: true });
  for (const o of OFFICIAL) {
    const html = fs.readFileSync(path.join(__dirname, o.file), 'utf8');
    const old = state.games[o.id] || {};
    state.games[o.id] = { plays: 0, adds: 0, created: Date.now(), ...old, id: o.id, title: o.title, icon: o.icon, desc: o.desc, dev: 'official', status: 'published', html };
  }
  save();
}

/* ---------- авторизация через Telegram initData ---------- */
function tgUser(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  p.delete('hash');
  const s = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(s).digest('hex');
  if (h !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
const clean = (s, n) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, n);

function auth(req, res, next) {
  let id, name;
  const t = tgUser(req.get('x-init-data'));
  if (t) { id = 'tg' + t.id; name = clean(t.first_name || t.username, 24) || 'Игрок'; }
  else {
    const g = clean(req.get('x-guest-id'), 40).replace(/[^\w-]/g, '');
    if (!g) return res.status(401).json({ error: 'Нет авторизации' });
    id = 'g' + g;
    try { name = clean(decodeURIComponent(req.get('x-name') || ''), 24); } catch { name = ''; }
    name = name || 'Гость';
  }
  let u = state.users[id];
  if (!u) { u = state.users[id] = { id, name, verified: false, lib: {}, joined: Date.now() }; save(); }
  if (!u.lib) u.lib = {};
  if (u.name !== name) { u.name = name; save(); }
  req.user = u; req.admin = id === ADMIN;
  next();
}

/* ---------- помощники ---------- */
const token = id => crypto.createHmac('sha256', SECRET).update(id).digest('hex').slice(0, 20);
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
function pubGame(g, u, isAdmin) {
  const d = state.users[g.dev] || {};
  const o = { id: g.id, title: g.title, desc: g.desc, icon: g.icon, status: g.status, plays: g.plays || 0, adds: g.adds || 0,
    dev: { id: g.dev, name: d.name || 'Неизвестно', verified: !!d.verified },
    inLib: !!u.lib[g.id], best: (u.lib[g.id] && u.lib[g.id].best) || 0 };
  if (isAdmin || g.dev === u.id) o.t = token(g.id);
  return o;
}

const app = express();
app.use(express.json({ limit: '700kb' }));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.send('ok'));
app.get('/api/config', (_, res) => res.json({ bot: BOT_USERNAME }));

// Игры запускаются в песочнице без сети и без доступа к приложению
app.get('/play/:id', (req, res) => {
  const g = state.games[req.params.id];
  if (!g) return res.status(404).send('Игра не найдена');
  if (g.status !== 'published' && req.query.t !== token(g.id)) return res.status(403).send('Игра на проверке');
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'",
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'
  });
  res.send(g.html);
});

app.use('/api', auth);

app.post('/api/me', (req, res) => {
  const u = req.user;
  res.json({ me: { id: u.id, name: u.name, verified: !!u.verified, admin: req.admin } });
});

/* ---------- магазин и библиотека ---------- */
app.get('/api/games', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = Object.values(state.games).filter(g => g.status === 'published' && (!q || g.title.toLowerCase().includes(q)))
    .sort((a, b) => (b.dev === 'official') - (a.dev === 'official') || (b.adds || 0) - (a.adds || 0))
    .map(g => pubGame(g, req.user, req.admin));
  res.json({ list });
});
app.get('/api/library', (req, res) => {
  const list = Object.keys(req.user.lib).map(id => state.games[id]).filter(g => g && g.status === 'published').map(g => pubGame(g, req.user, req.admin));
  res.json({ list });
});
app.post('/api/lib/add', (req, res) => {
  const g = state.games[req.body.id];
  if (!g || g.status !== 'published') return bad(res, 'Игра не найдена', 404);
  if (!req.user.lib[g.id]) { req.user.lib[g.id] = { best: 0, added: Date.now() }; g.adds = (g.adds || 0) + 1; save(); }
  res.json({ ok: true });
});
app.post('/api/lib/remove', (req, res) => {
  const g = state.games[req.body.id];
  if (req.user.lib[req.body.id]) { delete req.user.lib[req.body.id]; if (g) g.adds = Math.max(0, (g.adds || 1) - 1); save(); }
  res.json({ ok: true });
});
app.post('/api/played', (req, res) => {
  const g = state.games[req.body.id];
  if (g && g.status === 'published' && req.user.lib[g.id]) { g.plays = (g.plays || 0) + 1; save(); }
  res.json({ ok: true });
});
app.post('/api/score', (req, res) => {
  const e = req.user.lib[req.body.id], s = Math.floor(+req.body.score);
  if (!e || !(s >= 0) || s > 1e9) return bad(res, 'Рекорд не принят');
  if (s > e.best) { e.best = s; save(); }
  res.json({ best: e.best });
});

/* ---------- публикация ---------- */
app.get('/api/mine', (req, res) => {
  res.json({ list: Object.values(state.games).filter(g => g.dev === req.user.id).map(g => pubGame(g, req.user, req.admin)) });
});
app.post('/api/publish', (req, res) => {
  const u = req.user, b = req.body;
  const title = clean(b.title, 40), desc = clean(b.desc, 300), html = String(b.html || '');
  const icon = Array.from(String(b.icon || '').replace(/[<>&"'`]/g, '').trim()).slice(0, 2).join('') || '🎮';
  if (title.length < 2) return bad(res, 'Название от 2 символов');
  if (Buffer.byteLength(html) > MAX_HTML) return bad(res, 'Файл больше 400 КБ');
  if (!/<\w/.test(html) || html.length < 50) return bad(res, 'Вставь HTML-код игры целиком');
  const mine = Object.values(state.games).filter(g => g.dev === u.id);
  if (mine.length >= 20) return bad(res, 'Лимит 20 игр');
  if (mine.filter(g => g.status === 'pending').length >= 3) return bad(res, 'Уже 3 игры ждут проверки');
  const id = 'g' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const instant = req.admin || u.verified;
  state.games[id] = { id, title, desc, icon, dev: u.id, status: instant ? 'published' : 'pending', plays: 0, adds: 0, created: Date.now(), html };
  save(); res.json({ status: state.games[id].status });
});
app.post('/api/game/delete', (req, res) => {
  const g = state.games[req.body.id];
  if (!g || OFFICIAL.some(o => o.id === g.id)) return bad(res, 'Игру нельзя удалить');
  if (g.dev !== req.user.id && !req.admin) return bad(res, 'Нет прав', 403);
  delete state.games[g.id]; save(); res.json({ ok: true });
});

/* ---------- админ ---------- */
const needAdmin = (req, res, next) => req.admin ? next() : bad(res, 'Только для админа', 403);
app.get('/api/admin/pending', needAdmin, (req, res) => {
  res.json({ list: Object.values(state.games).filter(g => g.status === 'pending').map(g => pubGame(g, req.user, true)) });
});
app.post('/api/admin/review', needAdmin, (req, res) => {
  const g = state.games[req.body.id];
  if (!g || g.status !== 'pending') return bad(res, 'Заявка не найдена', 404);
  if (req.body.approve) g.status = 'published'; else delete state.games[g.id];
  save(); res.json({ ok: true });
});
app.get('/api/admin/users', needAdmin, (req, res) => {
  const q = String(req.query.q || '').toLowerCase(), cnt = {};
  for (const g of Object.values(state.games)) cnt[g.dev] = (cnt[g.dev] || 0) + 1;
  const list = Object.values(state.users).filter(u => !u.official && (!q || u.name.toLowerCase().includes(q) || u.id.includes(q)))
    .map(u => ({ id: u.id, name: u.name, verified: !!u.verified, games: cnt[u.id] || 0 }))
    .sort((a, b) => b.verified - a.verified || b.games - a.games).slice(0, 30);
  res.json({ list });
});
app.post('/api/admin/verify', needAdmin, (req, res) => {
  const u = state.users[req.body.id];
  if (!u || u.official) return bad(res, 'Пользователь не найден', 404);
  u.verified = !!req.body.value; save(); res.json({ ok: true });
});

load().then(() => app.listen(PORT, () => console.log('FunnyGames на порту ' + PORT)))
  .catch(e => { console.error('Не удалось запустить:', e.message); process.exit(1); });
      
