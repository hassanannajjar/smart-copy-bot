# GeckoTerminal (CoinGecko on-chain, keyless)

Verified on **2026-10-29** against CoinGecko's docs, and against real responses recorded the same day with `pnpm rules:record`.

Sources:
- Keyless public API: https://docs.coingecko.com/docs/keyless-public-api
- Pool OHLCV (Pro twin of the same endpoint, same params): https://docs.coingecko.com/reference/pool-ohlcv-contract-address
- `apiguide.geckoterminal.com` now redirects to `docs.coingecko.com`.

Code: `packages/shared/src/providers/geckoterminal.ts`. Fixtures: `packages/shared/test/fixtures/geckoterminal/ohlcv-<pool8>.json`.

## Why it's here
R5 needs the price change over the **last 45 minutes**. DexScreener only gives `m5`, `h1`, `h6` and `h24`. We considered three alternatives:
- Using `h1` as a proxy: rejected, because it isn't conservative. A token can dump and then pump 100% inside 45 minutes while showing less over the hour.
- Birdeye OHLCV: rejected for M2. It costs CU on our small plan, and `birdeye.ts` belongs to the discovery session.
- Rebuilding prices from Helius swaps: rejected as too much code.

## Auth, limits, cost
- **No key.** Base URL: `https://api.geckoterminal.com/api/v2`.
- **Rate limit:** CoinGecko's keyless page says GeckoTerminal endpoints allow about **10 calls/min**, shared per IP. Older docs said 30/min. We throttle to 1 call per 6.5 s (`enricher.geckoterminal.min_interval_ms: 6500`).
- CoinGecko says the keyless API "is not suitable for production workloads". This is the slowest provider and the main throughput limit of the rules stage. Paid on-chain access is quoted at 250 calls/min.
- Cost: free.
- Responses carry `cache-control: max-age=30`.

## Endpoint used
`GET /api/v2/networks/solana/pools/{pool}/ohlcv/minute?aggregate=1&limit=47&currency=usd&include_empty_intervals=true`
- `limit` is `enricher.R5_window_min + 2`.
- Response: `{data: {attributes: {ohlcv_list: [[ts_s, open, high, low, close, volume], …]}}, meta: {base, quote}}`, **newest first**.
- With `include_empty_intervals=true`, minutes with no trade are included, so `limit` maps directly to minutes. We recorded 50 candles for `limit=50` on a pump.fun curve pool.
- It works for pump.fun bonding-curve pools, PumpSwap and Raydium CPMM.

## R5 computation (`priceChange` in `apps/engine/src/rules/enrich.ts`)
- `t0 = takenAt − R5_window_min`.
- The reference price is the **open** of the last candle starting at or before `t0`. The current price is the newest candle's **close**.
- A pool younger than the window has no candle at or before `t0`. Then we use the first candle's open (the change since launch) and set `priceChangePartial` in `raw_json`. That is conservative: young pumps fail R5.
- No candles, or a reference price of 0 or less, gives `data_unavailable`.
