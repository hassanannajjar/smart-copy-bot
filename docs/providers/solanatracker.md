# Solana Tracker Data API

Verified on **2026-10-28** against the official docs. Nothing here was tested with a real key; see "Unverified".

Sources:
- OpenAPI (PnL V2): https://docs.solanatracker.io/data-api/pnl-v2/openapi.json
- Leaderboard reference: https://docs.solanatracker.io/data-api/pnl-v2/leaderboard/solana-traders-leaderboard
- PnL V2 overview (modes, arbitrage tags, pagination): https://docs.solanatracker.io/guides/pnl-v2/overview
- Pricing: https://docs.solanatracker.io/pricing and https://www.solanatracker.io/data-api

Code: `packages/shared/src/providers/solanatracker.ts`. Fixtures: `packages/shared/test/fixtures/solanatracker/`.

## Auth
- Base URL: `https://data.solanatracker.io`.
- Send the key in the `x-api-key: <key>` header. It never goes in the URL.

## Endpoints used

### `GET /v2/pnl/leaderboard/top`: candidate source
Query parameters, with the values we send:

| Param | Values | Default | We send |
|---|---|---|---|
| `days` | 1, 7, 30, 90 (others snap to the nearest) | 90 | 30 and 90 |
| `sort` / `direction` | `realized`, `volume`, `days`, `roi`, `win_percentage`, `trades`, `tokens` / `asc`, `desc` | `realized` / `desc` | `realized` / `desc` |
| `minTrades` | int | 20 | 50 |
| `minDays` | int (active trading days) | 3 | 10 |
| `maxSingleTokenPct` | number; the max % of PnL that may come from one token | none | 30 |
| `excludeArbitrage` | `true`, `false` | `true` | `true` |
| `pnlMode` | `strict`, `adjusted`, `raw` | `strict` | `strict` |
| `limit` / `cursor` | int / opaque string | 100 / none | 100 / `pagination.nextCursor` |

Other filters we don't use yet: `minInvested`, `minWinRate`, `minRoi`, `minClosedTokens`, `platform`.

Response fields we read (everything else is stripped by zod):
- `traders[].wallet`
- `traders[].period.realized` (window realized PnL in USD)
- `traders[].period.days.winRate`
- `traders[].counts.trades`
- `traders[].winRate`
- `traders[].identity`:
  - `name`, `type`, `tags[]`
  - `exchange.name`, `pool.poolAddress`, `bot.name`
  - `hacker.label`, `spamDusting.label`
- `pagination.hasMore` and `pagination.nextCursor`

There is **no per-token PnL share** in the response. The `maxSingleTokenPct` filter is applied server-side only, so we compute `top_token_pct` ourselves (see below).

The `pnlMode` values:
- `strict` zeroes positions flagged as invalid PnL (where sells exceed buys).
- `adjusted` caps them.
- `raw` leaves them as they are.

The identity tags that matter here:
- `arbitrage`: a confirmed MEV or arbitrage operator.
- `potential_bot`: a heuristically detected bot.
- `bot`: a curated, named bot.

`identity.type` can also be `kol`, `developer`, `pool` or `bot`.

### `GET /v2/pnl/wallets/{wallet}/positions`: top-token check
We call it as `?filter=profitable&sort=realized&direction=desc&period=all&limit=200`. The parameters we use:
- `filter`: `all`, `holding`, `active`, `sold`, `profitable` or `losing`.
- `sort`: one of `last_trade`, `pnl`, `realized`, `unrealized`, `roi`, `value`, `holding`, `invested`, `cost`, `proceeds`, `buys`, `sells`.
- `period`: `1d`, `7d`, `14d`, `30d`, `90d` or `all`.
- `limit`: up to 200.

We read `positions[].pnl.realized` and `pagination.hasMore`.

`top_token_pct` is the largest profitable position's realized PnL divided by the sum of realized PnL across profitable positions.
- The scope is **all-time** (`enrich_period: all` in `rules.yaml`). The leaderboard's realized PnL and win rate cover the 30/90-day window instead, so the two scopes differ.
- Only the first page (200 rows) is summed. When `hasMore=true`, the denominator is understated, so the percentage is overstated and errs toward dropping. Those rows are marked `top_token_partial=true`.

## Rate limits and pricing (as published)
| Plan | Price/mo | Requests/mo | Rate |
|---|---|---|---|
| Free | €0 | **10,000 per docs.solanatracker.io/pricing; 2,500 per solanatracker.io/data-api (conflict)** | 3 req/s |
| Advanced | €50 | 200K | no limit |
| Pro | €200 | 1M | no limit |
| Premium | €397 | 10M | not stated |

- Over-quota or over-rate requests return `429`. No `Retry-After` header is documented; we honour it if present and otherwise back off exponentially with jitter.
- No per-call credit cost is documented for PnL V2. The Data API is metered per request.
- The docs don't say whether the Free plan includes PnL V2 or the leaderboard.

**Cost per discovery run:** up to 2 windows × 2 pages leaderboard calls, plus up to 40 positions calls, so about 44 requests. Our throttle is `min_interval_ms: 350`, under the free plan's 3 rps.

## Unverified until a key exists
- The real response shapes. The fixtures are the official OpenAPI examples, and the doc example rows omit `identity.tags` and `type`.
- Whether the Free plan can call `/v2/pnl/*`, and which monthly quota applies.
- Whether `maxSingleTokenPct` measures the same thing as our all-time `top_token_pct`.

To refresh the fixtures with real data, run `pnpm wallets:discover --record`.

## Field notes from the first real recording (2026-10-28)
- **Win rate:** the top-level `winRate` is the **token** win rate, i.e. `tokens.profitable / tokens.closed`. For example, 38/54 gives 70.37.
  - `period.days.winRate` is the share of **profitable days**, a different and much rosier number. It's often 100%.
  - Discovery uses `winRate`.
- **Trade size:** `averages.buy` is the average buy in USD; on the recorded page the median was $214 and the max $50k. It is used for `whale_trade_size`. When it is missing, discovery falls back to `period.volume / counts.trades`.
- **Hold time:** `positions[].timing.holdTimeSecs` is present on every position. Discovery's `short_hold` filter uses the median across the first page of profitable positions (up to 200, all-time). Profitable-only positions bias the sample toward winning flips.
- **Leaderboard bias:** sorted by `realized`, the top of the leaderboard is mostly high-frequency wallets. On the first recorded 30d page, 85 of 100 rows had more than 150 trades/day, so `max_pages` was raised to 5.
