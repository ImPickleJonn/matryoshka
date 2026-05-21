# Matryoshka — Deploy & Telegram Setup

End-to-end checklist for getting `https://github.com/ImPickleJonn/matryoshka` running as a live Telegram Mini App. Mirrors the same flow that put Match Icon and Fat Stack live.

## 1 · Create the bot in Telegram

1. Open `@BotFather` in Telegram.
2. `/newbot` → name it, e.g. **Matryoshka** → username e.g. `MatryoshkaDropBot`.
3. **Save the `BOT_TOKEN`** that BotFather returns. You'll paste it into Render in step 3.
4. (Optional) `/setdescription`, `/setabouttext`, `/setuserpic` to brand it.

Don't set the Mini App URL yet — we need the deploy URL first.

## 2 · Deploy on Render via Blueprint (primary)

Render reads `render.yaml` from the repo and provisions everything automatically.

1. Render dashboard → **New +** → **Blueprint**.
2. Connect the GitHub repo `ImPickleJonn/matryoshka`.
3. Render reads `render.yaml`, shows a preview:
   - 1 web service named `matryoshka`
   - 1 disk `matryoshka-data` mounted at `/data` (persists leaderboard + tournament + users + share PNGs across redeploys)
   - 3 env-var slots: `DATA_DIR=/data`, `PUBLIC_DOMAIN` (auto-wired from the service host), `TELEGRAM_ADMIN_IDS=23040617`
   - 1 env var marked `sync: false` → **`BOT_TOKEN` — paste the value from step 1**
4. Apply Blueprint. First build takes ~90 s.
5. When it goes green, note the service URL (e.g. `https://matryoshka.onrender.com`).

> **Free plan caveat:** Render Free spins the service down after 15 min of no traffic. For a launch test it's fine — the first request after sleep takes ~30 s to wake. Bump to Starter ($7/mo) when you're past testing.

## 3 · Register the Telegram webhook

One-shot curl. Uses the `BOT_TOKEN` as the setup key so only someone who already has it can register the webhook.

```bash
curl -X POST https://matryoshka.onrender.com/api/setup-webhook -H "x-setup-key: <BOT_TOKEN>"
```

Replace `matryoshka.onrender.com` with your actual Render URL.

Verify with `https://matryoshka.onrender.com/api/diag` — `webhook.url` should now point at `/api/telegram-webhook`.

## 4 · Wire the Mini App URL in BotFather

1. `@BotFather` → `/mybots` → pick your bot.
2. **Bot Settings → Menu Button → Configure menu button**:
   - Button text: `🪆 Play`
   - URL: `https://matryoshka.onrender.com`
3. **Bot Settings → Configure Mini App** → set the same URL.
4. **Edit Bot → Edit Bot Privacy → privacy policy URL**: `https://matryoshka.onrender.com/privacy.html`

## 5 · Test it

Open your bot in Telegram, send `/start`. You should get the EN/RU welcome message with a **PLAY MATRYOSHKA** button. Tap it.

What you should see (in order):
1. Brief splash screen with the bobbing 🪆 logo
2. **FTUE** — 5-step animated tutorial (drop, merge, death line, Tsaritsa goal). Skippable.
3. The game itself, with the carrier doll at top, the jar below, and the mascot Grandma in the bottom-left.

Walk through:
- **Drop** a few dolls, watch them merge.
- **Combos** — chain merges within ~1.4 s to see the flash text + multiplier scale up.
- **Daily mode** — tap 🌅 Daily under the score row to switch to the seeded daily challenge.
- **Earn tab** — daily chest, streak milestones, tournament panel, achievements, leaderboard.
- **Shop tab** — try the `test_purchase` 1⭐ SKU (admin-only — works because your Telegram ID `23040617` is in `TELEGRAM_ADMIN_IDS`). The Stars payment dialog should appear; pay 1⭐; back in the app you should see "Purchase added!" with +1 gem.

## 6 · After-deploy checklist

- [ ] `/api/diag` returns version `v0.3.0`, `bot_token_configured: true`, webhook URL pointed at your service
- [ ] `/start` welcome message arrives and Mini App opens
- [ ] FTUE shows on first launch
- [ ] Test purchase completes end-to-end
- [ ] Power Hour banner appears between 18:00-19:00 UTC (or wait for the window)
- [ ] Tournament tab shows current ISO week + seeded leaderboard

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Mini App opens to a white screen | Render service still spinning up | Wait 30 s, refresh |
| Shop button shows "Open from Telegram to buy" | initData missing — you opened it outside Telegram | Open from inside the bot |
| Stars invoice fails | `BOT_TOKEN` not set on Render | Settings → Environment → add `BOT_TOKEN` → manual redeploy |
| Webhook last_error_message: "Wrong response..." | Webhook secret mismatch from prior deploy | Re-run `setup-webhook` curl |
| FTUE doesn't show | localStorage has stale `ftueDone: true` | Open via incognito or wipe localStorage |

## Where things live

- **Code:** https://github.com/ImPickleJonn/matryoshka
- **Render service:** matryoshka.onrender.com (yours)
- **Bot:** whatever username you gave it in step 1
- **Persistent data:** Render disk at `/data` — survives redeploys
- **Versions/rollback:** any `versions/matryoshka-vN.html` can be copied back to `index.html` to roll back

## Railway as warm backup (optional)

The `railway.json` Blueprint config is also committed. To stand up a Railway backup:

1. railway.com → New Project → Deploy from GitHub repo → `ImPickleJonn/matryoshka`
2. Add the same env vars (`BOT_TOKEN`, `DATA_DIR=/data` if you mount a Railway volume, `TELEGRAM_ADMIN_IDS=23040617`)
3. Railway auto-deploys but won't register the webhook automatically — if Render goes down, hit `/api/setup-webhook` against the Railway URL to point Telegram at it instead.

This mirrors the Match Icon backup pattern.
