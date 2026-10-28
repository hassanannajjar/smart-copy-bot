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

Every threshold lives in [`config/rules.yaml`](config/rules.yaml). Values marked `placeholder, tune` were not fixed by the plan and still need review.

## Layout

```
apps/engine        pipeline process (M0: boot only)
apps/dashboard     Next.js placeholder (M4)
packages/shared    zod config/env, Drizzle schemas + migrations, mode/DB paths
config/rules.yaml  all thresholds
data/              SQLite files (gitignored), raw/ replay events (gitignored)
```
