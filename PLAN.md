# Smart-Money Copy Bot — Build Plan (Solana)

> This file is the source of truth for Claude Code. Read it fully before any milestone.
> Build milestone by milestone. Present a plan, wait for approval, then implement.

---

## 0. Goal, non-goals, reality check

**Goal.** A personal research system that:
1. Watches a curated list of Solana wallets ("smart wallets").
2. Turns their token buys into **signals**.
3. Runs every signal through **6 hard rules** (fail-closed) and logs why each one was killed.
4. **Paper-trades** the survivors with realistic latency, slippage and fees.
5. Shows the whole funnel on a **dashboard** (Scout → Filter → Analyst → Guard → Copied, kill reasons, copy log, PnL).
6. Only later, behind a strict gate, trades **live** with a tiny hot wallet.

**Non-goals.** No managing other people's funds, no selling signals, no front-running / sandwiching / MEV extraction, no wash trading or any market manipulation. Personal use only.

**Reality check (put this in the README).**
- Screenshots like "17x, 67% win rate" are usually cherry-picked marketing. Expect most signals to lose.
- By the time we _see_ a smart wallet's buy, the price has already moved. Copy latency is the core edge problem.
- Many "smart wallets" are insiders/devs of the tokens they buy. Rugs gap down — a stop-loss does not save you from a rug.
- **Success metric for paper phase:** net-positive PnL **after** fees, slippage and simulated latency, over ≥ 4 weeks and ≥ 50 closed trades, with acceptable max drawdown. Anything less = do not go live.

---

## 1. Stack

- **Language:** TypeScript everywhere, Node.js current LTS (verify), **pnpm** workspaces.
- **Layout:**

  ```
  apps/engine        # long-running pipeline process (scout, enrich, rules, executor, positions)
  apps/dashboard     # Next.js, reads DB read-only
  packages/shared    # types, zod config, Drizzle schema, provider interfaces
  config/rules.yaml  # all thresholds (no magic numbers in code)
  data/wallets.csv   # curated wallet list (address,label,source)
  data/raw/          # recorded raw events for replay (gitignored)
  docs/providers/    # notes on each external API as verified at build time
  ```
- **DB:** SQLite (better-sqlite3, WAL mode) + Drizzle ORM + migrations. Keep Postgres-compatible types so we can move later.
- **Libs:** zod (config/env validation), pino (structured logs), vitest (tests), p-queue/bottleneck (rate limits), @solana/web3.js (or current successor — verify).
- **External providers** (each behind an interface in `packages/shared/providers`, with recorded fixtures for tests):
  - **Helius** — RPC + streaming of wallet transactions + parsed swap data.
  - **DexScreener** — pair, liquidity, price, price change, pair age.
  - **RugCheck** (and/or Helius DAS / on-chain reads) — holders, top-10 %, mint/freeze authority, LP status, risk flags.
  - **Jupiter** — quotes (used for paper slippage) and swaps (live only).
- **Rule:** before writing any provider client, check the provider's _current_ docs, write what you found (endpoints, auth, rate limits, response shapes) to `docs/providers/<name>.md`. Do not rely on memory for endpoints.

---

## 2. Architecture

```
 Scout ──► Enricher ──► Rules ──► Analyst (optional, shadow) ──► Guard ──► Executor (paper|live) ──► PositionManager
   │          │           │              │                         │              │                       │
   └──────────┴───────────┴──────────────┴─────────────────────────┴──────────────┴───────────────────────┴──► SQLite ──► Dashboard
```

- In-process typed event bus / queue inside `apps/engine`. Each stage is a module with a clear input/output type.
- **Every stage writes to the DB**, so the dashboard can rebuild the funnel and we can audit any decision.
- **Replay mode:** the engine can consume `data/raw/*.jsonl` instead of the live stream, so rules can be re-run with new thresholds offline.
- **Modes (three, always explicit):**
  - `DEMO` — dashboard shows seeded fake data only. No engine, no network. For UI work and showing the app.
  - `PAPER` (default) — real market data, simulated money. No transaction is ever signed.
  - `LIVE` — real wallet, real transactions. Only possible if the engine was started with the live env flags (§9).
- The active mode lives in the `app_settings` table and is switchable from the dashboard (§7.1), but the engine enforces the rules — the UI can only request a mode, never bypass the gate.
- DEMO / PAPER / LIVE data is stored separately (separate DB files: `demo.db`, `paper.db`, `live.db`) so fake or simulated numbers can never mix with real PnL.

---

## 3. Data model (Drizzle)

- `wallets(address PK, label, source, added_at, active bool, score real, notes)`
- `signals(id PK, wallet, mint, side, amount_sol, amount_token, tx_sig UNIQUE, block_time, detected_at, detect_latency_ms)`
- `token_snapshots(id PK, signal_id, mint, taken_at, price_usd, liquidity_usd, fdv_usd, pair_address, pair_created_at, price_change_5m, price_change_45m, top10_pct, dev_pct, bundled_pct, mint_authority_revoked, freeze_authority_revoked, lp_locked_pct, raw_json)`
- `rule_results(id PK, signal_id, rule_id, passed bool, value, threshold, reason)`
- `decisions(signal_id PK, verdict ['PASSED','KILLED','SKIPPED'], killed_by, all_failed_json, decided_at)`
- `analyst_reviews(id PK, signal_id, provider, model, verdict, confidence, rationale, latency_ms, cost_usd, used_for_decision bool)`
- `positions(id PK, signal_id, mode ['paper','live'], mint, size_usd, entry_price, entry_at, stop_price, tp_plan_json, status ['open','closed'], exit_price, exit_at, exit_reason, gross_pnl_usd, fees_usd, slippage_bps, net_pnl_usd, net_pnl_pct)`
- `fills(id PK, position_id, side, qty, price, fee_usd, tx_sig nullable, simulated bool, at)`
- `events_log(id PK, at, level, stage, message, data_json)` — for the dashboard "activity" feed.
- `app_settings(key PK, value, updated_at, updated_by)` — holds `requested_mode`, `active_mode`, `kill_switch`.
- `mode_changes(id PK, at, from_mode, to_mode, requested_by, accepted bool, reason)` — audit log of every mode switch attempt.

Constraints: one open position per mint; per-mint cooldown (config); sells from tracked wallets are recorded but don't open positions (may trigger optional exit-follow later).

---

## 4. The 6 hard rules (`config/rules.yaml`)

All rules are **pure functions** `(snapshot, config) → RuleResult`. Evaluate **all** rules, store **all** results, `killed_by` = first failing rule in priority order. **Missing or stale data → KILLED with reason `data_unavailable`** (fail closed).

| ID  | Rule                                                                                                                                            | Default                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| R1  | Liquidity USD ≥ threshold                                                                                                                       | 30,000                                            |
| R2  | Top-10 holders % ≤ threshold (exclude pool/LP, burn and known program addresses)                                                                | 40%                                               |
| R3  | Dev/creator holding % ≤ threshold                                                                                                               | 8%                                                |
| R4  | No bundled launch: share of supply bought in first 60s by wallets that look related (same funder, same slot cluster, fresh wallets) ≤ threshold | 15% (v1 heuristic — document it, mark as tunable) |
| R5  | Not overextended: price change over last 45 min ≤ threshold                                                                                     | +80%                                              |
| R6  | Contract safety: mint authority revoked AND freeze authority revoked AND (LP burned/locked ≥ 90% where the venue has LP tokens)                 | required                                          |

**Pre-filters (logged as `SKIPPED`, not counted as kills):** ignore sells, ignore SOL/stables/majors (allowlist), ignore tokens outside age window (config), ignore buys below min size (config, to drop dust).

R4 is the hardest. Implement v1 as a documented heuristic with unit tests on fixtures, and expose its sub-scores in `rule_results.value` so it can be tuned in replay.

---

## 5. Paper execution — realism is the whole point

- **Size:** fixed `position_size_usd` (default 50).
- **Entry price:** not the price the smart wallet got. Use a Jupiter quote for our size at `detected_at + simulated_latency_ms` (default 1500 for home, 300 for VPS). Add priority fee + base fee + any platform fee. Store slippage in bps.
- **Guard (set before entry):** stop-loss % (default −30%), TP ladder (e.g. sell 50% at 2x, trail the rest with 25% trailing stop), time stop (default 24h). All in config.
- **Exits:** poll price every N seconds (default 5s, batched, rate-limited). When a trigger is hit, exit at a **fresh quote for our size** at that moment + latency — not at the stop price. Gaps are real.
- **Rug detection:** if liquidity drops > X% (config) between polls, mark `exit_reason='rug'` and exit at quoted price (may be ≈ −100%).
- **PnL:** gross, fees, slippage, net — all stored per position.

---

## 6. Wallet list

- Start with a manually curated `data/wallets.csv` of 10–30 wallets (user supplies). Validate addresses on load.
- Milestone M0.5 adds `pnpm wallets:discover`, which builds a **candidate shortlist** to help with that curation.
  - It pulls the Solana Tracker top-traders leaderboard and Birdeye gainers over 30d and 90d windows.
  - It drops arbitrage/MEV bots, exchange and program addresses, and wallets whose profit is mostly from one token.
  - It ranks by consistency and writes `data/wallets.candidates.csv` for manual review.
  - It never writes `data/wallets.csv`. Provider details are in `docs/providers/`.
- Milestone M5 adds **wallet scoring** from our own data: per-wallet signal count, pass rate, paper win rate, avg net R, time-to-peak after their buy. Auto-deactivate wallets below thresholds; flag wallets that are often first buyers / creators of the tokens they "call" (likely insiders).
- Never trust a purchased/shared list blindly — everything is scored by our own results.

---

## 7. Dashboard (Next.js, read-only DB)

### 7.1 Mode control & visibility (required)

- **Mode switcher** in the header: `DEMO` / `PAPER` / `LIVE`.
- **Always-visible banner, impossible to miss**, on every page:
  - DEMO → grey banner: "DEMO DATA — not real".
  - PAPER → blue/amber banner: "PAPER TRADING — real market data, simulated money".
  - LIVE → **solid red, sticky banner**: "LIVE — REAL FUNDS", showing the hot wallet's **public** address (shortened), current SOL/USDC balance, today's PnL, daily loss limit remaining, and a **STOP / Kill switch** button.
  - The browser tab title and favicon also change in LIVE (e.g. "🔴 LIVE — Copy Bot").
- **Switching to LIVE** from the UI:
  1. Button is disabled with a tooltip explaining why unless the engine reports it was started with the live env flags (§9) and a wallet is configured.
  2. Confirmation modal shows: wallet address, balance, position size, max open positions, daily loss limit.
  3. User must type `LIVE` to confirm.
  4. Engine validates again server-side, then writes `active_mode`; the UI only reflects what the engine confirmed.
- **Switching back to PAPER / kill switch:** one click, no confirmation, always available. On kill: stop opening positions immediately; asks whether to close open live positions or keep managing them.
- **Never** a field in the UI to paste a private key or seed phrase. The UI shows only the public address; the key lives in `.env` on the engine machine.
- Every table/card that shows numbers carries a small mode tag (DEMO/PAPER/LIVE) so screenshots can't be misread.
- Every switch attempt (accepted or rejected) goes to `mode_changes` and is visible on a "Mode history" panel.

### 7.2 Panels

- **Top banner:** see 7.1, plus engine heartbeat and last signal time.
- **Overview:** wallets watched, signals received, killed, passed, copied, net PnL, win rate, return multiple.
- **Copy funnel:** Scout → Filter → Analyst → Guard → Copied with counts.
- **Why signals got killed:** bar chart by `killed_by`.
- **Copy log:** time, token (short mint + link to Solscan), source wallet, rules passed (6/6), entry, exit, exit reason, net PnL.
- **Wallet leaderboard** (after M5).
- **Settings (read-only):** current thresholds from `rules.yaml`.
- Bind to localhost by default; basic auth if deployed.

---

## 8. Analyst (optional, M6) — shadow mode first

- Pluggable LLM provider interface (any vendor). Input: structured token summary JSON (+ social data only if a source is configured; X API is paid — skip initially).
- **Shadow mode:** verdict and confidence are logged; they do **not** affect decisions.
- The analyst can only **veto** a signal that passed rules — never approve one that rules killed.
- Hard timeout (default 3s); on timeout/error → fall back to rules-only.
- Token names/descriptions/social text are **untrusted input** — treat as data, guard against prompt injection, never let model output change config or execute actions.
- Promote from shadow only if, after ≥ 100 reviewed signals, replay shows it improves net PnL vs rules-only.

---

## 9. Live mode (M7) — gated, do not start early

**Gate (all required):** ≥ 4 weeks paper, ≥ 50 closed paper trades, positive net PnL after costs, acceptable max drawdown, user has reviewed the executor code.

- Dedicated **hot wallet** with a small balance only. Private key only in `.env` (gitignored), loaded only by the executor module, never logged, never sent to the dashboard or any LLM.
- Live requires **both** `LIVE_ENABLED=true` and `LIVE_CONFIRM=I_UNDERSTAND_THE_RISK` in the engine env, plus a runtime check of wallet balance ≤ configured max. Without these, the engine rejects any LIVE request from the dashboard (§7.1) and logs it in `mode_changes`.
- Even with the env flags set, the engine **starts in PAPER**. LIVE is only entered via the dashboard confirmation flow, and a restart always comes back in PAPER.
- Jupiter swap: slippage cap, priority-fee cap, **simulate transaction before sending**, confirm and record `tx_sig`.
- Stops are bot-managed (or exchange trigger orders if the current Jupiter API supports them — verify). If the engine is down, stops don't fire → heartbeat + alert.
- **Risk limits (config):** max position USD, max open positions, max trades/hour, **daily loss limit → auto-halt**, global **kill switch** (file flag + CLI command + dashboard button).
- Alerts (Telegram bot or similar): entries, exits, halts, errors, heartbeat missed.
- Deploy: VPS near Solana infrastructure (e.g. Frankfurt/Amsterdam), systemd or pm2, log rotation, nightly DB backup.

---

## 10. Milestones & acceptance criteria

| #   | Milestone                                                                                                                                               | Acceptance                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Scaffold: workspace, shared package, zod config/env, Drizzle schema + migrations, `rules.yaml`, `.env.example`, lint, vitest, README with reality check | `pnpm i && pnpm build && pnpm test` green; `pnpm db:migrate` creates all tables                                                                       |
| M0.5 | Wallet discovery (§6): Solana Tracker + Birdeye providers behind interfaces, doc-derived fixtures, `pnpm wallets:discover [--record]` writes `data/wallets.candidates.csv` | Build/test/lint green offline; no keys gives a clear one-line message and exit 1; never writes `data/wallets.csv` |
| M1  | Scout: stream tracked wallets' swaps via Helius, parse buys/sells, write `signals`, record raw events to `data/raw/`                                    | Run against 5 wallets, signals appear in DB with `detect_latency_ms`; reconnect/backoff tested                                                        |
| M2  | Enricher + Rules: providers for DexScreener + RugCheck/on-chain, `token_snapshots`, 6 rules, `rule_results`, `decisions`                                | Unit tests per rule (pass/fail/missing data) on fixtures; live run shows KILLED/PASSED with reasons in DB                                             |
| M3  | Paper executor + PositionManager: Jupiter quotes, latency, fees, guard, TP ladder, trailing, time stop, rug exit                                        | Unit tests for exit logic; live run opens/closes paper positions with full PnL breakdown                                                              |
| M4  | Dashboard (§7) incl. mode switcher + banners (§7.1)                                                                                                     | All panels render from real DB data; DEMO/PAPER/LIVE banners correct; LIVE button disabled with explanation until M7; switching writes `mode_changes` |
| M5  | Replay CLI (re-run rules/paper on `data/raw` with alternate config) + wallet scoring                                                                    | `pnpm replay --config alt.yaml` outputs funnel + PnL comparison table; leaderboard on dashboard                                                       |
| M6  | Analyst in shadow mode (§8)                                                                                                                             | Reviews stored; replay report compares rules-only vs rules+veto                                                                                       |
| M7  | Live executor behind gate (§9)                                                                                                                          | Dry-run against devnet or simulate-only path; kill switch and daily loss halt tested; user approval before first mainnet trade                        |

---

## 11. Conventions for Claude Code

- Plan first, wait for approval, then implement. One milestone per branch/PR.
- Verify every external API against current docs; record in `docs/providers/`.
- Every provider behind an interface with recorded fixtures; tests never hit the network.
- No secrets in the repo. Only `.env.example`. `.env`, `data/raw/`, `*.db` are gitignored.
- Default mode is PAPER. Never add a code path that sends a real transaction outside the M7 executor and its gate.
- Fail closed: missing data kills a signal; errors never open a position.
- Respect rate limits (queues + exponential backoff with jitter). Log provider 429s.
- All thresholds in `config/rules.yaml`; no magic numbers.
- Structured logs (pino) with `signal_id` on every line of the pipeline.
- At the end of each milestone: summarize what changed, how to run it, and what the user should check manually.
