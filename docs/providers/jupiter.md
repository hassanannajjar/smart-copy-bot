# Jupiter

Verified on **2026-10-29** against the official docs, and against real responses recorded the same day (keyless, plus one keyed call to confirm the key).

Sources:
- Swap V2 overview: https://developers.jup.ag/docs/swap
- `/swap/v2/order` reference: https://developers.jup.ag/docs/api-reference/swap/v2/order
- V1 quote (deprecated): https://developers.jup.ag/docs/swap/get-quote
- Price V3: https://developers.jup.ag/docs/price
- Rate limits: https://developers.jup.ag/docs/api-rate-limit

Code: `packages/shared/src/providers/jupiter.ts`. Fixtures: `packages/shared/test/fixtures/jupiter/`. Used by `apps/engine/src/paper/executor.ts` (M3 paper executor + PositionManager).

## Which API
- **Swap V1 `GET /swap/v1/quote` (Metis) is "no longer actively maintained"**, and Swap V2 replaces it. `quote-api.jup.ag/v6` and `lite-api.jup.ag` aren't mentioned in the current docs, so we don't use them.
- We call **`GET https://api.jup.ag/swap/v2/order` without `taker`**. The docs say: "Without `taker`, `/order` returns the quote only", and `transaction` comes back `null`. The client has no `taker` parameter at all, so it **can't** produce a signable swap. We never call `/execute`, and a test bans both from the source tree.
- Price polling uses **`GET https://api.jup.ag/price/v3?ids=`**, which takes up to 50 mints per call.

## Auth, limits, cost
- The key is optional and sent in the **`x-api-key` header** (`JUPITER_API_KEY` in `.env`). It never goes in the URL, logs or fixtures. `fixtures.test.ts` fails if any fixture contains a key value from `.env`, `x-api-key` or `api-key=`.
- Limits are per organisation over a 60 s sliding window. One bucket covers every Jupiter API (`/execute` has its own):

| Tier | rps | rpm |
|---|---|---|
| Keyless | 0.5 | 30 |
| Free (key) | 1 | 60 |
| Developer | 10 | 600 |

- A rate-limited call gets a 429 with `x-ratelimit-remaining`, `x-ratelimit-current` and `x-ratelimit-reset` (unix seconds). We retry with backoff and log `provider 429, backing off`.
- Config is `executor.jupiter`: `min_interval_ms: 2100` keyless and `keyed_min_interval_ms: 1100` when `JUPITER_API_KEY` is set. `main.ts` picks one. **One client serves both quotes and prices**, so they share one throttle, and the executor runs entries and polls on a single serial chain.
- Cost: free tiers.

## `/swap/v2/order` (quote only)
Query: `inputMint`, `outputMint`, `amount` (raw base units; lamports for SOL). `swapMode` is ExactIn only. `slippageBps` affects `otherAmountThreshold` only, so we don't send it.

Fields we read (seen in the recordings):

| Field | Notes |
|---|---|
| `inAmount`, `outAmount` | Raw amounts as **strings**. We treat `outAmount` as what we would receive, net of the platform fee: in the recording, `outUsdValue < inUsdValue` by about `priceImpact`. |
| `feeBps`, `platformFee{feeBps,feeMint}` | Seen 10 bps on `metis` routes and 2 bps on `jupiterz` RFQ. We record the fee in `fees_usd` and add it back for gross PnL. |
| `priceImpact` | A **number in percentage points**. `priceImpactPct` (a string fraction) is deprecated. A $50 buy of a $6.5k-liquidity pump.fun token showed −1.9%. |
| `routePlan[].swapInfo.ammKey` | The pools. They are the writable accounts we pass to Helius `getPriorityFeeEstimate`. |
| `router` | `metis`, `jupiterz`, `dflow` or `okx`. |
| `signatureFeeLamports`, `prioritizationFeeLamports`, `rentFeeLamports` | All **0 without a taker**, so they're useless for paper. We price fees ourselves (see `helius.md`). |
| `errorCode`, `errorMessage`, `error` | Set when no order could be built. A 400 `{error}` comes back for an invalid mint (seen live). |

**No route:** the shape for a *valid* mint with no route isn't documented. `quote()` returns `null` on a 400, on `error`/`errorCode`, or on a missing or `"0"` `outAmount`. The `order-noroute.json` fixture is doc-derived. Network errors, 5xx and 429 throw instead, so the executor retries them and they never count as no route.

## Price V3
Response is `{ [mint]: { usdPrice, liquidity, decimals, blockId, createdAt, priceChange24h } }`. `liquidity` is USD across all pools. **Mints that fail Jupiter's reliability heuristics, or have no trade in 7 days, are simply absent.** There is no error, so we compare the keys we asked for with the keys returned. The executor then marks the position from a sell quote for our size. A fresh pump.fun mint *was* present in our recording.

## Recordings
- `order-buy-58gj8ENd.json`: 0.5 SOL → RL (pump.fun curve), `metis`, impact −1.88%.
- `order-sell-58gj8ENd.json`: 3.6M RL → SOL, impact −2.26%.
- `price-58gj8ENd.json`: RL + wSOL.
- `order-noroute.json`: doc-derived.

Re-record by calling the same URLs (with the `x-api-key` header) and saving `{_provenance, request:{method,path,query}, response}`. Never save headers.
