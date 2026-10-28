# Overnight run, 2026-10-29: discovery activity check (branch `m05-activity`)

## Outcome
- Only **8 wallets** met the starter criteria, short of the 12 needed. **`data/wallets.csv` was NOT written.** It still holds the 6 wallets from 2026-10-28.
- Because the list did not change, **the engine was not restarted.** The engine you started (`caffeinate -i pnpm start`, node PID 68938) is still running on the old 6-wallet list.
  - Health check: at 2026-10-28 22:19:55 UTC, `events_log` shows `connected` and then `subscriptions_acked {"count":6}`.
  - A `scout` heartbeat row is written every minute (the last one checked was 22:22:37 UTC).
  - Only one engine process exists.
- The code is committed on `m05-activity` and `main` was fast-forwarded to it. Build, tests (20 files, 145 tests) and lint all pass.

## Plan followed
1. Add the 7d window to the leaderboard pulls (Solana Tracker `days=7`, Birdeye `type=1W`).
2. Add a Helius activity check for enriched candidates. It calls `getSignaturesForAddress` with limit 20, then `getTransaction` on up to 10 of the newest non-failed signatures, and runs each through the M1 `parseSwap`. From that it computes `sol_quoted_swaps`, `non_sol_quote_swaps`, `last_swap_at` and `sol_quote_pct`.
3. Add two new drop reasons: `inactive` (no swap within 48 h) and `not_memecoin_trader` (SOL-quoted share below 50%).
4. Add the CSV and report columns `last_swap_at`, `sol_quote_pct` and `starter`.
5. Add the starter criteria as `discovery.starter` in `rules.yaml`, shown in the `starter` column.
6. Run discovery live, then write `data/wallets.csv` only if 12 or more wallets pass. They didn't, so it was not written.
7. Build, test, lint, commit, fast-forward `main`.
8. Restart the engine. Skipped, because there was no new list.

## Decisions
1. **Discovery code still never writes `data/wallets.csv`.**
   - Your one-time permission was going to be used by hand: copying the `starter=true` rows out of the candidates CSV. It was not used.
   - The `writeCandidates` guard and the CLAUDE.md rule are unchanged.
2. **Every new threshold lives in `rules.yaml`:**
   - `discovery.activity`: `signatures_limit: 20`, `tx_sample: 10`, `max_inactive_h: 48`, `min_sol_quote_pct: 50`
   - `discovery.starter`: `min_sol_quote_pct: 50`, `max_trades_per_day: 40`, `max_avg_trade_usd: 3000`, win rate 25–85, `max_top_token_pct: 30`, `max_wallets: 30`
   - `discovery.helius`: a 250 ms throttle, so discovery leaves room within the free plan's 10 rps for the running engine.
3. **`min_days` is now per window: `{ '7': 3, '30': 10, '90': 10 }`.** The old single value of 10 active days can never be met in a 7-day window, so it would have returned nobody.
4. **`max_pages` is now per provider: Solana Tracker 20, Birdeye 5.**
   - The ST leaderboard is sorted by realized PnL, and its top pages are mostly HF bots. Going from 5 to 20 pages raised ST rows from 1,500 to 2,324; the pagination ran out before 20 pages.
   - Birdeye stays at 5. Its rows can't be identity-checked on our plan (401), so they can never become starters, and more pages would only spend CU.
5. **Enrichment now covers identity-checked candidates, not only ST-sourced ones.**
   - 13 Birdeye-sourced candidates were identity-checked, because ST had returned them even though their ST rows were filtered, but they were never enriched or activity-checked.
   - Every ST-sourced candidate is identity-checked, so the new set includes the old one.
6. **How swaps are classified (using the existing `parseSwap`):**
   - SOL-quoted swap: a `buy` or `sell`.
   - Non-SOL swap: `non_sol_quote` (stable-quoted) or `multi_token` (token-to-token).
   - Not a swap, and ignored: `no_sol_leg` (transfers and airdrops), `no_token_change` and failed transactions.
   - `last_swap_at` is the newest swap of either kind.
7. **No swap seen in the sample counts as `inactive`** (fail closed).
   - If the newest signature is already older than 48 h, the check skips `getTransaction`, so the wallet costs 1 credit instead of 11.
8. **A failed activity check never drops a wallet,** but it can't make it a starter either: the row stays with blank activity columns and `starter=false`. If `HELIUS_API_KEY` is missing, the CLI prints a note.
9. **Starter rules:**
   - Identity checked, activity checked (active within 48 h), `trades_per_day` known and ≤ 40, and `avg_trade_usd` known and ≤ 3,000 are all required.
   - Win rate must be 25–85 and `top_token_pct` ≤ 30, but only when known.
   - At most 30 rows get `starter=true`, in rank order.
10. **The ranking tier "profitable in every window" now means all three windows** (7d, 30d, 90d). This favours wallets that are still winning recently.
11. **The filters you set earlier were not loosened to reach 12:**
    - `top_token_pct` ≤ 30 (`one_token_profit`, 32 dropped)
    - `min_median_hold_s` of 120 (`short_hold`, 10 dropped)
    - required identity check

    Loosening them would trade quality for count, and that's your call. See "What to decide" below.

## Helius credits
| Run | Change | Helius calls (= credits) | Starters |
|---|---|---|---|
| 1 | 7d window + activity check | 112 | 3 |
| 2 | + ST `max_pages` 20 | 211 | 7 |
| 3 | + enrich all identity-checked | 257 | 8 |
| **Total** | | **580** | |

Each standard RPC call costs 1 credit. The free plan allows 1M credits a month, so this is under 0.1%. Solana Tracker used about 45 + 70 + 70 requests across the three runs, against a free quota of 2,500 or 10,000 a month (the two docs pages conflict).

## Drop counts (final run)
- Fetched 3,824 rows: Solana Tracker 2,324, Birdeye 1,500.
- Rows dropped:

  | Reason | Count |
  |---|---|
  | `bot_trade_rate` | 2,386 |
  | `whale_trade_size` | 323 |
  | `low_win_rate` | 15 |
  | `implausible_win_rate` | 1 |
- Wallets dropped:

  | Reason | Count |
  |---|---|
  | `one_token_profit` | 32 |
  | `inactive` | 12 |
  | `short_hold` | 10 |
  | `not_memecoin_trader` | 7 |
- 889 candidates remained:
  - 8 verified
  - 11 activity-checked
  - **8 starters**
  - 878 Birdeye-only rows with `identity_checked=false`, because Birdeye identity returns 401 on our plan.

## Final starter table (not written to wallets.csv)
All times are UTC. Every wallet's last swap was on 2026-10-28.

| # | Address | Label | Window | Win% | Trades/day | Avg trade $ | Top token % | Median hold (s) | Last swap | SOL-quoted % | In current list |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | AosepN8EQoch2n3tv3UJ8n2ENy1sFqAikHWXKK4Mcjwr | kimchi | 30d+90d | 62.7 | 8.7 | 1,818 | 5.9 | 2,066 | 15:04 | 100 | no |
| 2 | 4T8x9dxDfEHrePNrjZ5b81JnEreLWSt54MUG57DWbmFM | - | 90d | 71.5 | 27.3 | 911 | 7.1 | 69,905 | 15:14 | 100 | no |
| 3 | AXmMxJMLBQ131eRPuuTDvc9ioidgRsrLZwN7C1i1PJwd | - (st-AXmM in wallets.csv) | 30d | 57.7 | 35.3 | 382 | 22.4 | 442 | 15:35 | 100 | **yes** |
| 4 | GwSwopjoSe1nTyBBADzkNKxaCuvJtHTEdWgq4MCfpESh | WoolenRoanChamp | 30d+90d | 33.1 | 16.4 | 2,963 | 27.0 | 72,807 | 12:11 | 100 | **yes** |
| 5 | 6vR8b54MDixQ1N4Bq2mRwXkvuqWfRgpkgzQ8JgXqujuf | - | 30d+90d (BE) | - | 18.4 | 421 | 19.0 | 307 | 14:23 | 100 | no |
| 6 | G2feiXYzJKasN3VvtdDGLksDNDAxsUBF52HrofPk53MF | - | 90d | - | 28.8 | 491 | - | 7,890,093 | 20:41 | 66.7 | no |
| 7 | H19LxzTnHjDaQEXkuz1h2w57yWZzwY2sjGUGRYhu7VY6 | - | 30d | - | 39.0 | 597 | - | 1,283,443 | 22:08 | 100 | no |
| 8 | HVPXJKUBympnDaD9Mj5PRdmKbtukv3MZvE9g6P6Dh8gp | - | 7d | - | 31.4 | 370 | - | 1,131,928 | 19:58 | 100 | no |

These wallets were activity-checked but failed the starter rules, all on trades/day > 40:
- G3eWaBWuboTjBARo2otA6o3GEg9LFkd1Pf7N3yw8sSz1: 51.2 trades/day
- AuT92NT9PWmRdNdK6GPbQk8n5vBXfpB4tUP9e9Kj3bLu: 45.1 trades/day
- Hn6vBWWySnxA8XjxRQDEmZEuH5QL7KqosnJGcLcUzFJ6: 48.1 trades/day

Current 6 wallets:
- **GwSw… and AXmM… still pass.**
- **BRjV…, 6ACu…, 9e6Z… and GWQu… are not in the final candidates.** They were either dropped (inactive, not SOL-quoted, one-token, or bot rate) or are no longer on any leaderboard. The report doesn't record the per-wallet reason for dropped wallets.

## What to check / decide
1. **Choose how to reach 12+ wallets** (each option needs your decision):
   - **(a) Write the 8 starters now.** That replaces 4 quiet wallets with 6 active ones. A one-off command could build the file from the `starter=true` rows of `data/wallets.candidates.csv`.
   - **(b) Raise `starter.max_trades_per_day` from 40 to 55.** That adds the 3 wallets above, for 11.
   - **(c) Get identity for the 878 Birdeye-only wallets.** Birdeye identity needs a higher plan, or a different identity source. This is the largest pool left.
   - **(d) Relax `short_hold` or `one_token_profit`.** These two filters dropped 42 enriched wallets, though some would still fail the activity or starter checks. I don't recommend it.
2. **Rows 6–8 have median holds of 13–91 days** (all-time profitable positions). They may be long-term holders who trade memecoins rarely. Spot-check them on Solscan before you copy them.
3. **HvvEk6DkVfri3xGqvh4KK3eVqtGT6RRvdWaaKBA5j1gV** returned a Solana Tracker positions response that failed our zod schema. That may be shape drift worth a `--record` look.
4. **README already said discovery drops average trades "above $10k"**, but `rules.yaml` has used 3,000 since the M0.5 tuning. I left that line alone, out of scope.
5. **Before the next engine restart:** `rules.yaml` changed shape (`min_days` and `max_pages` are now maps, and there are new sections). `apps/engine/dist` is already rebuilt to match. The running engine has the old config in memory, which is fine until it restarts.
6. **Backups:** `/tmp/wallets.csv.before-2026-10-29` and `/tmp/wallets.candidates.before.csv`.

## Follow-up (2026-10-29, morning): on-chain identity + cap 55 → wallets.csv written
Branch `m05-onchain-identity`, fast-forwarded into `main`. **The engine was NOT restarted**, as you asked: M2 merges first and then there will be a single restart. The running engine still has the old 6 wallets in memory.

### Decisions
1. **On-chain identity substitute.** A row no provider could identify gets one Helius `getAccountInfo` call when enrichment reaches it.
   - If the address is owned by the System Program, it counts as a plain wallet: `identity_checked=true`, `identity_source=onchain`.
   - Any other owner (a program, token account or PDA) is dropped as `not_system_owned`.
   - If the account is missing or the call fails, the row stays unchecked and can't become a starter (fail closed).
   - The check runs before the Solana Tracker positions call, so non-wallets cost nothing more.
   - It's documented in the README, `docs/providers/helius.md` and `docs/providers/birdeye.md`. The `getAccountInfo` fixtures are doc-derived.
2. **The starter `max_trades_per_day` is now 55** (was 40).
3. **`enrich_top_n` is now 160** (was 80).
   - With 80, the budget ran out on provider-checked candidates before any unidentified row was reached. That run had 0 on-chain rows and exactly 12 starters.
   - With 160 there were 9 on-chain rows and 20 starters.
   - Cost: up to 160 Solana Tracker positions requests per run.
4. **How `wallets.csv` was written:** by a one-off script outside the repo (`/tmp/scb-write-wallets.mjs`). Discovery code still can't write it.
   - Labels: the current label for a kept wallet, otherwise the provider label (sanitized), otherwise `st-`/`be-` plus the first 4 characters of the address.
   - The CSV went through the engine's own `parseWallets` before an atomic rename.
   - The backup is at `/tmp/wallets.csv.before-2026-10-29b`.

### Runs
| Run | Change | Helius credits | Starters |
|---|---|---|---|
| 4 | on-chain identity + cap 55 | 277 | 12 (0 on-chain) |
| 5 | + `enrich_top_n` 160 | 555 | **20** (9 on-chain) |

Run 5 drops:

| Reason | Count |
|---|---|
| `bot_trade_rate` | 2,393 |
| `whale_trade_size` | 323 |
| `one_token_profit` | 90 |
| `short_hold` | 24 |
| `low_win_rate` | 15 |
| `inactive` | 15 |
| `not_memecoin_trader` | 10 |
| `implausible_win_rate` | 1 |
| `not_system_owned` | 0 |

### data/wallets.csv: 20 wallets, source `discover-2026-10-29b`
- **Kept:** GwSw… (WoolenRoanChamp) and AXmM… (st-AXmM).
- **Removed:** BRjV…, 6ACu…, 9e6Z… and GWQu….
- **Added:** 18 new wallets, 9 of them identified on-chain (`be-*` labels with `identity_source=onchain`).

The full table is in the final message of this session and in the `starter=true` rows of `data/wallets.candidates.csv`.

### Check before / after the restart
- **Very long median holds:** `be-DvyV`, `be-DYXK`, `be-Dsbh`, `st-G2fe`, `st-H19L` and `st-HVPX` have median holds of 13–91 days. They may be holders rather than active flippers. Spot-check them on Solscan.
- **`st-9rmY` is exactly at the threshold** (`sol_quote_pct` 50.00), from a small swap sample.
- **On-chain identity can't recognise every exchange or market maker.** Watch the first day's signals from the `be-*` wallets.
- **After the restart, `subscriptions_acked` in `events_log` should be 20.**
