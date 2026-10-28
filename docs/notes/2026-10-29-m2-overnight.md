# M2 overnight: Enricher + 6 hard rules (branch `m2-rules`)

This was an unattended run. Every judgement call below was made on the conservative side, meaning it fails closed, and is listed so you can review it. Nothing was merged, and the engine was never started.

## What changed
- **Providers** in `packages/shared/src/providers/`. Each sits behind an interface with a zod schema and has a doc in `docs/providers/`.
  - `dexscreener.ts`: pools, liquidity, price, pair age.
  - `rugcheck.ts`: holders, creator, mint and freeze authority, LP lock, insider networks.
  - `geckoterminal.ts`: 1-minute candles for R5's 45-minute window.
  - `helius.ts`: adds `transactionsForAddress` (Helius `getTransactionsForAddress`) for R4's launch window.
- **Rules** in `apps/engine/src/rules/`:
  - `rules.ts`: the pure rules R1–R6, `evaluate`, and the pre-filters.
  - `enrich.ts`: the pure snapshot builder, the R4 heuristic, the fetch orchestration and the provider factory.
  - `stage.ts`: the pipeline stage. Each signal is written in one transaction (`token_snapshots`, `rule_results`, `decisions`, `events_log` with `stage='rules'`).
  - `record.ts`: the `pnpm rules:record <mint...>` CLI.
- **Engine wiring** (`main.ts`): `startRules` is created before the scout, and `submitPending()` queues every signal that has no decision. The scout got one hook, `onSignal(id)`, called after each new signal insert.
- **Config**: a new `enricher:` block at the end of `config/rules.yaml`, with its own `enricher` entry in `config.ts`. It is additive only; no existing key was changed.
- **No schema change.** Every M2 table already existed from M0, so there is no migration.
- **Fixtures**: four real mints recorded on 2026-10-29 (`dexscreener/`, `rugcheck/`, `geckoterminal/`, `helius/launch-*`). Each has a `_provenance` of `recorded …`.

## Decisions

### Data sources
| Need | Source | Why |
|---|---|---|
| R1 liquidity, price, FDV, pair, pair age | DexScreener `/token-pairs/v1/solana/{mint}` | Keyless, 300 req/min. We use the deepest pool. |
| R1 on a pump.fun **bonding curve** | RugCheck market `lp.baseUSD + lp.quoteUSD` | DexScreener has no `liquidity` for curve pairs. Without a fallback, every curve token would show as `data_unavailable` instead of an honest R1 fail. |
| R2 top 10, R3 dev, R6 authorities and LP | RugCheck `/v1/tokens/{mint}/report` | Keyless. One call covers all of them, so Helius DAS isn't needed. |
| R4 related-wallet holdings | RugCheck `insiderNetworks` | It already clusters wallets linked by transfers or funding, which is the "same funder" signal. |
| R4 launch window | Helius `getTransactionsForAddress` (asc, blockTime window) | It works on our free key. 10 credits per 100 txs. |
| R5 45-minute change | GeckoTerminal minute OHLCV | DexScreener has only `m5`, `h1`, `h6` and `h24`. `h1` isn't a conservative stand-in for 45 minutes (see `docs/providers/geckoterminal.md`). |

### R4 v1 heuristic (bundled launch)
`bundled_pct = max(insiderNetworkPct, slotClusterPct)`:
- **`insiderNetworkPct`** is the share of supply that RugCheck's transfer-linked insider networks still hold (`currentHolding`, or `tokenAmount` if missing). It covers "same funder" and part of "fresh wallets".
- **`slotClusterPct`** is computed from successful txs that reference the mint, in `[pairCreatedAt, pairCreatedAt + rules.R4_window_s]` (60 s):
  - Each tx's **fee payer** is the buyer. A buy is the scout's own `parseSwap`: token up, SOL down.
  - Bundled buys are those in the **first slot** of the window (the create or launch slot), plus buys in any slot where at least **`enricher.R4_slot_cluster_min_buyers` (5; raised from 3 on 2026-10-29)** distinct wallets bought. That is the "same slot cluster" signal.
- We take the max of the two, not the sum, so a wallet in both counts once.
- Every sub-score goes into `rule_results.value` as JSON, so replay (M5) can retune it: `insiderNetworkPct`, `launchSlotPct`, `slotClusterPct`, `windowBuyPct`, `buyers`, `clusterSlots`, `txs`, `truncated`.
- If the window holds more than `R4_max_pages × 100` txs, the result is **truncated**, so the percentages are lower bounds. A truncated result can **fail** R4 but never pass it; it gives `data_unavailable`.

**Limits (please review):**
- Organic snipers also land three or more to a slot in hyped launches, so this over-counts on busy launches. The migrated fixture scored 13.6% against the 15% threshold. Expect R4 to kill more than "true" bundles. Tune it in replay.
- There is no on-chain funder graph of our own and no fresh-wallet age check; we rely on RugCheck for those, and RugCheck may serve a cached report.
- A buy relayed with a third-party fee payer is missed. So is a tx that doesn't reference the mint account (not seen, but not proven).
- It measures what was **bought** in the window, not what is still held.
- Token age unknown (no `pairCreatedAt`) means no launch window, so the result is `data_unavailable`.

### Other rule decisions
- **killed_by:**
  - It is the first failing rule in `rules.order`.
  - If that rule failed for lack of data, it is `data_unavailable`.
  - A stale snapshot is always `data_unavailable`. It also adds a `rule_id='DATA'` row (`reason='stale'`, `value` = age in seconds), and all six rules are still stored.
  - `all_failed_json` lists the failing rule ids.
- **Staleness:** a signal is stale if `takenAt − trade time > data.max_snapshot_age_s` (60 s). Trade time is `min(block_time, detected_at)`.
  - The scout's backfill stamps `detected_at = now`. Without `block_time`, an hours-old backfilled buy would look fresh and could PASS.
  - A signal already older than the limit is decided **without any provider call** (boot backlog), so the backlog never eats the rate budget that live signals need.
- **Pre-filters** go to `SKIPPED`, and `killed_by` holds the reason: `sell`, `ignored_mint`, `below_min_buy`, `token_age`.
  - The demo seed writes `killed_by=NULL` for SKIPPED, but the dashboard kill chart only reads `verdict='KILLED'`, so nothing on screen changes.
  - `token_age` runs after DexScreener (it needs `pairCreatedAt`) and stores the partial snapshot.
  - A buy with `amount_sol = NULL` is treated as dust.
- **`prefilters.mint_cooldown_h` is not applied in M2.** It's a position-level rule (PLAN §3) that belongs to M3.
- **R2:** pool vaults (`knownAccounts` type `AMM`, plus market vaults) and burn owners are excluded. **Lockers and the creator still count.**
- **R3:** this is the creator wallet's balance only.
- **R5:** a pool younger than 45 minutes is measured from its first candle (the change since launch), with `priceChangePartial=true`. Young pumps fail R5, which is intended.
- **R6:** the LP leg applies only when the matched RugCheck market has a real LP mint. pump.fun curves and Meteora DAMM v2 have none (system program id). No matching market gives `data_unavailable`.
- **Errors:** a provider error leaves its fields empty, so the affected rules give `data_unavailable` and the signal is KILLED. When DexScreener fails, or has no pool for the mint, no other provider is called. A DB or code error leaves the signal **undecided**: it is never PASSED, it is logged with an `events_log` row (`rules_failed`), and the next boot retries it.
- **`raw_json`** holds `{derived: <snapshot incl. bundle sub-scores and provider errors>, providers: {dexscreener, rugcheck, geckoterminal}}`. That is about 25–30 KB per decided signal. Helius launch txs are not stored; they can be megabytes.

### Follow-up (2026-10-29, after review)
- **R4:** `R4_slot_cluster_min_buyers` changed from 3 to 5. At 3, organic snipers were counted as bundles.
- **R5 runs last.** GeckoTerminal is fetched only when R1–R4 and R6 all pass, and then R5 decides the verdict.
  - When another rule has already killed the signal, R5 is stored as `passed=0`, `value=NULL`, `reason='not_evaluated'`. It is **not** a kill: it isn't in `all_failed_json` and it can't be `killed_by`.
  - `pnpm rules:record` still fetches the candles every time, so the fixtures stay complete.
- **Rebased onto main `e6997e1`.** Main's discovery code wraps `HeliusRpc`, so `transactionsForAddress` moved to its own `HeliusHistoryRpc` interface. `createHeliusRpc` returns both, and the discovery code was not touched.

## Verified vs not
**Verified (2026-10-29):**
- **DexScreener:** the OpenAPI spec (paths, rate limits, Pair schema) and live responses.
- **RugCheck:** the Swagger spec (keyless report, `refresh` is paid only) and live reports. The `x-rate-limit-limit: 15` header was seen.
- **GeckoTerminal:** the keyless docs (~10/min) and live candles, including `include_empty_intervals` and pump.fun curve pools.
- **Helius `getTransactionsForAddress`:** the docs (params, filters, pagination, credit cost) and live calls with our key, asc order and pagination.
- **End to end against the live APIs** with `pnpm rules:record`, for four current mints:
  - `dyw5…` KILLED R5 (+94%)
  - `58gj…` KILLED R1 (also fails R4)
  - `Bo9f…` KILLED R1
  - `EqRZ…` KILLED R1 (R4 truncated)

**Not verified:**
- The **"live run shows KILLED/PASSED in DB"** acceptance item. That needs the engine, which I was told not to start. See the steps below.
- RugCheck's rate-limit **window** (we assume per minute), and how stale the cached reports are.
- Whether GeckoTerminal holds ~10/min under bursts.
- Whether `getTransactionsForAddress` stays available on the free plan.
- Whether every aggregator-routed buy references the mint account.

## API limits and cost per signal (for signals that reach the providers)
| Provider | Calls | Throttle in config | Published limit | Cost |
|---|---|---|---|---|
| DexScreener | 1 | 250 ms | 300/min | free |
| RugCheck | 1 | 4.5 s | header says 15 (assumed /min) | free, keyless |
| GeckoTerminal | 1 | 6.5 s | ~10/min | free, keyless |
| Helius | 1–5 pages | 500 ms | 10 rps shared with the scout | 10 credits/page, so ≤50 |

- RugCheck limits the enricher to **about 13 signals a minute**. GeckoTerminal (~9/min) is now spent only on signals that pass R1–R4 and R6.
- A burst bigger than that makes the tail exceed 60 s, and those signals get KILLED `data_unavailable` (stale). That's visible on the dashboard as `data_unavailable`. If it happens often, the levers are:
  - raise `prefilters.min_buy_sol`,
  - get a CoinGecko key (a new provider config),
  - or accept a larger `data.max_snapshot_age_s`.
- Helius at 300 rule-checked signals a day is ≤15k credits a day. Compare the dashboard after 24 h.

## Review before merging
1. **R4 aggressiveness**: `R4_slot_cluster_min_buyers: 3`, and the decision to use max rather than sum (above).
2. **SKIPPED `killed_by` holds the skip reason.** Change it to NULL if you prefer the demo-seed convention.
3. **Boot backlog:** the first boot after merging will decide every existing signal in `paper.db`.
   - Old buys come out KILLED `data_unavailable` (stale) with no provider calls; sells and dust come out SKIPPED.
   - If you'd rather leave history undecided, say so before restarting. One option is to insert `SKIPPED`/`pre_m2` decisions first, but I didn't, to keep `paper.db` untouched.
4. The `enricher:` placeholders (marked "placeholder, tune" in YAML) and the RugCheck/GeckoTerminal throttles.
5. `mint_cooldown_h` is deferred to M3.
6. **Merge conflicts:** `m05-activity` may also edit `config/rules.yaml`, `config.ts`, `main.ts` or `scout.ts`. My edits are an EOF block in the YAML, an EOF key in the zod schema, a few lines in `main.ts`, and two lines in `scout.ts`.

## Merge into main and restart the engine
Run these in the **main repo folder**, after the `m05-activity` session is done with it.

```sh
# 1. stop the running engine (Ctrl-C in its terminal, or):
pkill -INT -f 'apps/engine/dist/main.js'

# 2. merge (no fast-forward, so M2 stays one visible merge)
git checkout main
git pull --ff-only            # if main has a remote
git merge --no-ff m2-rules    # resolve rules.yaml/config.ts/main.ts conflicts if m05 touched them
#   or: git push -u origin m2-rules && gh pr create --base main --head m2-rules

# 3. install, verify
pnpm i
pnpm build && pnpm test -- --reporter=dot 2>&1 | tail -20 && pnpm lint

# 4. no schema change in M2, so db:migrate is a no-op, but it is safe to run
pnpm db:migrate

# 5. optional live smoke test without the engine (prints verdicts, rewrites fixtures; discard them with
#    `git checkout packages/shared/test/fixtures` if you don't want to commit the refresh)
pnpm rules:record <some-current-mint>

# 6. restart from the repo root (DATA_DIR/RULES_PATH are relative)
pnpm start
```

## After the restart, check
- The log has `rules: pending signals queued` with N. Then there is one `decision` line per signal, and each line has `signal_id`.
- In SQLite (`data/paper.db`):
  - `SELECT verdict, killed_by, count(*) FROM decisions GROUP BY 1,2;`
  - `SELECT * FROM rule_results WHERE signal_id = (SELECT max(signal_id) FROM decisions);`
  - `SELECT * FROM events_log WHERE stage='rules' ORDER BY id DESC LIMIT 20;`
- On the dashboard, the kill-reason chart and the funnel now show real counts.
- No `provider 429` warnings in steady state. A few during bursts are fine.
- After 24 h, check the Helius credits dashboard against the estimate above.
