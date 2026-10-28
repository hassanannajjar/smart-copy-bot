# Birdeye Data API

Verified on **2026-10-28** against the official docs. Nothing here was tested with a real key; see "Unverified".

Sources:
- OpenAPI (Data API): https://data.birdeye.so/docs/openapi/data/openapi_docs.json
- Page index: https://data.birdeye.so/docs/llms.txt (`docs.birdeye.so` redirects here)
- Gainers/Losers: https://data.birdeye.so/docs/data-api/wallet-networth-pnl/get-trader-gainers-losers.md
- Wallet Leaderboard: https://data.birdeye.so/docs/data-api/wallet-networth-pnl/get-wallet-v2-leaderboard.md
- Changelog, trader score (2026-09-24): https://data.birdeye.so/docs/changelog/20260924-release-gainers-losers-filters-and-trader-score.md
- Pricing: https://data.birdeye.so/docs/guides/payment/pricing.md
- Rate limits: https://data.birdeye.so/docs/guides/api-access/rate-limiting/index.md

Code: `packages/shared/src/providers/birdeye.ts`. Fixtures: `packages/shared/test/fixtures/birdeye/`.

## Important: there is no `wallet_tags=smart_trader` leaderboard
No Birdeye wallet or trader leaderboard accepts a `wallet_tags` or `smart_trader` filter. I checked by searching the full OpenAPI spec.
- `wallet_tags` exists only on `POST /defi/v3/token/money-flow`. It is token-level buy/sell flow, its values are `all`, `smart_money`, `kol` and `whales`, and it returns no wallets.
- `smart_trader` exists only as a **per-token** holder label:
  - `GET /token/v1/holder-positions?labels=smart_trader`
  - `GET /token/v1/wallet-tags-tracker[/details]?tags=smart_trader`

To get wallets tagged `smart_trader`, we would need a token-seeded crawl: tokens first, then the tagged holders of each, then each wallet's PnL. We chose not to do that for M0.5 (decision 2026-10-28). Birdeye feeds discovery through gainers plus identity, and the provider ranking does the filtering.

## Auth
- Base URL: `https://public-api.birdeye.so`.
- Headers: `X-API-KEY: <key>` and `x-chain: solana`.

## Endpoints used

### `GET /trader/gainers-losers`: candidate source (30 CU per call)
| Param | Values | Default | We send |
|---|---|---|---|
| `type` (required) | `yesterday`, `today`, `1W`, `30d`, `90d` | `1W` | `30d`, `90d` |
| `sort_by` (required) | `PnL`, `realized_pnl`, `unrealized_pnl`, `trader_score` | `PnL` | `realized_pnl` |
| `min_trade` / `max_trade` | uint | none | `min_trade=50` |
| `min_realized_pnl` | number | 1000 when `sort_by=realized_pnl` | not sent (so the default of 1000 applies) |
| `offset` / `limit` | 0–10000 / 1–100, with `offset+limit ≤ 10000` | 0 / 20 | `page*100` / 100 |

Other parameters: `min/max_volume_usd`, `min/max_pnl` and `min/max_unrealized_pnl`.

- Response: `data.items[]` with `address`, `pnl`, `realized_pnl`, `unrealized_pnl`, `volume`, `trade_count` and `network`.
- There is **no win rate, trading-days count, per-token share or identity**. That is why Birdeye-only candidates are always `verified=false` and sort after rows that have a win rate.
- We rank on `realized_pnl` only. The official example rows show unrealized PnL in the tens of millions, which isn't a useful signal.
- `sort_by=trader_score` returns a 0–100 `score`. That was added 2026-09-24 and we don't use it yet.

### `POST /identity/v1/multiple`: exchange/program filter (CU cost not documented)
- Body: `{ "addresses": [...] }`, with at most 100 addresses.
- Response: `data` is a map from address to `{ type, entity, label, category, tags[], domains[] }`.
  - `type` is one of `wallet`, `exchange`, `protocol`, `token`, `program`, `unknown`.
  - Unknown addresses are omitted.
- We drop a candidate whose `type` is in `discovery.drop_identity_labels`, i.e. exchange, protocol, token or program.

### Not used, but considered
`GET /wallet/v2/leaderboard` (25 CU):
- It has `interval` up to `90d`, `sort_by=realized_pnl` and `min_trade`.
- It requires `from_value ≥ 100000`, which means total wallet value of at least $100k.
- It has no tags either.

## Rate limits and pricing (as published)
| Plan | Price/mo | CU/mo | Account rate |
|---|---|---|---|
| Standard | $0 | 30,000 | 1 rps |
| Lite | $39 | 2.5M | 15 rps |
| Starter | $99 | 8M | 15 rps |
| Premium | $199 | 20M | 50 rps / 1000 rpm |
| Business | $499 | 60M | 100 rps / 1500 rpm |

- `/trader/gainers-losers` has a per-endpoint limit of 100 rps, with the account limit also applying.
- Gainers/Losers lists the Standard through Enterprise tiers as having access.
- Errors are `401` (bad key), `403` (blacklisted), `429` (rate limited) and `400`/`500`. No `Retry-After` header is documented.

**Cost per discovery run:** up to 2 windows × 2 pages × 30 CU = 120 CU, plus 1–4 identity calls. Our throttle is `min_interval_ms: 1100`, matching Standard's 1 rps.

## Unverified until a key exists
- The real response shapes. The fixtures are the official OpenAPI examples.
- Whether the Standard tier can call `/identity/v1/multiple`, and its CU cost.
- Whether `min_realized_pnl` defaults to 1000 when `sort_by=realized_pnl`. The docs contradict themselves here: the description says ≥1000, but the example shows -10000.

To refresh the fixtures with real data, run `pnpm wallets:discover --record`.

## Field notes from the first real run (2026-10-28)
- **Identity:** `POST /identity/v1/multiple` returned **401 on the free Standard tier**. Discovery treats it as unavailable:
  - It prints one `note:` line and stops calling identity for that run.
  - Birdeye-only rows get `identity_checked=false` and rank below checked rows.
  - `identity-multiple.json` is still the doc-derived fixture.
- **Rate limit:** `429`s appeared at a 1.1 s interval even though Standard is documented at 1 rps. Discovery now uses `min_interval_ms: 2000`, and retries never wait less than that interval.
- **Trade size:** discovery uses `volume / trade_count` as the average trade in USD. `volume` counts buys and sells.
