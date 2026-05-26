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
  'season',
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
  // v0.3.57 — starter-offer state. shown=true once user saw the popup,
  // purchased=true once they bought the SKU. Both flags are read by
  // client to decide whether to show the offer button + popup.
  // v0.3.61 — added starterOfferTier (1..6) for escalating 5-tier chain.
  // v0.3.62 — starterOfferReadyAfterLoss gates T2+ button visibility:
  // false right after a purchase, true once a game-over fires.
  'starterOfferShown', 'starterOfferPurchased', 'starterOfferTier',
  'starterOfferReadyAfterLoss',
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
  '🪆 Babushka', '⚡ Tsaritsa', '💎 Zara', '🌹 Roza', '🎀 Veronika',
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
    description: '1,500 gems + 3 revives.',
    price: 199, priceUsd: '$2.59',
    grant: { gems: 1500, revives: 3 },
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
  // v0.3.56 — removed all skin SKUs (skin_khokhloma, skin_gzhel,
  // skin_neon, skin_wood). Pickle is redesigning the doll art entirely;
  // the old palette swaps are paused until the new direction lands.
  // v0.3.57 — first-loss "Starter Offer" special pack.
  // v0.3.61 — escalating 5-tier chain: each purchase advances
  // starterOfferTier so the NEXT offer (priced higher, bigger contents)
  // becomes available after the player loses another match. Caps at
  // tier 6 = "all 5 bought, hide forever". Legacy starterOfferPurchased
  // flag still set on T1 for back-compat with v0.3.57 saves.
  first_loss_pack: {
    id: 'first_loss_pack', title: 'Starter Pack',
    description: '5 Revives + 1 Rainbow Doll.',
    price: 229, priceUsd: '$2.99',
    grant: { revives: 5, rainbows: 1, starterOfferPurchased: 1, starterOfferTier: 2 },
  },
  starter_pack_2: {
    id: 'starter_pack_2', title: 'Climber Pack',
    description: '10 Revives + 3 Rainbow Dolls + 5 Hammers.',
    price: 379, priceUsd: '$4.99',
    grant: { revives: 10, rainbows: 3, hammers: 5, starterOfferTier: 3 },
  },
  starter_pack_3: {
    id: 'starter_pack_3', title: 'Climber Pack II',
    description: '15 Revives + 5 Rainbow Dolls + 10 Hammers + 10 Shakes.',
    price: 619, priceUsd: '$7.99',
    grant: { revives: 15, rainbows: 5, hammers: 10, shakes: 10, starterOfferTier: 4 },
  },
  starter_pack_4: {
    id: 'starter_pack_4', title: 'Climber Pack III',
    description: '25 Revives + 10 Rainbows + 15 Hammers + 15 Shakes + 5 Undos.',
    price: 849, priceUsd: '$10.99',
    grant: { revives: 25, rainbows: 10, hammers: 15, shakes: 15, undos: 5, starterOfferTier: 5 },
  },
  starter_pack_5: {
    id: 'starter_pack_5', title: 'Climber Pack · ULTIMATE',
    description: '50 Revives + 20 Rainbows + 25 Hammers + 25 Shakes + 15 Undos + 3,000 Gems.',
    price: 1149, priceUsd: '$14.99',
    grant: { revives: 50, rainbows: 20, hammers: 25, shakes: 25, undos: 15, gems: 3000, starterOfferTier: 6 },
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
  // Single-shot convenience packs — surfaced via the "out of charges"
  // popup when a player taps an empty booster button mid-game. Slight
  // per-unit premium vs the multi-packs to nudge bigger purchases.
  hammer_single: {
    id: 'hammer_single', title: 'Hammer · ×1',
    description: 'One hammer — tap any doll to remove it.',
    price: 20, priceUsd: '$0.25', grant: { hammers: 1 },
  },
  shake_single: {
    id: 'shake_single', title: 'Shake · ×1',
    description: 'One shake — jostle every doll in the jar.',
    price: 15, priceUsd: '$0.19', grant: { shakes: 1 },
  },
  rainbow_single: {
    id: 'rainbow_single', title: 'Rainbow Doll · ×1',
    description: 'One rainbow — merges with any size.',
    price: 45, priceUsd: '$0.59', grant: { rainbows: 1 },
  },
  undo_single: {
    id: 'undo_single', title: 'Undo · ×1',
    description: 'One undo — take back your last drop.',
    price: 15, priceUsd: '$0.19', grant: { undos: 1 },
  },
  season_pass_premium: {
    id: 'season_pass_premium', title: 'Season Pass · Premium',
    description: 'Unlock 4× rewards on every step of this week\'s season pass.',
    price: 100, priceUsd: '$1.30', grant: { seasonPremium: true },
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

// ============ User state (notifications, chatId, etc.) ============
// v0.3.43 — persisted to disk so chatIds + notif tracking survive Render
// redeploys. Previously this was in-memory only and every redeploy meant
// no notifications could fire until each user reopened the app (which
// re-fired /api/heartbeat to repopulate the map). Now we serialize to
// data/notif-state.json on every change (debounced 5s).
const userState = new Map();
const USER_STATE_FILE = path.join(DATA_DIR, 'notif-state.json');
let userStateSaveTimer = null;
function loadUserState() {
  try {
    if (!fs.existsSync(USER_STATE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(USER_STATE_FILE, 'utf8'));
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) userState.set(Number(k) || k, obj[k]);
      console.log('[notif] loaded ' + userState.size + ' user state entries');
    }
  } catch (e) { console.error('[notif] state load failed:', e.message); }
}
function saveUserState() {
  // Debounced — many calls per minute collapse into one disk write
  if (userStateSaveTimer) return;
  userStateSaveTimer = setTimeout(() => {
    userStateSaveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of userState) obj[String(k)] = v;
      fs.writeFileSync(USER_STATE_FILE, JSON.stringify(obj));
    } catch (e) { console.error('[notif] state save failed:', e.message); }
  }, 5000);
}
function rememberUser(userId, patch) {
  if (!userId) return;
  const prev = userState.get(userId) || {};
  userState.set(userId, Object.assign(prev, patch));
  saveUserState();
}
loadUserState();

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
// v0.3.46 — buildPlayUrl now accepts optional attribution params that
// become query-string args on the Mini App URL. Telegram preserves the
// query string when opening web_app buttons, so the client can read
// window.location.search on boot and emit a Mixpanel `Notification
// Opened` event tagged with the originating notification kind.
//
// Example: buildPlayUrl({ source: 'notif', campaign: 'streak_risk' })
//   → https://matryoshka-zlp6.onrender.com/?utm_source=notif&utm_campaign=streak_risk&fired_at=1779...
function buildPlayUrl(attrib) {
  const base = getPublicUrl() || 'http://localhost:' + PORT;
  if (!attrib || typeof attrib !== 'object') return base;
  const params = new URLSearchParams();
  if (attrib.source)   params.set('utm_source', String(attrib.source));
  if (attrib.medium)   params.set('utm_medium', String(attrib.medium));
  if (attrib.campaign) params.set('utm_campaign', String(attrib.campaign));
  if (attrib.content)  params.set('utm_content', String(attrib.content));
  // Stamping the fire time helps us measure click-to-open latency in
  // Mixpanel (open_ts - fired_at = latency in ms).
  params.set('fired_at', String(Date.now()));
  const qs = params.toString();
  return qs ? base + '?' + qs : base;
}

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

// v0.3.55 — server-side 'App Opened' fire for clean retention.
// Client calls this once on boot AND on visibilitychange→visible (>5min
// gap). Server-side is more reliable than client-side Mixpanel JS (no
// adblocker/network/JS-error risk) and validates the user via initData
// (can't be spoofed).
//
// Geo: we forward the client IP via the `ip` property so Mixpanel
// resolves $country_code from the user's actual location, not Render's
// datacenter. Without this, server-side events all look like they
// come from Oregon (Render's HQ).
//
// Rate limiting: at most once per user per 15 min so quick reloads
// don't inflate event counts. The 'restored' type still fires
// distinctly within the window.
const appOpenedLastFireByUser = new Map();
app.post('/api/app/opened', (req, res) => {
  const { initData, type } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const fireType = (type === 'restored') ? 'restored' : 'initial';
  // Rate-limit 'initial' (15 min). 'restored' has its own client-side
  // 5-min throttle, so no extra server gating needed.
  const lastFire = appOpenedLastFireByUser.get(user.id) || 0;
  const FIFTEEN_MIN = 15 * 60 * 1000;
  if (fireType === 'initial' && Date.now() - lastFire < FIFTEEN_MIN) {
    return res.json({ ok: true, skipped: 'rate_limited', last_fire_ago_sec: Math.round((Date.now()-lastFire)/1000) });
  }
  appOpenedLastFireByUser.set(user.id, Date.now());
  // Forward client IP for Mixpanel geo resolution. Render sets
  // x-forwarded-for; fall back to req.ip if absent (local dev).
  const xff = req.headers['x-forwarded-for'] || '';
  const clientIp = String(xff).split(',')[0].trim() || req.ip || '';
  // Pull user state for richer event properties.
  const stored = users[String(user.id)] || users[user.id] || {};
  mpTrack('App Opened', String(user.id), {
    type: fireType,
    streak: stored.streak || 0,
    total_games_ever: stored.totalGamesEver || 0,
    best: stored.best || 0,
    gems: stored.gems || 0,
    ftue_done: !!stored.ftueDone,
    lang: (stored.settings && stored.settings.lang) || user.language_code || 'en',
    is_premium: !!user.is_premium,
    ip: clientIp,                    // Mixpanel uses this for geo
    fired_from: 'server',
  });
  // Also touch userState so the user gets counted in notif audience
  // (in case they haven't heartbeated yet this session).
  rememberUser(user.id, { chatId: user.id, lastActiveAt: Date.now(),
    lang: user.language_code || 'en' });
  res.json({ ok: true, fired: true, type: fireType });
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
  const desc = 'Drop nesting dolls. Merge same sizes. Reach the legendary Tsaritsa.';
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

// v0.3.57 — admin "delete my own progress" cheat. Useful for testing
// the first-loss starter offer / FTUE / new-player flows without
// having to spin up a fresh Telegram account.
//
// CRITICAL safety properties:
//   - Authenticated via initData (HMAC-signed by Telegram, can't spoof)
//   - Only deletes the caller's own state — uses user.id from initData,
//     NOT a uid passed by the client
//   - Gated by isAdmin(user.id) so non-admins can't trigger it even if
//     they figure out the endpoint exists
//   - Touches both users.json (game state) and userState (notif state)
//     so it's a clean wipe end-to-end
app.post('/api/admin/delete-self', (req, res) => {
  const { initData } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  if (!isAdmin(user.id)) return res.status(403).json({ error: 'admin only' });
  const uid = String(user.id);
  let removed = { from_users: false, from_userstate: false, from_pending: false };
  if (users[uid] || users[user.id]) {
    delete users[uid]; delete users[user.id];
    saveUsers();
    removed.from_users = true;
  }
  if (userState.has(user.id) || userState.has(uid)) {
    userState.delete(user.id); userState.delete(uid);
    saveUserState();
    removed.from_userstate = true;
  }
  if (pendingByUser.has(user.id) || pendingByUser.has(uid)) {
    pendingByUser.delete(user.id); pendingByUser.delete(uid);
    removed.from_pending = true;
  }
  console.log('[admin] deleted self uid=' + uid, removed);
  res.json({ ok: true, uid, removed });
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
      `• Get all the way to the Tsaritsa!\n\n` +
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
  // Count users with valid chatId for notifications + recent activity
  const now = Date.now();
  let withChatId = 0, activeLastDay = 0, activeLastWeek = 0;
  for (const [, st] of userState) {
    if (st.chatId) withChatId++;
    if (st.lastActiveAt && (now - st.lastActiveAt) < 24 * 60 * 60 * 1000) activeLastDay++;
    if (st.lastActiveAt && (now - st.lastActiveAt) < 7 * 24 * 60 * 60 * 1000) activeLastWeek++;
  }
  const out = {
    version: 'v0.3.62',
    bot_token_configured: !!BOT_TOKEN,
    bot_username: BOT_USERNAME || null,
    public_url: getPublicUrl() || null,
    data_dir: DATA_DIR,
    data_dir_writable: false,
    leaderboard_entries: leaderboard.regular.length,
    user_state_count: userState.size,
    users_json_count: Object.keys(users).length,
    notif_users_with_chatid: withChatId,
    notif_active_last_day: activeLastDay,
    notif_active_last_week: activeLastWeek,
    notif_kinds_configured: Object.keys(NOTIF_COPY || {}).length,
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

// ============ Server-side Mixpanel (v0.3.46) ============
// Lightweight HTTP-only Mixpanel tracker so the server can emit
// `Notification Sent` events. Combined with the client-side
// `Notification Opened` event (fired on boot when ?utm_source=notif),
// this gives us a 3-step funnel in Mixpanel:
//   Notification Sent  →  Notification Opened  →  Game Started
// Without server-side fire, we'd only see opens (not the delivery base),
// and click-through rate would be unmeasurable.
const MIXPANEL_TOKEN = process.env.MIXPANEL_TOKEN || '';
function mpTrack(eventName, distinctId, props) {
  if (!MIXPANEL_TOKEN) return;
  try {
    const body = {
      event: eventName,
      properties: Object.assign({
        token: MIXPANEL_TOKEN,
        distinct_id: distinctId ? String(distinctId) : 'server',
        time: Math.floor(Date.now() / 1000),
        $insert_id: crypto.randomBytes(8).toString('hex'),
      }, props || {}),
    };
    const dataParam = Buffer.from(JSON.stringify(body)).toString('base64');
    // ip=1 tells Mixpanel to resolve geo from the request — but this is a
    // server-side fire, so geo will be the Render datacenter, not the user.
    // Skip ip=1 here; if you want user geo on server events, look up
    // the user's last-known $country_code from a prior client event.
    fetch('https://api.mixpanel.com/track?data=' + dataParam, { method: 'GET' })
      .catch(() => {});
  } catch (e) {}
}

// ============ Notifications (v0.3.43 robust system) ============
// Every notification fires through sendNotification(chatId, lang, kind, ctx)
// which:
//   1. picks a random copy variant (3-5 per kind, EN + RU)
//   2. attaches a curated GIF (Tenor URL — Telegram natively renders these)
//   3. attaches an inline "PLAY" button that opens the Mini App
//   4. falls back to text-only sendMessage if sendAnimation fails
//
// Throttling: max 3/day per user, 6h between any two, 24h per kind.
// Persisted state survives Render redeploys (notif-state.json).

// GIF library — Giphy media URLs (more stable than Tenor for direct embed
// via Bot API). Format: https://media.giphy.com/media/{ID}/giphy.gif
// To swap: replace the ID. Search Giphy at giphy.com, copy the URL, extract
// the ID from the page URL or use the "Embed" → media URL.
//
// v0.3.45 — IDs scraped from Giphy search top-results so each GIF matches
// the notification's emotional beat (panic, hype, FOMO, celebration).
// To swap any: go to giphy.com, search the query in the comment, click a
// GIF, take the ID from the URL path (.../gifs/some-slug-{ID}), paste in.
const GIFY = id => 'https://media.giphy.com/media/' + id + '/giphy.gif';
const G = {
  fire_panic:    GIFY('uzhLg2JeZPmgIUYYLd'),  // "house on fire panic"
  treasure_open: GIFY('URtLkq20ArVZ49JoNI'),  // "treasure chest open"
  challenge:     GIFY('AWv3UAFkgz39u'),        // "challenge accepted"
  miss_you:      GIFY('OPWLlr5lQxV7c4gDRj'),  // "miss you wave"
  charging_up:   GIFY('LdjhDhuU7bUI2UxwMx'),  // "charging up power"
  lightning:     GIFY('3ohzgEubwQ4i4c2lwY'),  // "lightning power"
  rushing:       GIFY('5q3NyUvgt1w9unrLJ9'),  // "running out of time"
  trophy:        GIFY('1BfPP1taCof3s61x71'),  // "trophy celebration"
  almost_there:  GIFY('26FeWZkCLcn4CaMRq'),   // "almost there"
  reading_paper: GIFY('VeT5jhseHD0W3dI7de'),  // "reading newspaper"
  one_more_day:  GIFY('GSbRkSrg1nz9K'),        // "one more day"
  // v0.3.47 — broadcast-friendly "beat your high score" kind
  // v0.3.48 — swapped to funnier taunting/meme GIFs (Pickle wanted humor)
  come_at_me:    GIFY('VCEHgr7btF2cbLXKTz'),  // "come at me bro"
  bring_it_on:  GIFY('jgelsNvS6tYFG'),         // "bring it on"
  i_dare_you:   GIFY('Mc82AYNsjgxHMpPMWE'),    // "i dare you"
};
const NOTIF_GIFS = {
  streak_risk:         [G.fire_panic],
  daily_chest:         [G.treasure_open],
  daily_challenge:     [G.challenge],
  comeback:            [G.miss_you],
  power_hour_starting: [G.charging_up],
  power_hour_active:   [G.lightning],
  tournament_ending:   [G.rushing],
  tournament_results:  [G.trophy],
  season_step_close:   [G.almost_there],
  weekly_recap:        [G.reading_paper],
  milestone_close:     [G.one_more_day],
  beat_your_score:     [G.come_at_me, G.bring_it_on, G.i_dare_you],
  generic:             [G.treasure_open],
};
function pickGif(kind) {
  const arr = NOTIF_GIFS[kind] || NOTIF_GIFS.generic || [];
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// Copy library — EN + RU full. Each kind gets 4-5 variants so the same
// player doesn't see the same line twice in a row. Tone: Telegram-native,
// emoji-forward, FOMO-leaning, never spammy. Markdown bold OK.
const NOTIF_COPY = {
  streak_risk: {
    ru: [
      '🔥 *Серия {streak} дней под угрозой!*\nОдна быстрая игра — и она в безопасности до завтра.',
      '🔥 *Не теряй серию в {streak} дней!*\nОсталось пару часов — заходи!',
      '⏰ Твоя серия истекает! Сыграй сейчас, спаси {streak} дней подряд 🪆',
      '🔥 *Серия горит!* Игра занимает 60 секунд — успеешь?',
    ],
    en: [
      '🔥 *Your {streak}-day streak is on the line!*\nOne quick game saves it before midnight.',
      '🔥 *Don\'t break your {streak}-day streak!*\nA couple hours left — drop in!',
      '⏰ Your streak is about to die! Play now, keep {streak} days alive 🪆',
      '🔥 *Streak burning out!* 60 seconds of play locks it in — let\'s go!',
    ],
  },
  daily_chest: {
    ru: [
      '🎁 *Сундук готов!* Заходи и забирай ежедневный бонус.',
      '🎁 Сегодняшний сундук открыт — до 500 💎 ждут тебя.',
      '✨ День {day} серии входов = больший сундук. Не пропусти!',
      '🎁 *Бесплатные гемы внутри!* Открой сундук сегодня.',
    ],
    en: [
      '🎁 *Today\'s chest is ready!*\nOpen it for your daily gem drop.',
      '🎁 Daily chest unlocked — up to 500 💎 waiting.',
      '✨ Day {day} of your login streak = bigger chest. Don\'t miss it!',
      '🎁 *Free gems inside!* Pop open today\'s chest.',
    ],
  },
  daily_challenge: {
    ru: [
      '🎯 *Новый ежедневный челлендж!*\nТа же раскладка для всех игроков. Попадёшь в топ?',
      '🌅 Челлендж дня готов. У тебя 24 часа, чтобы поставить рекорд!',
      '🎯 Сегодняшняя матрёшка — особая. Сыграй пока не сбросилась.',
      '🌅 *Daily вызов* живой. Один шанс — твой ход.',
    ],
    en: [
      '🎯 *Today\'s daily challenge is live!*\nSame seed for everyone. Can you top it?',
      '🌅 New daily ready. 24 hours to set your best!',
      '🎯 Today\'s seed is special. Play before it resets.',
      '🌅 *Daily challenge* is up. One shot — make it count.',
    ],
  },
  comeback: {
    ru: [
      '👋 *Давно не виделись!*\nБонусный сундук + 100 💎 ждут тебя — заходи.',
      '🪆 Скучаем! У нас новый сезонный пасс и крутые скины. Вернись на одну игру!',
      '👋 Привет! Турнир этой недели открыт — заходи отомстить.',
      '🪆 *3 дня без матрёшек?* Это слишком долго! Бонус ждёт.',
    ],
    en: [
      '👋 *Been a while!*\nCome back for a bonus chest + 100 💎.',
      '🪆 Miss you! New season pass and fresh skins live. One game?',
      '👋 Hey! This week\'s tournament is open — come reclaim your spot.',
      '🪆 *3 days without Matryoshka?* That\'s too long! Bonus inside.',
    ],
  },
  power_hour_starting: {
    ru: [
      '⚡ *ПАУЭР АВЕР через 30 мин!*\nВсе награды x2 — будь готов!',
      '⚡ В 18:00 UTC начинается Power Hour. Удвоение всех гемов!',
      '⚡ *Час Удвоения* стартует скоро. Заряжайся.',
    ],
    en: [
      '⚡ *POWER HOUR in 30 min!*\nAll rewards 2× — be ready!',
      '⚡ Power Hour starts at 18:00 UTC. Every gem doubled!',
      '⚡ *Double-Rewards Hour* about to start. Gear up.',
    ],
  },
  power_hour_active: {
    ru: [
      '⚡ *POWER HOUR ЗАПУЩЕН!*\nВсе награды x2 целый час. Не теряй время!',
      '⚡ x2 на ВСЁ. Прямо сейчас, 60 минут. Заходи!',
      '🚀 Power Hour live! Каждая игра = двойной профит.',
    ],
    en: [
      '⚡ *POWER HOUR IS LIVE!*\nAll rewards 2× for the next hour. Don\'t waste it!',
      '⚡ 2× EVERYTHING. Right now, 60 minutes. Get in!',
      '🚀 Power Hour live! Every game = double the gems.',
    ],
  },
  tournament_ending: {
    ru: [
      '🏆 *Турнир закрывается через 4 часа!*\nТы на {rank} месте — есть шанс подняться!',
      '🏆 Финал недели близко. Один рывок может изменить всё.',
      '🏆 *4 часа до конца* турнира. Последний шанс!',
    ],
    en: [
      '🏆 *Tournament ends in 4 hours!*\nYou\'re ranked #{rank} — one big game could move you up!',
      '🏆 Week\'s final stretch. One push can change everything.',
      '🏆 *4 hours left* in the tournament. Last chance!',
    ],
  },
  tournament_results: {
    ru: [
      '🏆 *Турнир закрыт!* Ты на {rank} месте — забери награду в игре.',
      '🎉 Результаты недели! Зайди — приз ждёт.',
    ],
    en: [
      '🏆 *Tournament closed!* You finished #{rank} — claim your prize in-game.',
      '🎉 Week wrapped! Open the app — your reward is waiting.',
    ],
  },
  season_step_close: {
    ru: [
      '✨ *Почти на следующей награде сезона!*\nОсталось всего {points} очков.',
      '✨ Следующий шаг сезонного пасса — рукой подать. Сыграй одну игру!',
      '🪆 Близко к новой награде. Не останавливайся!',
    ],
    en: [
      '✨ *Almost at your next season reward!*\nJust {points} points to go.',
      '✨ Next season-pass step is right there. One quick game!',
      '🪆 Close to a new reward. Don\'t stop now!',
    ],
  },
  weekly_recap: {
    ru: [
      '📊 *Твоя неделя:* {games} игр, лучший счёт {best}.\nГотов побить?',
      '📊 Воскресный отчёт: ты сыграл {games} раз на этой неделе. Финиш на ура?',
    ],
    en: [
      '📊 *Your week:* {games} games, best score {best}.\nReady to top it?',
      '📊 Sunday recap: {games} games this week. Cap it off with a banger?',
    ],
  },
  milestone_close: {
    ru: [
      '🔥 *Серия {streak} дней!* Ещё 1 день до следующей награды.',
      '🔥 Так близко! День {streak}/{milestone} — финиш завтра.',
    ],
    en: [
      '🔥 *{streak}-day streak!* One more day to the next reward.',
      '🔥 So close! Day {streak}/{milestone} — finish line tomorrow.',
    ],
  },
  // v0.3.47 — broadcast-friendly. Pulls user's actual `best` from the
  // server-side users.json mirror at send time so the score is real,
  // not made up. If best is 0 (new player who never finished a game),
  // we route to the *_new_player variants which don't reference a score.
  beat_your_score: {
    // v0.3.48 — single internationally-clear line per lang.
    // No idioms, no compound sentences. Score on its own visual line.
    ru: [
      '🏆 *Твой рекорд: {score}*\nСможешь побить?!',
    ],
    en: [
      '🏆 *Your high score: {score}*\nCan you beat it!?',
    ],
  },
  beat_your_score_new_player: {
    ru: [
      '🏆 *Готов поставить свой первый рекорд?*',
    ],
    en: [
      '🏆 *Ready to set your first high score?*',
    ],
  },
};
const NOTIF_CTA = { ru: '🎮  И Г Р А Т Ь', en: '🎮  P L A Y   N O W' };

// Picks a copy variant + does {placeholder} substitution from ctx.
function pickCopy(kind, lang, ctx) {
  const t = NOTIF_COPY[kind] || {};
  const v = t[lang] || t.en || [];
  let s = v[Math.floor(Math.random() * v.length)] || '';
  if (ctx && typeof ctx === 'object') {
    for (const k of Object.keys(ctx)) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(ctx[k]));
    }
  }
  return s;
}

async function sendNotification(chatId, lang, kind, ctx) {
  if (!chatId || !BOT_TOKEN) return { ok: false, reason: 'no chatId/token' };
  const text = pickCopy(kind, String(lang || 'en').slice(0, 2), ctx || {});
  if (!text) return { ok: false, reason: 'no copy for kind ' + kind };
  // v0.3.46 — attribution params on the play URL so we can measure
  // notification → open → game-played conversion in Mixpanel.
  // Client reads window.location.search on boot and fires 'Notification
  // Opened' + tags Session Start with open_source='notif'.
  const playUrl = buildPlayUrl({
    source: 'notif',
    medium: 'telegram_bot',
    campaign: kind,
  });
  const replyMarkup = {
    inline_keyboard: [[
      { text: NOTIF_CTA[String(lang || 'en').slice(0, 2)] || NOTIF_CTA.en,
        web_app: { url: playUrl } }
    ]],
  };
  const gif = pickGif(kind);
  // Helper: fire server-side Notification Sent / Failed events.
  // v0.3.49 — added Failed event so we can see "8 sent, 2 delivered,
  // 6 blocked" via Mixpanel (or via /api/admin/last-broadcast endpoint).
  const fireSent = (mode) => {
    mpTrack('Notification Sent', String(chatId), {
      kind, mode, gif: gif || null,
      lang: String(lang || 'en').slice(0, 2),
      has_ctx: !!(ctx && Object.keys(ctx).length),
    });
  };
  const fireFailed = (mode, reason) => {
    mpTrack('Notification Failed', String(chatId), {
      kind, mode, reason: String(reason || 'unknown').slice(0, 200),
      lang: String(lang || 'en').slice(0, 2),
    });
  };
  // Try animation first; fall back to text-only if Telegram rejects the GIF
  // (CDN down, etc.). Caption supports the SAME Markdown as sendMessage.
  if (gif) {
    try {
      const r = await fetch(`${TELEGRAM_API}/sendAnimation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, animation: gif,
          caption: text, parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        }),
      });
      const j = await r.json();
      if (j && j.ok) { fireSent('animation'); return { ok: true, mode: 'animation', gif }; }
      // Else fall through to text
      console.warn('[notif] animation failed for kind', kind, '-', (j && j.description) || 'no desc');
    } catch (e) {
      console.warn('[notif] animation throw for kind', kind, '-', e.message);
    }
  }
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'Markdown',
        reply_markup: replyMarkup, disable_web_page_preview: true,
      }),
    });
    const j = await r.json();
    if (j && j.ok) {
      fireSent('text');
      return { ok: true, mode: 'text' };
    } else {
      const reason = (j && j.description) || 'unknown';
      fireFailed('text', reason);
      return { ok: false, mode: 'text', reason };
    }
  } catch (e) {
    fireFailed('text', e.message);
    return { ok: false, reason: e.message };
  }
}

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const TWO_MIN = 2 * 60 * 1000;

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
  saveUserState();
}

// Time-window helpers for power-hour and weekly triggers (UTC-anchored).
function utcNow() { return new Date(); }
function isPowerHourPreroll(d) {
  // 17:30-17:35 UTC (30 min before 18:00 power hour starts).
  return d.getUTCHours() === 17 && d.getUTCMinutes() >= 30 && d.getUTCMinutes() < 35;
}
function isPowerHourStart(d) {
  // 18:00-18:05 UTC (during the first 5 min of power hour).
  return d.getUTCHours() === 18 && d.getUTCMinutes() < 5;
}
function isWeeklyRecapWindow(d) {
  // Sunday 18:00-18:05 UTC (so it gets a single fire weekly, aligned w/ TG peak time).
  return d.getUTCDay() === 0 && d.getUTCHours() === 18 && d.getUTCMinutes() < 5;
}
function isTournamentClosingWindow(d) {
  // Sunday 19:00-19:05 UTC — 4 hours before Monday 00:00 UTC weekly close.
  // (Adjust if your tournament uses a different close time.)
  return d.getUTCDay() === 0 && d.getUTCHours() === 19 && d.getUTCMinutes() < 5;
}

async function notifyLoop() {
  const now = Date.now();
  const d = utcNow();
  const inPHPreroll = isPowerHourPreroll(d);
  const inPHStart = isPowerHourStart(d);
  const inWeeklyRecap = isWeeklyRecapWindow(d);
  const inTournClosing = isTournamentClosingWindow(d);

  let sent = 0;
  for (const [uid, st] of userState) {
    if (!st.chatId) continue;
    if (sent >= 30) break;   // safety cap per tick — Telegram rate limit ~30/sec
    const lang = String(st.lang || 'en').slice(0, 2);

    // --- Time-window triggers (highest priority, fire across all users) ---
    if (inPHPreroll && canSendNotif(st, 'power_hour_starting', now)) {
      const r = await sendNotification(st.chatId, lang, 'power_hour_starting');
      if (r.ok) { recordNotifSent(st, 'power_hour_starting', now); sent++; }
      continue;
    }
    if (inPHStart && canSendNotif(st, 'power_hour_active', now)) {
      const r = await sendNotification(st.chatId, lang, 'power_hour_active');
      if (r.ok) { recordNotifSent(st, 'power_hour_active', now); sent++; }
      continue;
    }
    if (inWeeklyRecap && canSendNotif(st, 'weekly_recap', now)) {
      const ctx = { games: st.totalGamesEver || 0, best: st.best || 0 };
      const r = await sendNotification(st.chatId, lang, 'weekly_recap', ctx);
      if (r.ok) { recordNotifSent(st, 'weekly_recap', now); sent++; }
      continue;
    }
    if (inTournClosing && st.tournamentRank && st.tournamentRank <= 50
        && canSendNotif(st, 'tournament_ending', now)) {
      const r = await sendNotification(st.chatId, lang, 'tournament_ending',
        { rank: st.tournamentRank });
      if (r.ok) { recordNotifSent(st, 'tournament_ending', now); sent++; }
      continue;
    }

    // --- Streak risk: streak > 0, expires within 4h, idle 30+ min ---
    if (st.streak > 0 && st.streakRiskAt && st.streakRiskAt > now
        && (st.streakRiskAt - now) < 4 * ONE_HOUR
        && (now - (st.lastActiveAt || 0)) > 30 * 60 * 1000
        && canSendNotif(st, 'streak_risk', now)) {
      const r = await sendNotification(st.chatId, lang, 'streak_risk',
        { streak: st.streak });
      if (r.ok) { recordNotifSent(st, 'streak_risk', now); sent++; }
      continue;
    }

    // --- Milestone close: 1 day away from 7/14/30/100-day milestone ---
    const milestones = [7, 14, 30, 100];
    const nextMs = milestones.find(m => st.streak === m - 1);
    if (nextMs && (now - (st.lastActiveAt || 0)) > 20 * ONE_HOUR
        && canSendNotif(st, 'milestone_close', now)) {
      const r = await sendNotification(st.chatId, lang, 'milestone_close',
        { streak: st.streak, milestone: nextMs });
      if (r.ok) { recordNotifSent(st, 'milestone_close', now); sent++; }
      continue;
    }

    // --- Season step close: within 5k of next step ---
    if (st.seasonPointsToNext && st.seasonPointsToNext > 0 && st.seasonPointsToNext < 5000
        && (now - (st.lastActiveAt || 0)) > 12 * ONE_HOUR
        && canSendNotif(st, 'season_step_close', now)) {
      const r = await sendNotification(st.chatId, lang, 'season_step_close',
        { points: st.seasonPointsToNext });
      if (r.ok) { recordNotifSent(st, 'season_step_close', now); sent++; }
      continue;
    }

    // --- Comeback: idle 3+ days ---
    if (st.lastActiveAt && (now - st.lastActiveAt) > 3 * ONE_DAY
        && canSendNotif(st, 'comeback', now)) {
      const r = await sendNotification(st.chatId, lang, 'comeback');
      if (r.ok) { recordNotifSent(st, 'comeback', now); sent++; }
      continue;
    }

    // --- Daily chest ready: idle 16+ hours, last chest claimed yesterday ---
    if (st.lastActiveAt && (now - st.lastActiveAt) > 16 * ONE_HOUR
        && canSendNotif(st, 'daily_chest', now)) {
      const r = await sendNotification(st.chatId, lang, 'daily_chest',
        { day: (st.chestDay || 1) });
      if (r.ok) { recordNotifSent(st, 'daily_chest', now); sent++; }
      continue;
    }

    // --- Daily challenge nudge: idle 18+ hours ---
    if (st.lastActiveAt && (now - st.lastActiveAt) > 18 * ONE_HOUR
        && canSendNotif(st, 'daily_challenge', now)) {
      const r = await sendNotification(st.chatId, lang, 'daily_challenge');
      if (r.ok) { recordNotifSent(st, 'daily_challenge', now); sent++; }
    }
  }
  if (sent > 0) console.log('[notify] sent ' + sent + ' in this tick');
}

// ============ Admin notification endpoints ============
// Admin-only: /api/admin/notify-test fires a test notification to the caller
// IMMEDIATELY, bypassing throttling. Use to verify the system works end-to-end
// without waiting for a trigger window. Example:
//   POST /api/admin/notify-test { initData, kind: "streak_risk" }
app.post('/api/admin/notify-test', async (req, res) => {
  const { initData, kind, ctx } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  if (!isAdmin(user.id)) return res.status(403).json({ error: 'admin only' });
  const st = userState.get(user.id) || {};
  const chatId = st.chatId || user.id;
  const lang = st.lang || (user.language_code || 'en').slice(0, 2);
  if (!NOTIF_COPY[kind]) {
    return res.status(400).json({
      error: 'unknown kind',
      available: Object.keys(NOTIF_COPY),
    });
  }
  const result = await sendNotification(chatId, lang, kind, ctx || {
    streak: 7, day: 3, rank: 5, points: 2400, games: 42, best: 12500, milestone: 14
  });
  res.json({ ok: result.ok, result, chatId, lang, kind });
});

// Curl-friendly variant: auth by BOT_TOKEN (same pattern as /api/setup-webhook).
// Pickle can fire this from his laptop without opening the Mini App.
// Example:
//   curl -X POST https://matryoshka-zlp6.onrender.com/api/admin/notify-fire \
//     -H "x-setup-key: $BOT_TOKEN" \
//     -H "Content-Type: application/json" \
//     -d '{"telegram_user_id":23040617,"kind":"streak_risk"}'
// v0.3.47 — buildCtxForUser pulls REAL per-user data (best score, streak,
// tournament rank, etc.) from users.json + userState so personalized
// notifications use accurate numbers. Falls back to provided ctx values
// for anything not in the user data.
function buildCtxForUser(telegramUserId, overrideCtx) {
  const uid = Number(telegramUserId);
  const stored = users[String(uid)] || users[uid] || {};
  const live = userState.get(uid) || userState.get(String(uid)) || {};
  return Object.assign({
    streak: stored.streak || live.streak || 0,
    day: stored.chestDay || 1,
    rank: live.tournamentRank || null,
    points: live.seasonPointsToNext || 0,
    games: stored.totalGamesEver || 0,
    best: stored.best || 0,
    score: stored.best || 0,        // alias — copy uses {score} for clarity
    milestone: 14,
  }, overrideCtx || {});
}

// resolveKindForUser swaps to new-player variant when the score is 0,
// otherwise returns the kind as-is. Currently only matters for
// beat_your_score; extend the table to add similar fallbacks for other
// score-dependent kinds in the future.
function resolveKindForUser(kind, ctx) {
  if (kind === 'beat_your_score' && (!ctx.score || ctx.score === 0)) {
    return 'beat_your_score_new_player';
  }
  return kind;
}

app.post('/api/admin/notify-fire', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key' });
  }
  const { telegram_user_id, kind, ctx, lang } = req.body || {};
  if (!telegram_user_id || !kind) {
    return res.status(400).json({ error: 'need telegram_user_id + kind',
      available_kinds: Object.keys(NOTIF_COPY) });
  }
  const st = userState.get(Number(telegram_user_id)) || {};
  const chatId = st.chatId || Number(telegram_user_id);
  const useLang = lang || st.lang || 'en';
  const resolvedCtx = buildCtxForUser(telegram_user_id, ctx);
  const resolvedKind = resolveKindForUser(kind, resolvedCtx);
  const result = await sendNotification(chatId, useLang, resolvedKind, resolvedCtx);
  res.json({
    ok: result.ok, result, chatId,
    lang: useLang, kind, resolved_kind: resolvedKind,
    used_ctx: resolvedCtx,
  });
});

// v0.3.47 — broadcast endpoint. Fires the same notification kind to ALL
// users with a known chatId, paced to stay under Telegram's 30 msg/sec
// global limit. Per-user ctx is auto-populated (so each user sees their
// own high score, streak, etc.). Throttling per kind/user is BYPASSED
// since this is explicit admin intent.
//
// Example dry-run (no actual sends, just audience count):
//   curl -X POST https://.../api/admin/notify-broadcast \
//     -H "x-setup-key: $BOT_TOKEN" -H "Content-Type: application/json" \
//     -d '{"kind":"beat_your_score","dry_run":true}'
//
// Real broadcast:
//   curl ... -d '{"kind":"beat_your_score","dry_run":false}'
//
// Limit to N test recipients (random sample):
//   curl ... -d '{"kind":"beat_your_score","dry_run":false,"limit":10}'
// v0.3.49 — module-level tracker. Updated by broadcast endpoint as the
// run progresses. Surveyable via GET /api/admin/last-broadcast.
let lastBroadcast = null;

app.post('/api/admin/notify-broadcast', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key' });
  }
  const { kind, ctx, dry_run, limit, only_user_ids } = req.body || {};
  if (!kind || !NOTIF_COPY[kind]) {
    return res.status(400).json({ error: 'unknown kind',
      available: Object.keys(NOTIF_COPY) });
  }
  // v0.3.50 — Broadcast audience now unions THREE sources:
  //   1. userState  — users with a recent chatId from /api/heartbeat
  //   2. users.json — users who have synced game state via /api/state/save
  //   3. Optional include_all_known via Mixpanel distinct_ids (TBD; for
  //      now we rely on 1+2 since leaderboard submitters typically end
  //      up in users.json anyway).
  // Key insight: a Telegram user_id IS their private-chat ID for bot DMs.
  // So even if we never captured an explicit chatId via heartbeat, we can
  // use the user_id directly as chatId. Telegram returns "Forbidden: bot
  // can't initiate conversation with a user" for anyone who never /start-ed
  // the bot — captured cleanly by lastBroadcast.errors.
  const audienceMap = new Map();
  // Source 1: userState — preserves lang preference
  for (const [uid, st] of userState) {
    if (!st.chatId) continue;
    audienceMap.set(String(uid), {
      uid: Number(uid) || uid, chatId: st.chatId, lang: st.lang || 'en', source: 'userState'
    });
  }
  // Source 2: users.json — fallback chatId = user_id, lang defaults 'en'
  for (const uidStr of Object.keys(users)) {
    if (audienceMap.has(uidStr)) continue;
    const uidNum = Number(uidStr);
    if (!uidNum || isNaN(uidNum)) continue;
    audienceMap.set(uidStr, {
      uid: uidNum, chatId: uidNum,
      lang: (users[uidStr] && users[uidStr].settings && users[uidStr].settings.lang) || 'en',
      source: 'users.json'
    });
  }
  let audience = Array.from(audienceMap.values());
  if (Array.isArray(only_user_ids) && only_user_ids.length) {
    const set = new Set(only_user_ids.map(String));
    audience = audience.filter(a => set.has(String(a.uid)));
  }
  if (typeof limit === 'number' && limit > 0) {
    for (let i = audience.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [audience[i], audience[j]] = [audience[j], audience[i]];
    }
    audience = audience.slice(0, limit);
  }
  if (dry_run) {
    const preview = audience.slice(0, 5).map(a => ({
      uid: a.uid, chatId: a.chatId, lang: a.lang,
      ctx: buildCtxForUser(a.uid, ctx),
      resolved_kind: resolveKindForUser(kind, buildCtxForUser(a.uid, ctx)),
    }));
    return res.json({ ok: true, dry_run: true, would_send_to: audience.length, sample_preview: preview });
  }
  // Initialize broadcast tracker BEFORE returning the HTTP response so
  // /api/admin/last-broadcast can report progress while the loop runs.
  lastBroadcast = {
    kind,
    started_at: new Date().toISOString(),
    finished_at: null,
    audience: audience.length,
    sent: 0,
    failed: 0,
    in_progress: 0,
    errors: {},          // { 'Forbidden: bot was blocked by the user': 3, ... }
    failed_uids: [],     // [{uid, reason}, ...]
    sent_uids: [],
  };
  // Fire-and-forget at the HTTP level — return audience count immediately,
  // let the broadcast continue in the background.
  res.json({ ok: true, broadcast_started: true, audience: audience.length, kind });
  (async () => {
    lastBroadcast.in_progress = audience.length;
    for (const a of audience) {
      const resolvedCtx = buildCtxForUser(a.uid, ctx);
      const resolvedKind = resolveKindForUser(kind, resolvedCtx);
      const result = await sendNotification(a.chatId, a.lang, resolvedKind, resolvedCtx);
      lastBroadcast.in_progress--;
      if (result.ok) {
        lastBroadcast.sent++;
        lastBroadcast.sent_uids.push(a.uid);
      } else {
        lastBroadcast.failed++;
        const reason = (result.reason || 'unknown').slice(0, 120);
        lastBroadcast.errors[reason] = (lastBroadcast.errors[reason] || 0) + 1;
        lastBroadcast.failed_uids.push({ uid: a.uid, reason });
      }
      await new Promise(r => setTimeout(r, 50));   // ~20/sec pace
    }
    lastBroadcast.finished_at = new Date().toISOString();
    console.log('[broadcast] kind=' + kind +
                ' sent=' + lastBroadcast.sent +
                ' failed=' + lastBroadcast.failed +
                ' total=' + audience.length);
  })().catch(e => {
    console.error('[broadcast] error:', e.message);
    if (lastBroadcast) lastBroadcast.error = e.message;
  });
});

// v0.3.49 — report on the most recent broadcast. Curl-friendly:
//   curl https://.../api/admin/last-broadcast -H "x-setup-key: $BOT_TOKEN"
// Returns null-shape if no broadcast has run since last server restart.
app.get('/api/admin/last-broadcast', (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key' });
  }
  res.json(lastBroadcast || { ok: false, error: 'no broadcast since last restart' });
});

// Admin-only: snapshot of notification state — who's eligible, last fires,
// per-kind counts. Useful for debugging "why didn't I get a notification?"
app.post('/api/admin/notify-status', (req, res) => {
  const { initData, only_me } = req.body || {};
  const user = validateInitData(initData || '');
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  if (!isAdmin(user.id)) return res.status(403).json({ error: 'admin only' });
  const now = Date.now();
  const summary = {
    bot_token_configured: !!BOT_TOKEN,
    user_state_count: userState.size,
    notif_kinds: Object.keys(NOTIF_COPY),
    gif_kinds: Object.keys(NOTIF_GIFS),
    now_utc: new Date().toISOString(),
    next_windows: {
      power_hour_preroll_utc: '17:30',
      power_hour_start_utc:   '18:00',
      weekly_recap_utc:       'Sun 18:00',
      tournament_closing_utc: 'Sun 19:00',
    },
    users: [],
  };
  for (const [uid, st] of userState) {
    if (only_me && Number(uid) !== Number(user.id)) continue;
    const lastAny = st.notifLastAny || 0;
    const idle = st.lastActiveAt ? Math.round((now - st.lastActiveAt) / 1000) : null;
    summary.users.push({
      uid, chatId: st.chatId, lang: st.lang,
      streak: st.streak || 0,
      idle_sec: idle,
      total_notifs_24h: (st.notifTimes || []).filter(t => now - t < ONE_DAY).length,
      sec_since_last_notif: lastAny ? Math.round((now - lastAny) / 1000) : null,
      last_by_kind: st.notifLast || {},
    });
  }
  summary.users.sort((a, b) => (b.idle_sec || 0) - (a.idle_sec || 0));
  if (only_me) summary.users = summary.users.slice(0, 1);
  else summary.users = summary.users.slice(0, 25);
  res.json(summary);
});

// ============ Channel auto-posts (v0.3.53) ============
// Scheduled posts to the @MatryoshkaMerge news channel. Different from
// the DM notification system — these are BROADCAST to the whole channel
// (everyone who subscribed, not personalized per user).
//
// Three slots fire on UTC clock:
//   - daily_challenge        at 00:05 UTC daily
//   - power_hour_live        at 18:00 UTC daily
//   - tournament_closing     at Sun 19:00 UTC weekly
//
// Each post includes a tappable PLAY NOW button (URL deep link, opens
// Mini App). Dedupe by UTC day + slot name so a 2-min poll never
// double-fires within a 5-min window. Persisted to disk so Render
// redeploys mid-window don't cause double-posts either.
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@MatryoshkaMerge';
const CHANNEL_POSTS_FILE = path.join(DATA_DIR, 'channel-posts.json');
let channelPostsToday = { ymd: '', slots: [] };
function loadChannelPosts() {
  try {
    if (!fs.existsSync(CHANNEL_POSTS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(CHANNEL_POSTS_FILE, 'utf8'));
    if (obj && obj.ymd && Array.isArray(obj.slots)) channelPostsToday = obj;
  } catch (e) { console.error('[channel] load failed:', e.message); }
}
function saveChannelPosts() {
  try { fs.writeFileSync(CHANNEL_POSTS_FILE, JSON.stringify(channelPostsToday)); }
  catch (e) { console.error('[channel] save failed:', e.message); }
}
loadChannelPosts();

const CHANNEL_POSTS_CATALOG = {
  daily_challenge: {
    text: "🌅 *Today's Daily Challenge is live!*\n\nSame seed, same dolls — every player gets the exact same queue today. " +
          "Who's going to top the daily leaderboard?\n\n_Resets in 24 hours._",
    button: { text: "🎯 PLAY DAILY", url: "https://t.me/MatryoshkaGameBot/app" },
  },
  power_hour_live: {
    text: "⚡ *POWER HOUR IS LIVE!*\n\nEvery gem. Every reward. Every chest. *Doubled* for the next 60 minutes.\n\n" +
          "Stack your boosters. Climb hard. The window closes at 19:00 UTC.",
    button: { text: "🚀 GO NOW", url: "https://t.me/MatryoshkaGameBot/app" },
  },
  tournament_closing: {
    text: "🏆 *Tournament closes in 5 hours!*\n\nLast push of the week. One great run can move you into the prize zone.\n\n" +
          "Top 10 take home Stars. Top 3 take home a LOT of Stars.",
    button: { text: "🏆 CLIMB NOW", url: "https://t.me/MatryoshkaGameBot/app" },
  },
};

async function sendChannelPost(slot) {
  const post = CHANNEL_POSTS_CATALOG[slot];
  if (!post || !BOT_TOKEN) return { ok: false, reason: 'unknown slot or no token' };
  try {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_USERNAME,
        text: post.text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[post.button]] },
      }),
    });
    const j = await r.json();
    if (j && j.ok) {
      console.log('[channel] posted slot=' + slot + ' msg_id=' + j.result.message_id);
      mpTrack('Channel Post Sent', 'server', { slot, message_id: j.result.message_id });
      return { ok: true, message_id: j.result.message_id };
    }
    console.warn('[channel] post failed slot=' + slot + ' err=' + (j && j.description));
    mpTrack('Channel Post Failed', 'server', { slot, reason: (j && j.description) || 'unknown' });
    return { ok: false, reason: (j && j.description) || 'unknown' };
  } catch (e) {
    console.error('[channel] throw:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function channelPostLoop() {
  if (!BOT_TOKEN) return;
  const now = new Date();
  const ymd = now.getUTCFullYear() + '-' +
              String(now.getUTCMonth() + 1).padStart(2, '0') + '-' +
              String(now.getUTCDate()).padStart(2, '0');
  if (channelPostsToday.ymd !== ymd) {
    channelPostsToday = { ymd, slots: [] };
    saveChannelPosts();
  }
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const dow = now.getUTCDay();   // 0 = Sunday

  const tryFire = async (slot, condition) => {
    if (!condition) return;
    if (channelPostsToday.slots.includes(slot)) return;
    const r = await sendChannelPost(slot);
    if (r.ok) {
      channelPostsToday.slots.push(slot);
      saveChannelPosts();
    }
  };

  // 00:05-00:10 UTC daily — new daily challenge live
  await tryFire('daily_challenge', h === 0 && m >= 5 && m < 10);
  // 18:00-18:05 UTC daily — power hour starts
  await tryFire('power_hour_live', h === 18 && m < 5);
  // Sunday 19:00-19:05 UTC — tournament closing reminder (5h before Mon 00:00)
  await tryFire('tournament_closing', dow === 0 && h === 19 && m < 5);
}

// Curl-friendly admin endpoint to fire any slot immediately for testing.
// Bypasses the time-window check + dedupe so you can verify the system
// without waiting for the scheduled UTC hour.
//   curl -X POST https://.../api/admin/channel-post \
//     -H "x-setup-key: $BOT_TOKEN" -H "Content-Type: application/json" \
//     -d '{"slot":"power_hour_live"}'
app.post('/api/admin/channel-post', async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN not set' });
  if (req.headers['x-setup-key'] !== BOT_TOKEN) {
    return res.status(403).json({ error: 'wrong setup key' });
  }
  const { slot } = req.body || {};
  if (!slot || !CHANNEL_POSTS_CATALOG[slot]) {
    return res.status(400).json({ error: 'unknown slot',
      available: Object.keys(CHANNEL_POSTS_CATALOG) });
  }
  const r = await sendChannelPost(slot);
  res.json(r);
});

// ============ Boot ============
app.listen(PORT, () => {
  console.log(`Matryoshka serving on port ${PORT}`);
  console.log(`IAP: ${BOT_TOKEN ? 'enabled' : 'DISABLED — set BOT_TOKEN env var to turn on'}`);
  console.log(`[tournament] current: ${tournament ? tournament.id : 'none'}`);
  if (BOT_TOKEN) {
    fetchBotIdentity();
    // v0.3.43 — tightened from 5 min → 2 min so time-window triggers
    // (power_hour_starting at 17:30 UTC, weekly_recap at Sun 18:00 UTC)
    // are guaranteed to fire inside their 5-min window even if a tick
    // gets delayed by a slow Telegram API response.
    setInterval(notifyLoop, TWO_MIN);
    console.log('[notify] loop armed — every 2 min');
    console.log('[notify] kinds:', Object.keys(NOTIF_COPY).join(', '));
    // v0.3.53 — channel auto-posts to @MatryoshkaMerge on UTC clock.
    setInterval(channelPostLoop, TWO_MIN);
    console.log('[channel] post loop armed — every 2 min, target ' + CHANNEL_USERNAME);
    console.log('[channel] slots:', Object.keys(CHANNEL_POSTS_CATALOG).join(', '));
  }
  // Hourly: roll over tournaments even without submissions, GC ephemeral state.
  setInterval(ensureTournament, 60 * 60 * 1000);
});
