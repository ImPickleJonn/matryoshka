# Matryoshka

A drop-and-merge nesting-doll puzzle for Telegram. Mechanics inspired by the proven Suika / Watermelon-merge category, re-skinned with 11 tiers of Russian nesting dolls — drop them into the jar, merge two same-size dolls into the next size up, climb all the way to the **Tsaritsa**.

Single-file frontend (`index.html`), Express server (`server.js`), Stars-only IAP (no ads, ever).

## Local dev

Double-click `RUN.bat`. The script installs dependencies on first run, boots the Node server on `http://localhost:3000`, and opens a browser tab.

If you don't have Node, grab the LTS from https://nodejs.org.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-file frontend: HUD, canvas game, physics, 3 tabs (Shop / Play / Earn), i18n EN+RU |
| `server.js`  | Express + Stars IAP + leaderboard + state-sync + bot welcome + notification cron |
| `RUN.bat`    | Local dev launcher (npm install + node server.js + open browser) |
| `privacy.html` / `terms.html` | Required for Telegram Mini App registration |
| `versions/`  | Rollback snapshots — copy `index.html` to `versions/matryoshka-vN.html` before substantive edits |
| `assets/`    | Optional drop-in art — `welcome.png|jpg|gif|mp4` upgrades the /start bot message |

## Game mechanic

- 11 tiers of matryoshka (`Зёрнышко` → `Царица`). Player drops one of the smallest 5 from a finger position above the jar.
- Two same-tier dolls touching = merge into the next size, awarding tier-scaled score (3, 6, 10, 15, 21, 28, 36, 45, 55, 66).
- Two Tsaritsas (T11) touching = celebration burst + 200 bonus points, both removed.
- Any stationary doll above the dashed death line for ~1.6 s = game over.

## Scope status (v0.3.0 — 2026-05-20)

### v0.3.0 — combat polish + retention layer

- ✅ **Combo system** — chained merges within a 1.4 s window stack a multiplier: 2× → 1.5×, 3× → 2×, 4× → 2.5×, 5× → 3×, … capped at 5×. Combo flash text scales 0.4 → 1.2 → 1 with rotation, escalating labels `NICE → COMBO → SWEET → INSANE → LEGENDARY → GODLIKE → TSARITSA`. Combo-tier sound is a 3-note arpeggio rising with the combo count; haptic escalates from `light` → `medium` → `heavy` at combo ≥ 4. Tracked in `state.bestComboEver`.
- ✅ **Power Hour** — daily 18:00-19:00 UTC server window (`/api/power-hour`). Animated pink-to-orange pulsing banner fixed at top of screen during the hour. While active, all reward grants get a 2× multiplier — **stacks with Battle Pass** (BP + PH = 4× max). Banner shows minutes remaining; polled every 5 min. `rewardMultiplier()` + `multiplierLabel()` helpers replace all the per-claim battle-pass-only logic so chest, missions, achievements, and milestones all benefit consistently.
- ✅ **Canvas mascot** — bottom-left corner T7 doll (canvas-drawn, 68×80 px). Idle sin-wave bob; squash-stretch impulse on every merge (scales with combo count); sparkle overlay when in `wow` mood; tilted-sad on game-over. Tap-to-cheer speech bubble with localized random lines (`MASCOT_LINES.intro/combo/gameover/cheer`).
- ✅ **Splash screen** — full-bleed branded boot screen: 🪆 emoji with bob/rotate animation, "MATRYOSHKA · DROP · MERGE · REIGN" title, animated progress bar. Auto-dismisses after 1.5 s, fading out and removing itself. FTUE opens immediately after.
- ✅ **Stats panel** — accessible via Settings → 📊 Stats. 9 lifetime rows: Best Score (Endless), Best Daily Today, Highest Tier, Best Combo, Games Played, Total Merges, Current Streak, Gems, Skins Owned (X / 5).
- ✅ **Streak milestones** — new Earn-tab section with 5 claimable tiles: 3 / 7 / 14 / 30 / 100 day streaks → 30 / 100 / 300 / 750 / 2500 💎. Unlocked-but-unclaimed tiles pulse with claim animation. Multiplier-aware.
- ✅ **2 new skins**: **Neon** (200⭐) — cyber-vibrant body colors cycling through 11 hues, dark-galaxy aprons, white sparkle accents; **Wood** (200⭐) — warm hand-carved wood tones (light cherry → dark walnut → birch) with brown scarves. Full palette overrides via the existing `SKINS` registry. Skin picker in Settings now shows all 5.
- ✅ **5 more achievements** (15 total) — `combo_5` / `combo_10` / `daily_first` / `collector_3` / `collector_5`. `markAchievementProgress(id)` side-flag system handles event-driven unlocks (combo highs, Tsaritsa pair, daily play).
- ✅ **Tsaritsa × Tsaritsa detection** — wired to `tsarina_pair` achievement hook on the double-Tsaritsa merge event.
- ✅ **i18n full coverage** — every one of the 20 supported languages now ships ~15+ keys (HUD + tabs + modes + game-over + settings + earn + how-to-play + stats). EN + RU still cover every key including FTUE bodies + step copy; the other 18 fall back gracefully via `t()`.

## Scope status (v0.2.1 — 2026-05-20)

### v0.2.1: FTUE
- ✅ **First-time tutorial** — 5-step animated overlay (`#ftue-shade`) shown on first launch with skippable progression dots and Back/Next nav.
  1. **Welcome / pyramid** — title + the full 11-tier doll progression rendered as a row to show the size-up journey
  2. **Slide and Drop** — animated finger hint sliding a carrier across the jar then dropping
  3. **Same Sizes Merge!** — two T1 dolls fall, collide, flash, become a T2 with a +3 score popup
  4. **Watch the Red Line** — pulsing dashed death line + bobbing doll with red glow over it
  5. **Reach the Tsaritsa 👑** — orbiting sparkles around a bobbing T11 with crown
- ✅ Replay via Settings → **🎓 How to Play** button
- ✅ Migration: pre-v0.2.1 users (who already had `state.welcomed=true`) are not forced through the tutorial — `state.ftueDone` is set silently
- ✅ i18n: all FTUE strings full in **EN + RU**, and step titles/bodies in **es / pt / fr / de / uk**
- ✅ `state.ftueDone` only flips true when the user finishes step 5 OR taps Skip — closing mid-tutorial replays it next session

## Scope status (v0.2.0 — 2026-05-20)

### Core gameplay
- ✅ Physics: gravity, circle-circle collision with iterative solver, walls/floor, restitution, dampening
- ✅ 11 canvas-drawn matryoshka tiers (face, scarf, apron, floral motif, Tsaritsa crown)
- ✅ Drop UX: finger-drag carrier, drop on release, 420ms cooldown
- ✅ Score, high score, merge count, streak, tier-progression dock
- ✅ Game over + revive (consumes one revive, clears top 3 dolls)
- ✅ Particles, screen shake, floating score popups, audio synth (drop / merge / game-over / claim)

### v0.2 layered features
- ✅ **Daily Challenge mode** — Mulberry32 PRNG seeded from UTC date via `/api/daily-seed`; every player sees the same drop queue. Mode toggle pill (Endless / 🌅 Daily) under the score row. Score submits to the separate `daily` leaderboard branch.
- ✅ **Weekly Tournament** — ISO-week tournament file (`data/tournament.json`); top 10 win 1500/1000/700/500/350/250/200/200/150/150 💎. Every game-over auto-submits. Prizes deliver via the `pendingByUser` queue → polled on next session. Tournament panel in Earn tab shows live top 25, prize chips, ends-in countdown.
- ✅ **Skin renderer** — `getPalette(tier)` reads `state.activeSkin`. Three skins: `classic` (default), `khokhloma` (black lacquer + gold scarves), `gzhel` (white porcelain + cobalt). Skin picker in Settings modal; locked skins route to Shop.
- ✅ **Undo button** — appears in topbar when an undo is available + `state.undos > 0`. Records a full world snapshot before each drop; restores score, merges, and dolls in one shot. Disabled in Daily mode to keep the seeded queue fair.
- ✅ **Share-card PNG** — 800×800 canvas-rendered card (gradient + framed title + centerpiece doll at best tier + huge score + footer). Uploads to `/api/share/upload` (auth via initData, 1 MB cap, UUID-named, 48 h GC); returned URL is fed to `openTelegramLink` for the share dialog.
- ✅ **Achievements** — 10 one-time achievements (first merge, reach each tier T4/T6/T8/T10/T11, 10/50 games, 100 merges, 30-day streak). Auto-unlocked on game-over via `checkAchievements()`; player taps Claim to grant gems. 2× when Season Pass is active.
- ✅ **Battle Pass UI** — banner at top of Earn tab when `state.battlePassUntil > Date.now()`; shows days left. Active pass = 2× on daily chest, missions, achievement claims.
- ✅ **Welcome asset auto-detect** — `/start` prefers `assets/welcome.gif|mp4` (animation) > `assets/welcome.png|jpg` (photo) > text-only. Caption stays the same.
- ✅ Tournament prize modal — when a prize lands via poll-purchases, a celebration modal pops with rank + gem count.

### Structural
- ✅ 3-tab structure: **Shop** (11 Stars SKUs) / **Play** (the game) / **Earn** (BP banner + tournament + 7-day chest + 5 missions + 10 achievements + leaderboard)
- ✅ i18n: **EN + RU full** with all new keys (mode_endless, mode_daily, skin, achievements, tournament, bp_active, no_undo, no_undos_left). **es / pt / fr / de / uk** now cover ~25 keys each (was ~7). 13 other langs still have header strings + EN fallback.
- ✅ Telegram WebApp: theme color, expand, haptics, safe-area insets, openInvoice + poll-purchases (drained on boot + after each purchase)
- ✅ Server: Stars IAP, `/api/score/submit` (regular + daily, auto-tournament), `/api/tournament/current`, `/api/leaderboard`, `/api/share/upload`, `/api/daily-seed`, state load/save, `/start` welcome (EN+RU with asset auto-detect), notification cron

### Not yet
- ⏳ Real channel URL for `follow` mission (currently placeholder `https://t.me/matryoshkagame`)
- ⏳ Custom mascot / splash art (canvas-drawn dolls are the only art)
- ⏳ Daily-mode dedicated leaderboard UI (the toggle is in the LB section but no daily-specific scoreboard view beyond the existing "Today" tab)
- ⏳ Translate remaining 13 languages fully (nl/it/sv/pl/tr/ar/he/hi/id/vi/zh/ko/ja still header-only)
- ⏳ Battle pass quest tracker (multiplier works, but no per-quest UI beyond the banner)

## Workflow rules

- Read the relevant section of `index.html` before editing (see numbered `[JS-NN]` section comments).
- Before substantive edits, snapshot to `versions/matryoshka-vN.html`. **Use numeric sort to find next N** (PowerShell `Sort-Object Name` is alphabetical and will put `v10` before `v9`):
  ```powershell
  Get-ChildItem versions | Sort-Object { [int]($_.BaseName -replace 'matryoshka-v','') } | Select-Object -Last 1
  ```
- After any HTML edit, parse-check inline scripts:
  ```
  node -e "const html=require('fs').readFileSync('index.html','utf8'); const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; let i=0; for(const s of m){ i++; try { new Function(s[1]); } catch(e) { console.log('FAIL block '+i+': '+e.message); process.exit(1); } } console.log('OK ('+i+' blocks)');"
  ```
- Workflow: double-click `RUN.bat` → refresh `localhost:3000`.

## Stars SKUs (mirrored in `SKUS` const in both `server.js` and `index.html`)

| SKU | Price | Grant |
|---|---|---|
| `revive` | 30⭐ | 1 revive |
| `preview_pack` | 50⭐ | 10 next-doll previews |
| `undo_pack` | 60⭐ | 5 undos |
| `gems_small` | 99⭐ | 500 gems |
| `starter_pack` | 199⭐ | 1500 gems + 3 revives + Khokhloma skin (featured) |
| `gems_big` | 399⭐ | 3500 gems |
| `gems_mega` | 750⭐ | 12000 gems |
| `skin_khokhloma` | 150⭐ | Black-gold lacquer skin |
| `skin_gzhel` | 150⭐ | Cobalt porcelain skin |
| `streak_shield` | 99⭐ | 7-day streak insurance |
| `battle_pass` | 500⭐ | 30-day pass |
| `test_purchase` | 1⭐ | Admin smoke test |

## Deploy

Configs for Render (`render.yaml`) and Railway (`railway.json`) follow the same shape as Match Icon and Fat Stack — env vars: `BOT_TOKEN`, `PUBLIC_DOMAIN`, `DATA_DIR=/data` (for Render disk).

After deploy, register the Telegram webhook once:

```
curl -X POST https://<your-domain>/api/setup-webhook -H "x-setup-key: <BOT_TOKEN>"
```

## License

Proprietary. © Pickle.
