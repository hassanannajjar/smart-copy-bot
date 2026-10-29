# Helius

Verified on **2026-10-28** against the official docs, and against a real recording made with our key on the same day.

Sources:
- Credits: https://www.helius.dev/docs/billing/credits
- Plans: https://www.helius.dev/docs/billing/plans
- Rate limits: https://www.helius.dev/docs/billing/rate-limits
- WebSockets (keepalive, reconnect): https://www.helius.dev/docs/rpc/websocket
- `logsSubscribe`: https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe
- `getTransaction`: https://www.helius.dev/docs/api-reference/rpc/http/gettransaction
- `getSignaturesForAddress`: https://www.helius.dev/docs/api-reference/rpc/http/getsignaturesforaddress
- Parsed Events and Streams (beta): https://www.helius.dev/blog/parsed-events-and-streams

Code: `packages/shared/src/providers/helius.ts`. Fixtures: `packages/shared/test/fixtures/helius/`. Scout: `apps/engine/src/scout/`.

## Choice: standard WS `logsSubscribe` + `getTransaction` + our own parser

| Option | Credits | Free plan? | Verdict |
|---|---|---|---|
| Enhanced WS `transactionSubscribe` | 2 per 0.1 MB | **No** (Developer and up) | Out |
| Parsed Streams `parsedTransactionSubscribe` (decoded, `summary.type: "swap"`) | 1 per delivered event | Conflicting: the credits and rate-limit pages say all plans (free: 5 connections, 25 subscriptions each); the product page says paid only | Not yet. It's an **open beta** on `fs-beta`/`beta` hosts, and the `accounts` filter semantics and the notification shape are undocumented. Revisit when it's GA |
| Enhanced webhooks (type `SWAP`) | 1 per event, plus 100 per create/edit | Yes (5 webhooks, 100k addresses each) | Out. It needs a public HTTPS endpoint (a tunnel from home), and Enhanced Transactions parsing is in "maintenance mode" |
| Polling Enhanced Transactions (100 per call) or Parsed Events REST (10 per call) | 8 wallets every 10 s is about 69k calls a day | — | Out: far over budget |
| **Standard WS `logsSubscribe({mentions:[wallet]})` + `getTransaction`** | WS: 2 per 0.1 MB, plus 1 per connection open. `getTransaction`: 1 | **Yes**, and not beta | **Chosen** |

Parsing is venue-agnostic. We diff the wallet's own SOL and token balances, so Jupiter routes, pump.fun curves, pump AMM and Raydium all look the same. We don't need per-DEX decoders, and we don't depend on Helius' parser.

## Auth
- The API key goes in the **`api-key` query parameter**. That's the only auth Helius documents for RPC and WS.
- That means the URL is secret:
  - We never log or record URLs.
  - `createHttp`'s `authQuery` adds the key to the URL only. Errors carry `helius <code> POST <rpc method>`.
  - WebSocket error text has the key replaced with `***`.
  - pino redacts `url` and `apiKey`.

## Endpoints used
- **WS**: `wss://mainnet.helius-rpc.com/?api-key=KEY`
  - Subscribe with `{"jsonrpc":"2.0","id":N,"method":"logsSubscribe","params":[{"mentions":["<wallet>"]},{"commitment":"confirmed"}]}`.
  - `mentions` takes **exactly one** pubkey, so we open one subscription per wallet. The free plan allows up to 1,000 per connection.
  - The ack is `{"jsonrpc":"2.0","id":N,"result":<subscription id>}`. A bad pubkey returns `{"id":N,"error":{"code":-32602,"message":"Invalid Request: Invalid mentions provided"}}` (recorded).
  - A notification is `{"method":"logsNotification","params":{"subscription":id,"result":{"context":{"slot"},"value":{"signature","err","logs":[]}}}}`. Recorded sizes: median about 0.9 KB, max about 9.4 KB.
- **RPC**: `POST https://mainnet.helius-rpc.com/?api-key=KEY` (JSON-RPC 2.0).
  - `getTransaction`:
    - Params: `[sig, {encoding:"jsonParsed", maxSupportedTransactionVersion:1, commitment:"confirmed"}]`.
    - Helius documents `1` as covering legacy, v0 and v1 transactions; our key accepted it.
    - `processed` isn't allowed.
    - `result: null` means the node doesn't have the transaction yet, so we retry `tx_fetch_retries` times, `tx_fetch_delay_ms` apart.
    - Recorded size: median about 16 KB, max about 38 KB.
  - `getSignaturesForAddress`:
    - Params: `[wallet, {until, limit, commitment}]`, with `limit` from 1 to 1000.
    - Results come newest first: `[{signature, slot, err, memo, blockTime, confirmationStatus}]`.
  - `getAccountInfo` (discovery on-chain identity, https://www.helius.dev/docs/api-reference/rpc/http/getaccountinfo, checked 2026-10-29):
    - Params: `[address, {encoding:"base64", dataSlice:{offset:0,length:0}, commitment}]`. The zero-length slice skips the account data; we only need the owner.
    - Result: `{context:{slot}, value:{lamports, owner, executable, data, rentEpoch, space}}`. Per the Solana JSON-RPC spec, `value` is `null` when the account doesn't exist; the Helius page doesn't say.
    - A plain wallet is owned by the System Program, `11111111111111111111111111111111`.
    - Cost: the method page states none. The credits page bills standard RPC calls at 1 credit.
    - Fixtures `account-wallet.json`, `account-token.json` and `account-missing.json` are doc-derived.

### `getTransaction` (jsonParsed) fields we read
- `blockTime`: Unix **seconds**, and possibly null. That gives `detect_latency_ms` about ±1 s resolution.
- `meta`:
  - `err`: null on success.
  - `fee`: lamports, including priority fees.
  - `preBalances[]` and `postBalances[]`: lamports, aligned with `accountKeys`.
  - `preTokenBalances[]` and `postTokenBalances[]`: each `{accountIndex, mint, owner, programId, uiTokenAmount:{amount, decimals, uiAmount, uiAmountString}}`.
- `transaction.message.accountKeys[]`: `{pubkey, signer, writable, source: "transaction"|"lookupTable"}`. Lookup-table keys are included, and `[0]` is the fee payer.
- `transaction.signatures[0]`: the tx signature.

The raw `result` is kept untouched in `data/raw/scout-YYYY-MM-DD.jsonl`, so replay can use fields we don't parse yet.

## Parse rules (`apps/engine/src/scout/parse.ts`)
- **SOL leg** = the wallet's lamport delta, plus `meta.fee` if the wallet is the fee payer, plus its wSOL token delta.
- **Token deltas** are per mint, over the token balances whose `owner` is the wallet, excluding wSOL.
- **Buy**: exactly one mint went up and the SOL leg is negative. **Sell**: exactly one mint went down and the SOL leg is positive.
- Skip reasons are logged, and the raw line is still written:
  - `failed_tx`
  - `no_token_change` (a SOL transfer or a stake)
  - `non_sol_quote`: several mints moved and one is a stable from `prefilters.ignored_mints`, as in a USDC → xStock swap. This was seen live on 2026-10-29.
  - `multi_token`: several non-stable mints moved.
  - `no_sol_leg` (an airdrop, dust, a send, or a single-token change with no SOL leg)
- **v1 is SOL-quoted only.** A swap paid from wSOL into USDC is recorded as a "buy" of USDC; the M2 prefilters drop it through `ignored_mints`.
- `amount_sol` includes ATA rent (~0.002 SOL) when a buy creates the token account. That's noise against `min_buy_sol`.
- Recorded examples in the fixtures: `tx-jupiter-buy`, `tx-pumpfun-buy` (Jupiter → pump.fun curve), `tx-pumpamm-sell`, `tx-wsol-quoted`, `tx-sol-transfer`, `tx-dust-airdrop`, `tx-usdc-xstock`, `tx-failed`.
- One known limit: `signals.tx_sig` is UNIQUE (PLAN §3), so a tx that mentions two tracked wallets keeps the first. It is logged as `duplicate_tx_other_wallet`.

## Keepalive, reconnect, backfill
- Helius drops a WebSocket after **10 minutes idle** and asks for a ping at least once a minute.
  - We send a protocol `ws.ping()` every `ping_interval_ms` (30 s). If there's no pong by the next tick, we terminate the socket and reconnect. That's Helius' Node pattern, and the reason for the `ws` dependency: Node's global WebSocket can't send protocol pings.
  - We verified that the server answers protocol pings with pong frames.
- Reconnect uses exponential backoff with jitter: `reconnect_base_ms` (1 s) doubling up to `reconnect_max_ms` (30 s), times 0.5–1.5. The attempt counter resets once every subscription is acked again, and all subscriptions are re-sent on each new connection.
- Backfill always runs through the same handler, with `limit: backfill_limit` per wallet:
  - **On boot**: `until` is each wallet's latest stored `signals.tx_sig`. A wallet with no stored signal gets no boot backfill.
  - **On reconnect**: `until` is the last signature seen on the stream, falling back to the latest stored one.
  - Detect latency stays honest, so backfilled rows show the gap.
- **Rate limiting**:
  - HTTP 429 is retried by `createHttp`, with backoff and `Retry-After`.
  - A JSON-RPC error `-32005` ("Too many requests") is retried by the Helius client with a backoff of 1 s doubling up to 30 s.
  - Both are logged as `provider 429`.
  - Every 10th reconnect logs a warning to check credits.

## Plans and limits (as published)
| Plan | Price/mo | Credits/mo | RPC | DAS/Enhanced |
|---|---|---|---|---|
| Free | $0 | 1M | 10 req/s | 2 req/s |
| Developer | $49 | 10M | 50 req/s | 10 req/s |
| Business | $499 | 100M | 200 req/s | 50 req/s |
| Professional | $999 | 200M | 500 req/s | 100 req/s |

Free plan WebSockets (standard methods only): 5 concurrent connections, 1,000 subscriptions per connection. We throttle RPC at `min_interval_ms: 150` (about 6.7 req/s).

## Daily credit estimate (8 wallets, ~190 swaps/day)
- Wallets also receive non-swap transactions (transfers, spam), so assume about **400 notifications a day**.
- WS data: 400 × ≤20 KB (recorded max is 9.4 KB) = 8 MB, which is **≤160 credits**. If every message were billed at a 0.1 MB minimum, it would be 320.
- `getTransaction` for non-failed notifications: about 400 a day, **400 credits**.
- Reconnects: 1 credit per connection open plus up to 8 `getSignaturesForAddress` calls each. About 10 a day is **~90 credits**.
- **Total: about 650–810 credits a day, or ~20–25k a month, which is about 2.5% of the 1M free quota.** 80 wallets would still be under 25%.
- Worst case, a reconnect storm at the 30 s cap all day: 2,880 × 9 ≈ 26k credits a day. That's why reconnects get a warning every 10.

## Discovery activity check (`pnpm wallets:discover`)
- An unidentified (Birdeye-only) candidate costs 1 `getAccountInfo` before enrichment.
- Per enriched candidate: 1 `getSignaturesForAddress` (limit 20), then `getTransaction` on up to 10 of the newest non-failed signatures. That is at most 11 credits. A wallet whose newest signature is older than 48 h costs 1.
- It uses its own throttle (`discovery.helius`, 250 ms) because it shares the free plan's 10 rps with a running engine.
- The three runs on 2026-10-29 cost 112, 211 and 257 credits (580 in total). The two later runs with on-chain identity cost 277 and 555.

## Unverified / revisit
- Whether Helius bills each WebSocket message at a 0.1 MB minimum. Compare the credits dashboard after 24 h with the estimate above.
- Parsed Streams on the free plan, and its GA date. It would remove the `getTransaction` call (1 credit per event, decoded swaps).
- A gap while the process is down is covered by the boot backfill only for wallets that already have a stored signal.

Refresh the fixtures with `pnpm start --record`. It saves the first notification and the first tx per parse outcome (`tx-buy`, `tx-sell`, `tx-skip-<reason>`).

## M2: `getTransactionsForAddress` (R4 launch window)
Verified on **2026-10-29** against the docs, and with our free-plan key the same day: a request with `sortOrder: "asc"` on a mint returned 200.

Sources:
- https://www.helius.dev/docs/rpc/gettransactionsforaddress
- https://www.helius.dev/docs/api-reference/rpc/http/gettransactionsforaddress

**What it is.** A Helius-only JSON-RPC method, sent to the same `POST https://mainnet.helius-rpc.com/?api-key=KEY` endpoint. The docs don't state a plan requirement, and it works on our free key.

**Params we send** (`createHeliusRpc().transactionsForAddress`):

```json
[mint, {"transactionDetails":"full","encoding":"jsonParsed","maxSupportedTransactionVersion":1,
        "sortOrder":"asc","limit":100,"commitment":"confirmed",
        "filters":{"blockTime":{"gte":created_s,"lte":created_s+R4_window_s},"status":"succeeded"},
        "paginationToken":"<from previous page>"}]
```

**Response.** `result: {data: [ {slot, transactionIndex, blockTime, transaction, meta} ], paginationToken: "slot:pos" | null}`. Each entry parses with the same `heliusTxSchema` as `getTransaction`.

**Pagination.** We follow `paginationToken` for up to `enricher.R4_max_pages` pages. If there are still more pages after that, the result is `truncated: true`, and R4 can then fail but never pass.

**Cost.** Full transactions cost **10 credits per 100 returned txs** (rounded up, 10 minimum); failed calls are free. With `R4_max_pages: 5`, a signal costs **≤ 50 credits**.
- 300 signals a day that pass the pre-filters cost ≤ 15k credits a day, or ≤ 450k a month. On top of the scout's ~25k a month, that is under the 1M free quota, but **not by a wide margin**.
- Watch the Helius credits dashboard. Lower `R4_max_pages` or raise `prefilters.min_buy_sol` if needed.

**Throttle.** The enricher has its own client at `enricher.helius.min_interval_ms: 500` (2 req/s). Together with the scout's 6.7 req/s, that stays under the free plan's 10 req/s.

**Gotchas seen while recording:**
- Querying the **mint** address returns the create tx and the buys and sells that reference the mint account.
- A busy launch had more than 500 successful txs in its first 60 s, so it came back truncated (fixture `launch-EqRZn9nH`).
- A full page is about 1.6 MB of JSON. The recorded fixtures keep only the fee payer's account key, lamport balances and token balances, which is everything the heuristic reads.

**Unverified:**
- Whether a swap routed through an aggregator **always** lists the mint account. Pool swaps normally do, through the vaults' mint and `transferChecked`.
- Whether the free plan keeps this method long term. The docs only say it is "Helius-exclusive".

Refresh with `pnpm rules:record <mint...>`, which writes `fixtures/helius/launch-<mint8>.json`.

## M3: `getPriorityFeeEstimate` (paper fees)
Verified on 2026-10-29 at https://www.helius.dev/docs/priority-fee-api and https://www.helius.dev/docs/api-reference/priority-fee/getpriorityfeeestimate.

- It is a JSON-RPC call on the same URL and key: `params: [{ accountKeys, options: { priorityLevel } }]`. The alternative is passing a serialized `transaction` instead of `accountKeys`. Other options: `includeAllPriorityFeeLevels`, `lookbackSlots` (1–150), `recommended`, `includeVote`, `evaluateEmptySlotAsZero`.
- `priorityLevel` is one of `Min`, `Low`, `Medium`, `High`, `VeryHigh` or `UnsafeMax`. `VeryHigh` and `UnsafeMax` are not outlier-trimmed, and `UnsafeMax` can reach billions.
- `result.priorityFeeEstimate` is in **micro-lamports per compute unit**. The docs say total priority fee = price × compute units consumed.
- With no `accountKeys` you get a global estimate, which the docs say is "not a fee to pay". We pass the quote route's pool `ammKey`s, which are the writable accounts the swap would lock.
- The credit cost isn't stated on either page. We make one call per paper fill, so it's negligible next to the scout.

How the executor uses it: network fee in SOL = `paper.base_fee_sol` + estimate × `executor.compute_units` / 1e15, at `executor.priority_fee_level` (High). **On any error it falls back to the static `paper.priority_fee_sol`** (0.001 SOL, conservative). The fill's `events_log` row records `priority_fee_source: helius|static`. Limits: `executor.helius` (500 ms, shared 10 rps plan).

Fixture: `fixtures/helius/priority-fee.json`, recorded 2026-10-29: High = 116,765 µL/CU, so about 0.000035 SOL at 300k CU. The static fallback, 0.001 SOL, is about 28x more conservative.
