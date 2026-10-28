# Smart-Money Copy Bot (Solana)

Personal research system that:
- watches a curated list of Solana wallets
- turns their buys into signals
- kills signals that fail 6 hard rules (fail-closed)
- paper-trades the survivors with realistic latency, slippage and fees
- shows the funnel on a dashboard

Live trading comes last, behind a strict gate. Personal use only: no managing others' funds, no selling signals, no MEV or market manipulation.

The full spec is in [PLAN.md](PLAN.md) and the agent conventions are in [CLAUDE.md](CLAUDE.md).

## Reality check

- Screenshots like "17x, 67% win rate" are usually cherry-picked marketing. Expect most signals to lose.
- By the time we *see* a smart wallet's buy, the price has already moved. Copy latency is the core edge problem.
- Many "smart wallets" are insiders or devs of the tokens they buy. Rugs gap down, and a stop-loss does not save you from a rug.
- **Success metric for the paper phase:** net-positive PnL **after** fees, slippage and simulated latency, over at least 4 weeks and 50 closed trades, with acceptable max drawdown. Anything less means do not go live.

## Modes

| Mode | Data | Money | DB file |
|---|---|---|---|
| DEMO | seeded fake data, no engine, no network | none | `data/demo.db` |
| PAPER (default) | real market data | simulated | `data/paper.db` |
| LIVE | real | real, tiny hot wallet | `data/live.db` |

- `data/control.db` holds the requested/active mode, the kill switch and the audit log of every mode switch. No reset script touches it.
- The engine **always boots in PAPER**. LIVE needs `LIVE_ENABLED=true` and `LIVE_CONFIRM=I_UNDERSTAND_THE_RISK` in the engine env, plus the dashboard confirmation flow (milestone M7).

## Setup

Requires Node 24+ (`.nvmrc` pins 26, the current LTS) and pnpm.

```sh
pnpm i
cp .env.example .env      # fill in provider keys; never commit .env
pnpm build
pnpm db:migrate           # creates data/control.db + demo/paper/live.db
pnpm start                # boots in PAPER and runs the scout (needs HELIUS_API_KEY); Ctrl-C to stop
```

| Command | What it does |
|---|---|
| `pnpm build` | compile all packages |
| `pnpm test` | vitest, no network |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm db:generate` | regenerate SQL migrations after a schema change |
| `pnpm db:migrate` | apply migrations to all four DB files |
| `pnpm wallets:discover` | build `data/wallets.candidates.csv` from provider leaderboards (needs `SOLANATRACKER_API_KEY` and/or `BIRDEYE_API_KEY`) |
| `pnpm wallets:discover --record` | same, and save the raw responses as test fixtures |
| `pnpm start [--record]` | run the engine (scout); `--record` saves Helius fixtures |

Every threshold lives in [`config/rules.yaml`](config/rules.yaml). Values marked `placeholder, tune` were not fixed by the plan and still need review.

## Layout

```
apps/engine        pipeline process: scout/ (M1) + discover/ (wallet discovery CLI)
docs/providers/    verified notes per external API (endpoints, auth, limits, pricing)
apps/dashboard     Next.js placeholder (M4)
packages/shared    zod config/env, Drizzle schemas + migrations, mode/DB paths
config/rules.yaml  all thresholds
data/              SQLite files (gitignored), raw/ replay events (gitignored)
```

## Scout (M1)

`pnpm start` boots in PAPER, loads `data/wallets.csv`, and streams every wallet's transactions from Helius. It needs `HELIUS_API_KEY` in `.env`.

- **Fails closed:** a bad address, a duplicate or a wrong header in `wallets.csv` stops the engine and names the line. The list is reloaded on restart.
- **What it writes:**
  - Each SOL-quoted buy or sell becomes a row in `signals` in `data/paper.db`, with `detect_latency_ms`. The engine writes PAPER data there whatever the dashboard shows.
  - Every fetched transaction is appended to `data/raw/scout-YYYY-MM-DD.jsonl` for replay.
  - A heartbeat every 60 s, plus connection status, goes to `events_log` (`stage='scout'`).
- **Reconnects:** after a drop, it reconnects with exponential backoff and jitter, then backfills missed transactions. On boot it also backfills from each wallet's latest stored signal.
- **Kill switch:** it does not stop the scout. It only blocks opening positions later.
- `pnpm start --record` also saves real responses as fixtures in `packages/shared/test/fixtures/helius/`.

Why this design, and what it costs in credits (about 2.5% of the free plan): [docs/providers/helius.md](docs/providers/helius.md).

## Wallet discovery (M0.5)

`pnpm wallets:discover` builds a **shortlist for manual review**. It never edits `data/wallets.csv`; you copy the wallets you choose into that file yourself.

- **Sources:**
  - the Solana Tracker top-traders leaderboard, with the consistency filters from the `discovery:` section of `rules.yaml`
  - Birdeye trader gainers, plus Birdeye wallet identity to filter out exchanges and programs
  - Birdeye has no `smart_trader` leaderboard filter; see [docs/providers/birdeye.md](docs/providers/birdeye.md).
- **Drops:**
  - arbitrage/MEV bots, by tag or by more than `max_trades_per_day` trades/day (`bot_trade_rate`)
  - a token win rate ≥ 90% over ≥ 300 trades (`implausible_win_rate`)
  - an average trade above $10k (`whale_trade_size`), since we copy about $50
  - a median position hold under 120s, for enriched wallets (`short_hold`)
  - exchange, pool and program addresses
  - unprofitable rows
  - wallets whose top token makes up more than 30% of their profit
- **Rank:**
  1. verified (top-token check done)
  2. identity checked (Birdeye identity returns 401 on the free plan, so Birdeye-only rows are unchecked)
  3. profitable in both windows
  4. seen by both providers
  5. win rate
  6. realized PnL
- **Output:** `data/wallets.candidates.csv` (gitignored) with these columns: `address, label, source, window, realized_pnl, win_rate, trades, pnl_per_trade, top_token_pct, top_token_partial, verified, trades_per_day, avg_trade_usd, median_hold_s, identity_checked`. The report ends with a human-likeness line giving the medians of the final list.
- **Scopes:**
  - `realized_pnl`, `win_rate` (token win rate) and `trades_per_day` cover the leaderboard window.
  - `top_token_pct` and `median_hold_s` cover all-time profitable positions, and only the first page of them when `top_token_partial=true`.
- **Fixtures:** the test fixtures in `packages/shared/test/fixtures/` are **doc-derived** (official OpenAPI examples) until you run once with `--record` and a real key.

## Dashboard (M4)

```sh
pnpm db:migrate
pnpm db:seed:demo   # fills data/demo.db with fake data (refuses a symlinked target)
pnpm dashboard      # http://127.0.0.1:3000, bound to localhost only
```

- The **data view** switcher (DEMO / PAPER / LIVE) only picks which DB file the panels read. It lives in a browser cookie and never touches `control.db` or the engine.
- The **engine banner** always shows the engine mode from `control.db`, whatever the view. While the engine is LIVE it turns solid red, and the tab title and favicon change too.
- The dashboard can request PAPER and toggle the kill switch. LIVE requests are rejected and logged in `mode_changes` until M7.
- Pages: Overview (stats, funnel, kill reasons, copy log), Mode history and Settings (`rules.yaml`, read-only). Pages refresh every 5 s.
