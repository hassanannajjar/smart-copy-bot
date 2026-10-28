# DexScreener

Verified on **2026-10-29** against the official OpenAPI spec, and against real responses recorded the same day with `pnpm rules:record`.

Sources:
- API reference: https://docs.dexscreener.com/api/reference
- OpenAPI spec: https://openapi.gitbook.com/o/F3EJQhITOlKtqJoq3nND/spec/dex-screener-api.yaml

Code: `packages/shared/src/providers/dexscreener.ts`. Fixtures: `packages/shared/test/fixtures/dexscreener/token-pairs-<mint8>.json`. Used by `apps/engine/src/rules/enrich.ts`.

## Auth, limits, cost
- **No key.** The spec defines no auth for any endpoint.
- **Rate limit (spec):** 300 req/min on `/latest/dex/pairs`, `/latest/dex/search`, `/tokens/v1` and `/token-pairs/v1`. 60 req/min on profiles, boosts, orders, ads and metas.
- No rate-limit headers were returned when we checked. Responses send `cache-control: public, max-age=60`, so data can be up to about 60 s old.
- Config: `enricher.dexscreener.min_interval_ms: 250` (240/min, under the 300 limit). 429s are retried with backoff and logged (`provider 429, backing off`).
- Cost: free.

## Endpoint used
`GET https://api.dexscreener.com/token-pairs/v1/solana/{mint}`: every pool of the token, as a bare JSON array of Pair objects.

Pair fields we read:

| Field | Notes |
|---|---|
| `chainId`, `dexId`, `pairAddress`, `labels` | Seen `dexId` values: `pumpfun` (bonding curve), `pumpswap`, `raydium` (`labels: ["CPMM"]`), `meteora`. |
| `baseToken.address` | We keep only pools whose base token is the mint. |
| `priceUsd` | A string. |
| `priceChange` | An object of numbers keyed **`m5`, `h1`, `h6`, `h24`**. A key is missing when there was no trade in that window, e.g. no `m5`. **There is no 45-minute window**, so R5 uses GeckoTerminal (`geckoterminal.md`). |
| `liquidity.usd` | **Missing on pump.fun bonding-curve pairs** (`dexId: "pumpfun"`). R1 then falls back to RugCheck's valuation of the curve reserves. |
| `fdv`, `marketCap` | Numbers. |
| `pairCreatedAt` | **ms**. For a migrated pump.fun token, the PumpSwap pair has the same `pairCreatedAt` as the curve, which is the token's launch. |

## How the enricher uses it
- **Pair choice:** the pool with the highest `liquidity.usd` (`pickPairs`). That pair's address drives the GeckoTerminal candles and the RugCheck market match used by R6.
- **Token age** and the **R4 launch-window anchor** come from the earliest `pairCreatedAt` across the mint's pools.
- If there's no Solana pool for the mint, or the call fails, no other provider is called. R1, R4 and R5 come out `data_unavailable` and the signal is KILLED.

## Not used / not verified
- `/tokens/v1/solana/{a,b,…}` takes up to 30 addresses per call. It could batch the M3 price polls, but it isn't used yet.
