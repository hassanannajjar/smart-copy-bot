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
pnpm start                # M0: boots the engine in PAPER and exits
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

Every threshold lives in [`config/rules.yaml`](config/rules.yaml). Values marked `placeholder, tune` were not fixed by the plan and still need review.

## Layout

```
apps/engine        pipeline process (M0: boot only) + discover/ (wallet discovery CLI)
docs/providers/    verified notes per external API (endpoints, auth, limits, pricing)
apps/dashboard     Next.js placeholder (M4)
packages/shared    zod config/env, Drizzle schemas + migrations, mode/DB paths
config/rules.yaml  all thresholds
data/              SQLite files (gitignored), raw/ replay events (gitignored)
```

## Wallet discovery (M0.5)

`pnpm wallets:discover` builds a **shortlist for manual review**. It never edits `data/wallets.csv`; you copy the wallets you choose into that file yourself.

- **Sources:**
  - the Solana Tracker top-traders leaderboard, with the consistency filters from the `discovery:` section of `rules.yaml`
  - Birdeye trader gainers, plus Birdeye wallet identity to filter out exchanges and programs
  - Birdeye has no `smart_trader` leaderboard filter; see [docs/providers/birdeye.md](docs/providers/birdeye.md).
- **Drops:**
  - arbitrage/MEV bots, by tag or by more than `max_trades_per_day` trades/day
  - exchange, pool and program addresses
  - unprofitable rows
  - wallets whose top token makes up more than 30% of their profit
- **Rank:**
  1. verified (top-token check done)
  2. profitable in both windows
  3. seen by both providers
  4. win rate
  5. realized PnL
- **Output:** `data/wallets.candidates.csv` (gitignored) with these columns: `address, label, source, window, realized_pnl, win_rate, trades, pnl_per_trade, top_token_pct, top_token_partial, verified`.
- **Scopes:**
  - `realized_pnl` and `win_rate` cover the leaderboard window.
  - `top_token_pct` covers all-time profitable positions, and only the first page of them when `top_token_partial=true`.
- **Fixtures:** the test fixtures in `packages/shared/test/fixtures/` are **doc-derived** (official OpenAPI examples) until you run once with `--record` and a real key.
