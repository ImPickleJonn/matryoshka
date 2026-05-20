// Matryoshka — Express server with Telegram Stars IAP, leaderboard, and
// bot notifications. Single-file frontend (index.html); server only handles
// money flow, score submission, state sync, and outbound notifications.
//
// Mirrors Fat Stack's server architecture: lean v0.1 — tournament + share
// cards can be layered in once the game itself is validated.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// Purchase notification → shared pickle-notif-bot. No-op unless both env vars
// are set, so this is safe to deploy before the notif bot exists.
const NOTIF_BOT_URL = process.env.NOTIF_BOT_URL || '';
const NOTIF_SECRET  = process.env.NOTIF_SECRET || '';
const NOTIF_GAME_ID = 'matryoshka';
function notifyPurchase(info) {
  if (!NOTIF_BOT_URL || !NOTIF_SECRET) return;
  try {
    fetch(NOTIF_BOT_URL.replace(/\/+$/, '') + '/api/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-notif-key': NOTIF_SECRET },
      body: JSON.stringify({
        game: NOTIF_GAME_ID,
        sku: info.sku,
        stars: info.stars,
        userId: info.userId,
        username: info.username,
        ts: Date.now(),
      }),
    }).catch(() => {});
  } catch (_e) {}
}

const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)
  : null;

app.use(express.json({ limit: '512kb' }));

// ============ Persistent state ============
// Render Starter has ephemeral disk by default. To survive redeploys, attach
// a Render Disk at /data (see render.yaml). Local dev falls back to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');

let users = {};
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { console.error('[users] load failed:', e.message); return {}; }
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); }
  catch (e) { console.error('[users] save failed:', e.message); }
}

// Whitelisted state fields. Anything outside this list is dropped server-side
// so a malicious client can't set fake state.
const SYNC_FIELDS = [
  'gems', 'revives', 'previews', 'undos', 'shieldDays',
  'hammers', 'shakes', 'rainbows',
  'skins', 'activeSkin',
  'lastSpinYMD', 'spinCount',
  'xp', 'highestTierSeen',
  'streak', 'lastPlayedYMD',
  'best',
  'totalGamesEver', 'totalMergesEver', 'totalIapsEver',
  'bestTierEver', 'bestComboEver',
  'chestDay', 'chestClaimedYMD',
  'spinClaimedYMD', 'lastSpinResult',
  'gamesPlayedToday', 'gamesPlayedYMD',
  'lastDailyYMD', 'dailyBestToday', 'dailyYMD',
  'missions', 'achievements',
  'battlePassUntil',
  'firstSeenAt', 'welcomed',
];

function loadLeaderboard() {
  try {
    if (!fs.existsSync(LEADERBOARD_FILE)) return { regular: [], daily: {} };
    const obj = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    return {
      regular: Array.isArray(obj.regular) ? obj.regular : [],
      daily:   (obj.daily && typeof obj.daily === 'object') ? obj.daily : {},
    };
  } catch (e) { return { regular: [], daily: {} }; }
}
function saveLeaderboard(lb) {
  try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(lb)); }
  catch (e) {}
}
let leaderboard = loadLeaderboard();
users = loadUsers();
console.log('[boot] users=' + Object.keys(users).length + ' lb-regular=' + leaderboard.regular.length);

// ============ Leaderboard seeding ============
// RU-heavy fake-player pool with fixed all-time-best scores. Today's daily
// score is always a fraction of that ceiling, so a player on the daily board
// never exceeds their all-time best — feels coherent.
const FAKE_PLAYER_NAMES = [
  'Vladimir', 'Olga', 'Dmitry', 'Tatiana', 'Sergey', 'Anna', 'Pavel',
  'Elena', 'Igor', 'Natasha', 'Maria', 'Andrei', 'Lena', 'Mikhail',
  'Yuri', 'Nikita', 'Kate', 'Boris', 'Sasha', 'Vika', 'Roman', 'Daria',
  'Artyom', 'Polina', 'Liza', 'Kostya', 'Yulia', 'Petr', 'Slava', 'Vova',
  'Ksenia', 'Marina', 'Inga', 'Galina', 'Lyosha', 'Kira', 'Sonya',
  'David', 'Sarah', 'Emma', 'John', 'Sophie', 'Liam', 'Ava', 'Noah',
  'Mia', 'James', 'Olivia', 'Lucas', 'Zoe', 'Felix', 'Nora', 'Henry',
  '🪆 Babushka', '⚡ Tsarina', '💎 Zara', '🌹 Roza', '🎀 Veronika',
  'DollMaster', 'MergeQueen', 'StackBoyar', 'NestKing', 'WoodWizard',
  'KremlinKid', 'SamovarSam', 'GoldenDoll', 'ВолжскийВетер', 'СибирскийМороз',
  'Tower', 'Beacon', 'Forge', 'Rift', 'Echo',
  'Spark', 'Nova', 'Quasar', 'Aria', 'Mira',
];
let FAKE_PLAYERS = [];
function buildFakePlayers() {
  if (FAKE_PLAYERS.length > 0) return;
  for (let i = 0; i < FAKE_PLAYER_NAMES.length; i++) {
    let allTimeBest;
    if (i < 3)       allTimeBest = 8000 + Math.floor(Math.random() * 4500);   // elites 8k-12.5k
    else if (i < 10) allTimeBest = 4500 + Math.floor(Math.random() * 3500);   // pros 4.5k-8k
    else if (i < 30) allTimeBest = 2000 + Math.floor(Math.random() * 2500);   // mid 2k-4.5k
    else if (i < 60) allTimeBest =  700 + Math.floor(Math.random() * 1300);   // casual 700-2k
    else             allTimeBest =  200 + Math.floor(Math.random() * 500);    // tail 200-700
    FAKE_PLAYERS.push({ uid: -(1000 + i), name: FAKE_PLAYER_NAMES[i], allTimeBest });
  }
  FAKE_PLAYERS.sort((a, b) => b.allTimeBest - a.allTimeBest);
}
function purgeLeaderboardSeeds() {
  leaderboard.regular = leaderboard.regular.filter(e => e.uid >= 0);
  for (const ymd of Object.keys(leaderboard.daily)) {
    leaderboard.daily[ymd] = leaderboard.daily[ymd].filter(e => e.uid >= 0);
    if (leaderboard.daily[ymd].length === 0) delete leaderboard.daily[ymd];
  }
}
function seedLeaderboardIfEmpty() {
  buildFakePlayers();
  const TARGET_REGULAR = 80;
  if (leaderboard.regular.length < TARGET_REGULAR) {
    const existingUids = new Set(leaderboard.regular.map(e => e.uid));
    const entries = leaderboard.regular.slice();
    for (const p of FAKE_PLAYERS) {
      if (entries.length >= TARGET_REGULAR) break;
      if (existingUids.has(p.uid)) continue;
      entries.push({ uid: p.uid, name: p.name, score: p.allTimeBest,
        ts: Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000) });
    }
    entries.sort((a, b) => b.score - a.score);
    leaderboard.regular = entries.slice(0, 100);
  }
  const today = ymdUTC();
  const TARGET_DAILY = 40;
  if (!leaderboard.daily[today] || leaderboard.daily[today].length < TARGET_DAILY) {
    const existing = (leaderboard.daily[today] || []).slice();
    const existingUids = new Set(existing.map(e => e.uid));
    const entries = existing;
    const pool = FAKE_PLAYERS.slice().sort(() => Math.random() - 0.5);
    for (const p of pool) {
      if (entries.length >= TARGET_DAILY) break;
      if (existingUids.has(p.uid)) continue;
      const factor = 0.35 + Math.random() * 0.40;
      entries.push({ uid: p.uid, name: p.name,
        score: Math.floor(p.allTimeBest * factor),
        ts: Date.now() - Math.floor(Math.random() * 8 * 60 * 60 * 1000) });
    }
    entries.sort((a, b) => b.score - a.score);
    leaderboard.daily[today] = entries.slice(0, 100);
  }
  saveLeaderboard(leaderboard);
}
function ymdUTC(d) {
  d = d || new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function seedForYMD(ymd) {
  let h = 2166136261;
  for (let i = 0; i < ymd.length; i++) { h ^= ymd.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
purgeLeaderboardSeeds();
seedLeaderboardIfEmpty();

// ============ Tournament ============
// Weekly tournament: Monday 00:00 UTC → Sunday 23:59:59 UTC. Players whose
// runs land during the window get recorded with their best score for the
// week. When the week rolls over, the top 10 receive gem prizes pushed into
// the pendingByUser queue — drained by the normal /api/poll-purchases flow.
const TOURNAMENT_FILE = path.join(DATA_DIR, 'tournament.json');
const TOURNAMENT_PRIZES = [1500, 1000, 700, 500, 350, 250, 200, 200, 150, 150];
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function isoWeekId(d) {
  d = new Date(d || Date.now());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}
function weekStartUTC(d) {
  const x = new Date(d || Date.now());
  x.setUTCHours(0, 0, 0, 0);
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - (day - 1));
  return x.getTime();
}
function loadTournament() {
  try {
    if (!fs.existsSync(TOURNAMENT_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOURNAMENT_FILE, 'utf8'));
  } catch (e) { return null; }
}
function saveTournament(t) {
  try { fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(t)); } catch (e) {}
}
function newTournament() {
  const start = weekStartUTC();
  return {
    id: isoWeekId(), starts_at: start, ends_at: start + ONE_WEEK_MS - 1000,
    prizes: TOURNAMENT_PRIZES.slice(), entries: [], closed: false,
  };
}
function endTournament(t) {
  const sorted = (t.entries || []).slice().sort((a, b) => b.score - a.score);
  const winners = [];
  for (let i = 0; i < t.prizes.length && i < sorted.length; i++) {
    const player = sorted[i];
    if (player.uid < 0) continue;   // skip seeded fakes
    const prize = t.prizes[i];
    const arr = pendingByUser.get(player.uid) || [];
    arr.push({
      sku: 'tournament_prize',
      grant: { gems: prize, tournamentPrize: { id: t.id, rank: i + 1, prize } },
      ts: Date.now(),
    });
    pendingByUser.set(player.uid, arr);
    winners.push({ uid: player.uid, rank: i + 1, prize });
  }
  t.closed = true;
  t.winners = winners;
  console.log('[tournament] closed ' + t.id + ' — ' + winners.length + ' winners');
  return t;
}
let tournament = loadTournament();
function ensureTournament() {
  const now = Date.now();
  if (!tournament) { tournament = newTournament(); saveTournament(tournament); return; }
  if (!tournament.closed && now > tournament.ends_at) {
    endTournament(tournament); saveTournament(tournament);
    tournament = newTournament(); saveTournament(tournament);
    return;
  }
  if (!tournament.closed && tournament.id !== isoWeekId()) {
    endTournament(tournament); saveTournament(tournament);
    tournament = newTournament(); saveTournament(tournament);
  }
}
function purgeTournamentSeeds() {
  if (!tournament || tournament.closed) return;
  tournament.entries = tournament.entries.filter(e => e.uid >= 0);
}
function seedTournamentIfEmpty() {
  buildFakePlayers();
  if (!tournament || tournament.closed) return;
  const TARGET = 25;
  if (tournament.entries.length >= TARGET) return;
  const existingUids = new Set(tournament.entries.map(e => e.uid));
  const entries = tournament.entries.slice();
  for (const p of FAKE_PLAYERS) {
    if (entries.length >= TARGET) break;
    if (existingUids.has(p.uid)) continue;
    const factor = 0.45 + Math.random() * 0.45;
    entries.push({
      uid: p.uid, name: p.name,
      score: Math.floor(p.allTimeBest * factor),
      ts: Date.now() - Math.floor(Math.random() * 36 * 60 * 60 * 1000),
    });
  }
  entries.sort((a, b) => b.score - a.score);
  tournament.entries = entries.slice(0, 500);
  saveTournament(tournament);
}
ensureTournament();
purgeTournamentSeeds();
seedTournamentIfEmpty();

// ============ Share-card uploads ============
// Client renders a 600x600 PNG with score + final jar state, posts it here
// as base64. Stored under a fresh UUID, GC'd at 48h so Telegram has time to
// fetch the link-preview image. Persists under DATA_DIR so it survives a
// redeploy on Render's mounted disk.
const SHARES_DIR = path.join(DATA_DIR, 'shares');
try { if (!fs.existsSync(SHARES_DIR)) fs.mkdirSync(SHARES_DIR, { recursive: true }); } catch (e) {}
app.use('/shares', express.static(SHARES_DIR, {
  maxAge: '7d',
  // Pick Content-Type from the actual file extension instead of hard-
  // coding image/png. Telegram fetches the URL and validates the MIME
  // type — sending image/png for a .jpg file (or vice versa) causes
  // the prepared-message API to silently reject the upload.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
    else if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
  },
}));
setInterval(() => {
  try {
    const now = Date.now();
    const TTL = 48 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(SHARES_DIR)) {
      // GC PNG, JPG, and sidecar JSON together once they pass TTL
      if (!f.endsWith('.png') && !f.endsWith('.jpg') && !f.endsWith('.json')) continue;
      const p = path.join(SHARES_DIR, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > TTL) fs.unlinkSync(p);
    }
  } catch (e) {}
}, 60 * 60 * 1000);

// ============ Admin ============
const DEFAULT_ADMIN_IDS = '23040617';   // Pickle
function isAdmin(userId) {
  const raw = process.env.TELEGRAM_ADMIN_IDS || DEFAULT_ADMIN_IDS;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean).includes(String(userId));
}

// ============ Stars SKUs ============
// All prices in Telegram Stars (XTR). priceUsd is display-only.
const SKUS = {
  revive: {
    id: 'revive', title: 'Continue · One Revive',
    description: 'Clear three dolls and keep your run going.',
    price: 30, priceUsd: '$0.39', grant: { revives: 1 },
  },
  preview_pack: {
    id: 'preview_pack', title: 'Next-Doll Previews · ×10',
    description: 'See the next 2 dolls in the queue for 10 drops.',
    price: 50, priceUsd: '$0.65', grant: { previews: 10 },
  },
  undo_pack: {
    id: 'undo_pack', title: 'Undo Pack · ×5',
    description: 'Take back your last drop. 5 undos.',
    price: 60, priceUsd: '$0.79', grant: { undos: 5 },
  },
  gems_small: {
    id: 'gems_small', title: 'Small Pile · 500 Gems',
    description: '500 gems to spend on revives, undos, and skins.',
    price: 99, priceUsd: '$1.29', grant: { gems: 500 },
  },
  starter_pack: {
    id: 'starter_pack', title: 'Starter Pack · Best Value',
    description: '1,500 gems + 3 revives + Khokhloma skin.',
    price: 199, priceUsd: '$2.59',
    grant: { gems: 1500, revives: 3, skins: ['khokhloma'] },
  },
  gems_big: {
    id: 'gems_big', title: 'Big Vault · 3,500 Gems',
    description: '3,500 gems — better gems-per-star ratio.',
    price: 399, priceUsd: '$5.19', grant: { gems: 3500 },
  },
  gems_mega: {
    id: 'gems_mega', title: 'Mega Vault · 12,000 Gems',
    description: '12,000 gems — best value.',
    price: 750, priceUsd: '$9.99', grant: { gems: 12000 },
  },
  skin_khokhloma: {
    id: 'skin_khokhloma', title: 'Khokhloma Skin',
    description: 'Black-and-gold lacquer art on every doll.',
    price: 150, priceUsd: '$1.99', grant: { skins: ['khokhloma'] },
  },
  skin_gzhel: {
    id: 'skin_gzhel', title: 'Gzhel Skin',
    description: 'Cobalt-and-white porcelain pattern.',
    price: 150, priceUsd: '$1.99', grant: { skins: ['gzhel'] },
  },
  skin_neon: {
    id: 'skin_neon', title: 'Neon Skin',
    description: 'Glowing cyber dolls on a dark stage.',
    price: 200, priceUsd: '$2.59', grant: { skins: ['neon'] },
  },
  skin_wood: {
    id: 'skin_wood', title: 'Wood Skin',
    description: 'Hand-carved wooden dolls — warm and natural.',
    price: 200, priceUsd: '$2.59', grant: { skins: ['wood'] },
  },
  battle_pass: {
    id: 'battle_pass', title: 'Season Pass · 30 Days',
    description: 'Daily-mission rewards x2, exclusive skin, and gem bonus.',
    price: 500, priceUsd: '$6.49', grant: { battlePass: 30 },
  },
  streak_shield: {
    id: 'streak_shield', title: 'Streak Shield · 7 Days',
    description: 'Miss a day? Your streak survives. 7-day insurance.',
    price: 99, priceUsd: '$1.29', grant: { shieldDays: 7 },
  },
  hammer_pack: {
    id: 'hammer_pack', title: 'Hammer · ×5',
    description: 'Tap any doll in the jar to remove it. 5 hammers.',
    price: 80, priceUsd: '$1.05', grant: { hammers: 5 },
  },
  shake_pack: {
    id: 'shake_pack', title: 'Shake · ×5',
    description: 'Jostle every doll in the jar to dislodge bad stacks.',
    price: 60, priceUsd: '$0.79', grant: { shakes: 5 },
  },
  rainbow_pack: {
    id: 'rainbow_pack', title: 'Rainbow Doll · ×3',
    description: 'A magical doll that merges with ANY size — instant level up.',
    price: 120, priceUsd: '$1.59', grant: { rainbows: 3 },
  },
  booster_bundle: {
    id: 'booster_bundle', title: 'Booster Bundle · Best Value',
    description: '5 hammers + 5 shakes + 2 rainbows + 5 undos + 2 revives.',
    price: 299, priceUsd: '$3.89',
    grant: { hammers: 5, shakes: 5, rainbows: 2, undos: 5, revives: 2 },
  },
  test_purchase: {
    id: 'test_purchase', title: 'Test Purchase (admin)',
    description: 'Admin-only 1⭐ smoke-test — grants 1 gem.',
    price: 1, priceUsd: '$0.01',
    grant: { gems: 1 }, adminOnly: true,
  },
};

const pendingByUser = new Map();
function pushPending(userId, sku) {
  if (!SKUS[sku]) return;
  if (!pendingByUser.has(userId)) pendingByUser.set(userId, []);
  pendingByUser.get(userId).push({ sku, grant: SKUS[sku].grant, ts: Date.now() });
}
function drainPending(userId) {
  const arr = pendingByUser.get(userId) || [];
  pendingByUser.delete(userId);
  return arr;
}

const userState = new Map();
function rememberUser(userId, patch) {
  if (!userId) return;
  const prev = userState.get(userId) || {};
  userState.set(userId, Object.assign(prev, patch));
}

function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (hash !== expectedHash) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) { return null; }
}

let PUBLIC_URL_OBSERVED = '';
app.use((req, res, next) => {
  if (!PUBLIC_URL_OBSERVED) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
    if (host && host.includes('.') && !host.startsWith('localhost')) {
      PUBLIC_URL_OBSERVED = proto + '://' + host;
      console.log('[server] observed public URL:', PUBLIC_URL_OBSERVED);
    }
  }
  next();
});
function getPublicUrl() {
  const d = process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (d && d.includes('.')) return /^https?:\/\//i.test(d) ? d : 'https://' + d;
  return PUBLIC_URL_OBSERVED;
}
function buildPlayUrl() { return getPublicUrl() || 'http://localhost:' + PORT; }

app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.includes(path.sep + 'assets' + path.sep) ||
               /\.(png|jpg|jpeg|gif|webp|mp4|woff2?|otf|ttf)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ============ Bot identity ============
let BOT_USERNAME = '';
async function fetchBotIdentity() {
  if (!BOT_TOKEN) return;
  try {
    const r = await fetch(`${TELEGRAM_API}/getMe`);
    const d = await r.json();
    if (d && d.ok && d.result && d.result.username) {
      BOT_USERNAME = d.result.username;
      console.log('[bot] username @' + BOT_USERNAME);
    }
  } catch (e) { console.error('[bot] getMe failed:', e.message); }
}

// ============ API ============
app.get('/api/flags', (req, res) => {
  res.json({
    iap: !!BOT_TOKEN,
    publicUrl: getPublicUrl(),
    mixpanel_token: process.env.MIXPANEL_TOKEN || '',
    bot_username: BOT_USERNAME,
  });
});

app.get('/api/skus', (req, res) => {
  res.json({
    enabled: !!BOT_TOKEN,
    skus: Object.values(SKUS).map(s => ({
      id: s.id, title: s.title, description: s.description,
      price: s.price, priceUsd: s.priceUsd, grant: s.grant,
    })),
  });
});

app.post('/api/create-invoice', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set on server' });
  const { sku, initData, admin_test_price } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const item = SKUS[sku];
  if (!item) return res.status(400).json({ error: 'unknown sku' });
  if (item.adminOnly && !isAdmin(user.id)) return res.status(403).json({ error: 'sku is admin-only' });
  // Admin 1-star override — only honored if the requesting Telegram user
  // matches the admin allow-list AND they explicitly asked for the override.
  // Non-admins get the normal price regardless of what they send. The full
  // grant still applies (so the admin gets the real entitlement) — only
  // the invoice amount is dropped to 1⭐ for testing the payment funnel.
  const useAdminPrice = !!admin_test_price && isAdmin(user.id);
  const amount = useAdminPrice ? 1 : item.price;
  const title = useAdminPrice ? '[ADMIN 1⭐] ' + item.title : item.title;
  const payload = JSON.stringify({ uid: user.id, sku, ts: Date.now(), admin: useAdminPrice });
  try {
    const r = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, description: item.description, payload,
        provider_token: '', currency: 'XTR',
        prices: [{ label: title, amount }],
      }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(500).json({ error: data.description || 'telegram api failed' });
    res.json({ link: data.result, admin_price_used: useAdminPrice, amount });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// Progressive-priced one-shot revive invoice. Used by the game-over
// modal when the player is out of inventory revives. Price escalates
// 25, 50, 75, 100... per paid revive within the current run (the
// counter resets on newGame client-side; the server just takes the
// `revivesUsed` count and computes price as (n+1)*25, capped to
// keep accidental high-N requests sane).
app.post('/api/create-revive-invoice', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  const { initData, revivesUsed, admin_test_price } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const n = Math.max(0, Math.min(20, parseInt(revivesUsed, 10) || 0));
  const realAmount = (n + 1) * 25;
  const useAdminPrice = !!admin_test_price && isAdmin(user.id);
  const amount = useAdminPrice ? 1 : realAmount;
  const title = useAdminPrice ? '[ADMIN 1⭐] Revive' : `Revive #${n + 1}`;
  const description = 'Continue your run — clear the top 3 dolls and keep playing.';
  const payload = JSON.stringify({
    uid: user.id, sku: 'revive_oneshot',
    revivesUsed: n, real_price: realAmount, ts: Date.now(),
    admin: useAdminPrice,
  });
  try {
    const r = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, description, payload,
        provider_token: '', currency: 'XTR',
        prices: [{ label: title, amount }],
      }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(500).json({ error: data.description || 'telegram api failed' });
    res.json({ link: data.result, amount, real_amount: realAmount });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

app.post('/api/heartbeat', (req, res) => {
  const { initData, lang, streak, streakRiskAt } = req.body || {};
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  rememberUser(user.id, {
    chatId: user.id, lang: lang || 'en',
    streak: streak || 0, streakRiskAt: streakRiskAt || null,
    lastActiveAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/api/daily-seed', (req, res) => {
  const ymd = ymdUTC();
  res.json({ ymd, seed: seedForYMD(ymd) });
});

// ============ Power Hour ============
// Fixed daily window 18:00-19:00 UTC — peak EU/RU evening. During the hour
// the client doubles all reward grants (chest, missions, achievements,
// streak milestones). Pre-roll notification fires ~30 min before; the
// /start welcome and Earn-tab banner surface the next window.
const POWER_HOUR_START_UTC_HOUR = 18;
const POWER_HOUR_DURATION_MS = 60 * 60 * 1000;
function powerHourWindow(now) {
  now = now || Date.now();
  const d = new Date(now);
  const todayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    POWER_HOUR_START_UTC_HOUR, 0, 0, 0)).getTime();
  const todayEnd = todayStart + POWER_HOUR_DURATION_MS;
  if (now < todayStart) return { starts_at: todayStart, ends_at: todayEnd, active: false };
  if (now < todayEnd) return { starts_at: todayStart, ends_at: todayEnd, active: true };
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000;
  return { starts_at: tomorrowStart, ends_at: tomorrowStart + POWER_HOUR_DURATION_MS, active: false };
}
app.get('/api/power-hour', (req, res) => {
  const w = powerHourWindow();
  res.json(Object.assign({ multiplier: w.active ? 2 : 1 }, w));
});

app.post('/api/score/submit', (req, res) => {
  const body = req.body || {};
  const user = validateInitData(body.initData || '');
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  const score = Math.max(0, Math.min(99999999, parseInt(body.score, 10) || 0));
  const mode = body.mode === 'daily' ? 'daily' : 'regular';
  const ymd  = mode === 'daily' ? String(body.ymd || ymdUTC()).slice(0, 10) : null;
  if (mode === 'daily' && ymd !== ymdUTC()) return res.status(400).json({ error: 'wrong daily ymd' });
  const entry = {
    uid: user.id,
    name: (user.first_name || user.username || 'Player').slice(0, 24),
    score, ts: Date.now(),
  };
  if (mode === 'regular') {
    const i = leaderboard.regular.findIndex(e => e.uid === user.id);
    if (i >= 0) { if (score > leaderboard.regular[i].score) leaderboard.regular[i] = entry; }
    else leaderboard.regular.push(entry);
    leaderboard.regular.sort((a, b) => b.score - a.score);
    leaderboard.regular = leaderboard.regular.slice(0, 100);
  } else {
    if (!leaderboard.daily[ymd]) leaderboard.daily[ymd] = [];
    const arr = leaderboard.daily[ymd];
    const i = arr.findIndex(e => e.uid === user.id);
    if (i >= 0) { if (score > arr[i].score) arr[i] = entry; }
    else arr.push(entry);
    arr.sort((a, b) => b.score - a.score);
    leaderboard.daily[ymd] = arr.slice(0, 100);
    const cutoff = ymdUTC(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
    for (const key of Object.keys(leaderboard.daily)) if (key < cutoff) delete leaderboard.daily[key];
  }
  saveLeaderboard(leaderboard);
  // Tournament submission — every run counts, no opt-in required.
  ensureTournament();
  let tRank = 0;
  if (tournament && !tournament.closed) {
    const tEntries = tournament.entries;
    const tExisting = tEntries.findIndex(e => e.uid === user.id);
    if (tExisting >= 0) {
      if (score > tEntries[tExisting].score) tEntries[tExisting] = { uid: user.id, name: entry.name, score, ts: Date.now() };
    } else {
      tEntries.push({ uid: user.id, name: entry.name, score, ts: Date.now() });
    }
    tEntries.sort((a, b) => b.score - a.score);
    tournament.entries = tEntries.slice(0, 500);
    saveTournament(tournament);
    tRank = tournament.entries.findIndex(e => e.uid === user.id) + 1;
  }
  const board = mode === 'regular' ? leaderboard.regular : (leaderboard.daily[ymd] || []);
  const myRank = board.findIndex(e => e.uid === user.id) + 1;
  res.json({ ok: true, rank: myRank || null, tournament_rank: tRank || null, top: board.slice(0, 100) });
});

// Prepare an inline message (Bot API 8.0+ savePreparedInlineMessage) that
// the Mini App can hand to Telegram.WebApp.shareMessage(). The resulting
// share is a PHOTO with caption + an inline "PLAY MATRYOSHKA" button that
// deep-links into the Mini App. Crucially, the message body shows ONLY
// the photo + caption + button — no visible URL text — which is exactly
// what the player asked for.
app.post('/api/share/prepare-message', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  const { initData, photoUrl, score } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  if (!photoUrl || typeof photoUrl !== 'string') return res.status(400).json({ error: 'photoUrl required' });
  const displayName = (user.first_name || user.username || 'A player').slice(0, 32);
  const sc = (typeof score === 'number' && score > 0) ? score : 0;
  const playUrl = BOT_USERNAME
    ? 'https://t.me/' + BOT_USERNAME + '/app'
    : (getPublicUrl() || '');
  const caption = sc > 0
    ? '🪆 ' + displayName + ' scored ' + sc + ' on Matryoshka! 🎮 Beat them →'
    : '🪆 Matryoshka — drop, merge, reign. Try it →';
  const result = {
    type: 'photo',
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    photo_url: photoUrl,
    thumbnail_url: photoUrl,
    photo_width: 800,
    photo_height: 800,
    caption,
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 PLAY MATRYOSHKA', url: playUrl }]],
    },
  };
  try {
    const r = await fetch(`${TELEGRAM_API}/savePreparedInlineMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.id,
        result,
        allow_user_chats: true,
        allow_bot_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true,
      }),
    });
    const d = await r.json();
    if (!d.ok) {
      return res.status(500).json({ error: d.description || 'telegram savePreparedInlineMessage failed', api: d });
    }
    res.json({
      prepared_message_id: d.result.id,
      expiration_date: d.result.expiration_date,
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

app.post('/api/share/upload', (req, res) => {
  const { initData, dataUrl, score } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  if (typeof dataUrl !== 'string') return res.status(400).json({ error: 'expected dataUrl' });
  // Accept either JPEG (preferred for Telegram InlineQueryResultPhoto) or
  // PNG (back-compat). Telegram's prepared-message API requires JPEG, so
  // the client sends JPEG since v0.3.23 and we save with the .jpg ext.
  let ext, prefix;
  if (dataUrl.startsWith('data:image/jpeg;base64,'))      { ext = 'jpg'; prefix = 'data:image/jpeg;base64,'; }
  else if (dataUrl.startsWith('data:image/jpg;base64,'))  { ext = 'jpg'; prefix = 'data:image/jpg;base64,'; }
  else if (dataUrl.startsWith('data:image/png;base64,'))  { ext = 'png'; prefix = 'data:image/png;base64,'; }
  else return res.status(400).json({ error: 'expected dataUrl image/jpeg or image/png' });
  const b64 = dataUrl.slice(prefix.length);
  if (b64.length > 1024 * 1024) return res.status(413).json({ error: 'too large' });
  const id = crypto.randomBytes(8).toString('hex');
  const filename = id + '.' + ext;
  try { fs.writeFileSync(path.join(SHARES_DIR, filename), Buffer.from(b64, 'base64')); }
  catch (e) { return res.status(500).json({ error: 'write failed' }); }
  // Persist score + ext next to image so the share page can read it back.
  if (typeof score === 'number' && score > 0) {
    try {
      fs.writeFileSync(path.join(SHARES_DIR, id + '.json'),
        JSON.stringify({ score: Math.min(99999999, score), uid: user.id, name: user.first_name || user.username || 'Player', ts: Date.now(), ext }));
    } catch (e) {}
  }
  const baseUrl = getPublicUrl();
  const imageUrl = (baseUrl ? baseUrl : '') + '/shares/' + filename;
  const shareUrl = (baseUrl ? baseUrl : '') + '/share/' + id;
  res.json({ url: imageUrl, shareUrl, id, ext });
});

// Share landing page — what recipients of a "🪆 I scored X on Matryoshka,
// beat me 👉" Telegram message see when they tap the link. Renders the
// score card image as og:image so the in-chat preview is the card itself,
// then the page body shows a big PLAY button that opens the bot in
// Telegram. We escape every interpolated value to keep this XSS-safe.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
}
app.get('/share/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{16}$/.test(id)) return res.status(404).send('Not found');
  // Try .jpg first (new format since v0.3.23), then .png for older shares
  // that haven't TTL-expired yet.
  let ext = null;
  if (fs.existsSync(path.join(SHARES_DIR, id + '.jpg'))) ext = 'jpg';
  else if (fs.existsSync(path.join(SHARES_DIR, id + '.png'))) ext = 'png';
  if (!ext) return res.status(404).send('Expired or not found');
  const baseUrl = getPublicUrl() || '';
  const imageUrl = baseUrl + '/shares/' + id + '.' + ext;
  // Pull the player's score + name if we have a sidecar JSON for this id.
  let score = 0, name = 'A player';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(SHARES_DIR, id + '.json'), 'utf8'));
    if (meta && typeof meta.score === 'number') score = meta.score;
    if (meta && typeof meta.name === 'string') name = meta.name;
  } catch (e) {}
  // Bot deep link — prefer ?startapp= so the Mini App opens directly. Fall
  // back to the bare bot URL if BOT_USERNAME hasn't been resolved at boot.
  const playUrl = BOT_USERNAME
    ? 'https://t.me/' + BOT_USERNAME + '?startapp=share'
    : (baseUrl || '/');
  const title = '🪆 ' + (score > 0
    ? (escHtml(name) + ' scored ' + score + ' on Matryoshka — beat them!')
    : 'Matryoshka — drop, merge, reign');
  const desc = 'Drop nesting dolls. Merge same sizes. Reach the legendary Tsarina.';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#a51d30">
<meta name="description" content="${escHtml(desc)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="800">
<meta property="og:image:height" content="800">
<meta property="og:url" content="${baseUrl}/share/${id}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imageUrl}">
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;min-height:100vh}
  body{
    font-family:-apple-system,BlinkMacSystemFont,system-ui,"SF Pro Display","Segoe UI",sans-serif;
    color:#fff;
    background:radial-gradient(ellipse at top,#d12a44 0%,#a01a30 55%,#6f0f1f 100%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:24px 18px;text-align:center;
  }
  .card{
    background:rgba(0,0,0,0.18);
    border:1.5px solid rgba(255,213,122,0.45);
    border-radius:22px;
    padding:22px 18px 18px;
    max-width:380px;width:100%;
    box-shadow:0 10px 32px rgba(0,0,0,0.4);
  }
  .logo{font-size:72px;line-height:1;margin-bottom:4px;
    filter:drop-shadow(0 6px 12px rgba(0,0,0,0.35));
    animation:bob 1.8s ease-in-out infinite}
  @keyframes bob{
    0%,100%{transform:translateY(0) rotate(-3deg)}
    50%{transform:translateY(-8px) rotate(3deg)}
  }
  h1{font-size:24px;margin:0 0 4px;letter-spacing:1px;font-weight:800}
  .sub{color:#ffe6c2;font-size:13px;margin:0 0 16px;letter-spacing:1px}
  img.card-img{max-width:100%;width:100%;border-radius:14px;display:block;
    box-shadow:0 6px 18px rgba(0,0,0,0.35);margin-bottom:18px}
  .score-line{font-size:16px;color:#ffe6c2;font-weight:700;margin:0 0 14px}
  .score-line b{color:#fff;font-size:20px}
  .play{
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    width:100%;padding:14px 22px;
    background:linear-gradient(180deg,#ffd84d 0%,#f5b300 100%);
    color:#2b0a10;font-size:17px;font-weight:800;letter-spacing:0.5px;
    text-decoration:none;border-radius:14px;
    box-shadow:0 4px 12px rgba(0,0,0,0.3);
    -webkit-tap-highlight-color:transparent;
  }
  .play:active{transform:translateY(1px)}
  .footnote{margin-top:14px;font-size:11px;color:rgba(255,230,194,0.6);letter-spacing:0.5px}
</style>
</head>
<body>
  <div class="card">
    <div class="logo">🪆</div>
    <h1>MATRYOSHKA</h1>
    <div class="sub">DROP · MERGE · REIGN</div>
    <img class="card-img" src="${imageUrl}" alt="Score card">
    ${score > 0 ? `<p class="score-line">${escHtml(name)} scored <b>${score}</b>. Can you beat them?</p>` : ''}
    <a href="${playUrl}" class="play">🎮 PLAY MATRYOSHKA</a>
    <div class="footnote">Free · Stars-only IAP · No ads</div>
  </div>
</body>
</html>`);
});

app.get('/api/tournament/current', (req, res) => {
  ensureTournament();
  if (!tournament) return res.json({ tournament: null });
  res.json({
    id: tournament.id,
    starts_at: tournament.starts_at,
    ends_at: tournament.ends_at,
    prizes: tournament.prizes,
    top: tournament.entries.slice(0, 100),
    closed: !!tournament.closed,
  });
});

app.get('/api/leaderboard', (req, res) => {
  const mode = req.query.mode === 'daily' ? 'daily' : 'regular';
  const ymd  = mode === 'daily' ? String(req.query.ymd || ymdUTC()).slice(0, 10) : null;
  const board = mode === 'regular' ? leaderboard.regular : (leaderboard.daily[ymd] || []);
  res.json({ mode, ymd, top: board.slice(0, 100) });
});

app.post('/api/state/load', (req, res) => {
  const user = validateInitData((req.body && req.body.initData) || '');
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  const u = users[user.id];
  res.json({ ok: true, exists: !!u, state: u || null });
});
app.post('/api/state/save', (req, res) => {
  const { initData, patch } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'expected patch object' });
  const u = users[user.id] || {};
  let writes = 0;
  for (const k of SYNC_FIELDS) {
    if (patch[k] !== undefined) { u[k] = patch[k]; writes++; }
  }
  if (writes === 0) return res.json({ ok: true, writes: 0 });
  users[user.id] = u;
  saveUsers();
  res.json({ ok: true, writes });
});

app.post('/api/admin/whoami', (req, res) => {
  const user = validateInitData((req.body && req.body.initData) || '');
  if (!user) return res.json({ admin: false, user: null });
  res.json({ admin: isAdmin(user.id), user: { id: user.id, name: user.first_name || user.username || '' } });
});

app.post('/api/poll-purchases', (req, res) => {
  const user = validateInitData((req.body && req.body.initData) || '');
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  res.json({ purchases: drainPending(user.id) });
});

app.post('/api/telegram-webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(403).end();
  }
  const update = req.body || {};
  try {
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: q.id, ok: true }),
      });
    } else if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      try {
        const payload = JSON.parse(sp.invoice_payload);
        if (payload && payload.uid) {
          if (payload.sku === 'revive_oneshot') {
            // Virtual SKU — push a manual grant. Client checks the
            // instant_revive flag and calls doRevive() directly so
            // the player gets revived in the same modal session.
            const arr = pendingByUser.get(payload.uid) || [];
            arr.push({
              sku: 'revive_oneshot',
              grant: { instant_revive: true, paid_stars: sp.total_amount || 0 },
              ts: Date.now(),
            });
            pendingByUser.set(payload.uid, arr);
            try {
              notifyPurchase({
                sku: 'revive_oneshot',
                stars: sp.total_amount || 0,
                userId: payload.uid,
                username: update.message.from && update.message.from.username,
              });
            } catch (e) {}
          } else if (SKUS[payload.sku]) {
            pushPending(payload.uid, payload.sku);
            notifyPurchase({
              sku: payload.sku,
              stars: sp.total_amount || (SKUS[payload.sku] && SKUS[payload.sku].price) || 0,
              userId: payload.uid,
              username: update.message.from && update.message.from.username,
            });
          }
        }
      } catch (e) {}
    } else if (update.message && update.message.text === '/start') {
      const m = update.message;
      const lang = (m.from && m.from.language_code) || 'en';
      rememberUser(m.from.id, { chatId: m.chat.id, lang, lastActiveAt: Date.now() });
      const first = (m.from && (m.from.first_name || m.from.username)) || 'there';
      await sendWelcome(m.chat.id, first, lang);
    }
  } catch (e) {}
  res.json({ ok: true });
});

async function sendWelcome(chatId, firstName, lang) {
  if (!BOT_TOKEN) return;
  const playUrl = buildPlayUrl();
  const isRu = String(lang || '').startsWith('ru');
  const text = isRu
    ? `Привет, *${firstName}*! 🪆\n\n` +
      `Добро пожаловать в *Матрёшку* — самую залипательную игру про падающие куколки в Telegram.\n\n` +
      `🎯 *Как играть*\n` +
      `• Бросай матрёшек в баночку\n` +
      `• Две одинаковые матрёшки соединяются в следующую по размеру\n` +
      `• Доберись до самой большой — Царицы!\n\n` +
      `🎁 *Что внутри*\n` +
      `• Ежедневный сундук на 7 дней (до 500 💎)\n` +
      `• Еженедельный турнир с призами\n` +
      `• Глобальная таблица лидеров\n` +
      `• Скины Хохлома и Гжель\n\n` +
      `💎 Покупки только за Telegram Stars. *Никакой рекламы.*\n\n` +
      `Жми *И Г Р А Т Ь* ниже 👇`
    : `Hey *${firstName}*! 🪆\n\n` +
      `Welcome to *Matryoshka* — the most addictive drop-and-merge puzzle on Telegram.\n\n` +
      `🎯 *How to play*\n` +
      `• Drop nesting dolls into the jar\n` +
      `• Two same-size dolls merge into the next size up\n` +
      `• Get all the way to the Tsarina!\n\n` +
      `🎁 *What's inside*\n` +
      `• 7-day daily login chest (up to 500 💎)\n` +
      `• Weekly tournament with gem prizes\n` +
      `• Global leaderboard\n` +
      `• Khokhloma & Gzhel cosmetic skins\n\n` +
      `💎 Stars-only IAP. *No ads, ever.*\n\n` +
      `Tap *PLAY* below 👇`;
  const replyMarkup = {
    inline_keyboard: [[
      { text: isRu ? '🎮  И Г Р А Т Ь' : '🎮  P L A Y   M A T R Y O S H K A', web_app: { url: playUrl } },
    ]],
  };
  // Asset auto-detect: prefer GIF/MP4 (animation) > PNG/JPG (photo) > text-only.
  const assetsDir = path.join(__dirname, 'assets');
  const gif = ['welcome.gif', 'welcome.mp4'].map(f => path.join(assetsDir, f)).find(p => fs.existsSync(p));
  const photo = !gif && ['welcome.png', 'welcome.jpg', 'welcome.jpeg'].map(f => path.join(assetsDir, f)).find(p => fs.existsSync(p));
  const baseDomain = process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN;

  if (gif && baseDomain) {
    try {
      const url = `${getPublicUrl()}/assets/${path.basename(gif)}`;
      const r = await fetch(`${TELEGRAM_API}/sendAnimation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, animation: url,
          caption: text, parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        }),
      });
      if ((await r.json()).ok) return;
    } catch (e) {}
  }
  if (photo && baseDomain) {
    try {
      const url = `${getPublicUrl()}/assets/${path.basename(photo)}`;
      const r = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, photo: url,
          caption: text, parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        }),
      });
      if ((await r.json()).ok) return;
    } catch (e) {}
  }
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
    });
  } catch (e) {}
}

app.get('/api/diag', async (req, res) => {
  const out = {
    version: 'v0.3.0',
    bot_token_configured: !!BOT_TOKEN,
    bot_username: BOT_USERNAME || null,
    public_url: getPublicUrl() || null,
    data_dir: DATA_DIR,
    data_dir_writable: false,
    leaderboard_entries: leaderboard.regular.length,
    user_state_count: userState.size,
    pending_purchase_users: pendingByUser.size,
    uptime_sec: Math.round(process.uptime()),
    webhook: null,
  };
  try {
    const probe = path.join(DATA_DIR, '.diag-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    out.data_dir_writable = true;
  } catch (e) { out.data_dir_error = String(e && e.message || e); }
  if (BOT_TOKEN) {
    try {
      const r = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
      const d = await r.json();
      if (d && d.ok && d.result) {
        out.webhook = {
          url: d.result.url || '',
          pending_update_count: d.result.pending_update_count,
          last_error_message: d.result.last_error_message,
        };
      }
    } catch (e) {}
  }
  res.json(out);
});

app.post('/api/setup-webhook', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) return res.status(403).json({ error: 'wrong setup key' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/api/telegram-webhook`;
  try {
    const r = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url, secret_token: WEBHOOK_SECRET,
        allowed_updates: ['pre_checkout_query', 'message'],
        drop_pending_updates: true,
      }),
    });
    res.json({ webhook_url: url, telegram: await r.json() });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// ============ Notifications ============
const NOTIF_COPY = {
  streak_risk: {
    ru: ['🔥 Серия в опасности! Сыграй до полуночи, чтобы сохранить её.',
         '🔥 Не теряй серию — одна игра и она в безопасности.'],
    en: ['🔥 Streak in danger! Play before midnight to keep it.',
         '🔥 Don\'t lose your streak — one quick game saves it.'],
  },
  daily_challenge: {
    ru: ['🎯 Новый ежедневный челлендж ждёт. У тебя 24 часа!',
         '🎯 Сегодняшняя матрёшка готова — попадёшь в топ?'],
    en: ['🎯 Today\'s daily challenge is live. 24 hours on the clock!',
         '🎯 New daily doll is up — can you crack the leaderboard?'],
  },
  comeback: {
    ru: ['👋 Давно не виделись! Загляни — тебя ждёт бонусный сундук.',
         '👋 Скучаем! Бесплатные гемы внутри.'],
    en: ['👋 Been a while! Drop in for a comeback bonus chest.',
         '👋 We miss you! Free gems waiting inside.'],
  },
};
const NOTIF_CTA = { ru: '🎮  И Г Р А Т Ь', en: '🎮  P L A Y   N O W' };
function pickCopy(kind, lang) {
  const t = NOTIF_COPY[kind] || {};
  const v = t[lang] || t.en || [];
  return v[Math.floor(Math.random() * v.length)] || '';
}
async function sendNotification(chatId, lang, kind) {
  if (!chatId || !BOT_TOKEN) return false;
  const text = pickCopy(kind, lang);
  if (!text) return false;
  const replyMarkup = {
    inline_keyboard: [[{ text: NOTIF_CTA[lang] || NOTIF_CTA.en, web_app: { url: buildPlayUrl() } }]],
  };
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
    });
    return !!(await r.json()).ok;
  } catch (e) { return false; }
}
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
function canSendNotif(st, kind, now) {
  const lastKind = (st.notifLast || {})[kind] || 0;
  if (now - lastKind < ONE_DAY) return false;
  const lastAny = st.notifLastAny || 0;
  if (now - lastAny < 6 * ONE_HOUR) return false;
  st.notifTimes = (st.notifTimes || []).filter(t => now - t < ONE_DAY);
  if (st.notifTimes.length >= 3) return false;
  return true;
}
function recordNotifSent(st, kind, now) {
  st.notifLast = st.notifLast || {};
  st.notifLast[kind] = now;
  st.notifLastAny = now;
  st.notifTimes = (st.notifTimes || []).concat(now);
}
async function notifyLoop() {
  const now = Date.now();
  for (const [uid, st] of userState) {
    if (!st.chatId) continue;
    if (st.streak > 0 && st.streakRiskAt && st.streakRiskAt > now && (st.streakRiskAt - now) < 4 * ONE_HOUR
        && (now - (st.lastActiveAt || 0)) > 30 * 60 * 1000
        && canSendNotif(st, 'streak_risk', now)) {
      if (await sendNotification(st.chatId, st.lang || 'en', 'streak_risk')) recordNotifSent(st, 'streak_risk', now);
      continue;
    }
    if (st.lastActiveAt && (now - st.lastActiveAt) > 3 * ONE_DAY && canSendNotif(st, 'comeback', now)) {
      if (await sendNotification(st.chatId, st.lang || 'en', 'comeback')) recordNotifSent(st, 'comeback', now);
      continue;
    }
    if (st.lastActiveAt && (now - st.lastActiveAt) > 18 * ONE_HOUR && canSendNotif(st, 'daily_challenge', now)) {
      if (await sendNotification(st.chatId, st.lang || 'en', 'daily_challenge')) recordNotifSent(st, 'daily_challenge', now);
    }
  }
}

// ============ Boot ============
app.listen(PORT, () => {
  console.log(`Matryoshka serving on port ${PORT}`);
  console.log(`IAP: ${BOT_TOKEN ? 'enabled' : 'DISABLED — set BOT_TOKEN env var to turn on'}`);
  console.log(`[tournament] current: ${tournament ? tournament.id : 'none'}`);
  if (BOT_TOKEN) {
    fetchBotIdentity();
    setInterval(notifyLoop, FIVE_MIN);
    console.log('[notify] loop armed — every 5 min');
  }
  // Hourly: roll over tournaments even without submissions, GC ephemeral state.
  setInterval(ensureTournament, 60 * 60 * 1000);
});
