# smart-copy-bot

## What this repo is
A personal Solana research system. It watches curated wallets, turns their buys into signals, applies 6 fail-closed rules, paper-trades the survivors and shows the funnel on a dashboard. Live trading comes last, behind a gate.

It is a TypeScript pnpm workspace:
- `apps/engine` is the pipeline.
- `apps/dashboard` is Next.js and reads the DB read-only.
- `packages/shared` holds the zod config/env, the Drizzle schemas and migrations, and the provider interfaces.

## Read first
- `PLAN.md` is the source of truth. Read it fully before any milestone. §10 lists the milestones and their acceptance criteria.
- `config/rules.yaml` holds every threshold.

## Commands
- Install / build / test: `pnpm i && pnpm build && pnpm test`
- Lint / format: `pnpm lint` / `pnpm format` (Biome)
- After a schema change: `pnpm db:generate`, then commit the generated SQL in `packages/shared/drizzle/`.
- `pnpm db:migrate` applies the migrations to `data/control.db` and to `demo.db`, `paper.db` and `live.db`.
- Run the engine: `pnpm start`. Run it from the repo root, because `DATA_DIR` and `RULES_PATH` are relative paths.
- Wallet discovery: `pnpm wallets:discover [--record]` writes `data/wallets.candidates.csv` only. Never make it write `data/wallets.csv`.

## Workflow
- Plan first, wait for approval, then implement. One milestone per branch/PR.
- At the end of each milestone, summarize what changed, how to run it, and what the user should check manually.

## Non-negotiables
- **Three modes: DEMO, PAPER (default) and LIVE.**
  - Each mode's trading data lives in its own file (`data/demo.db`, `data/paper.db`, `data/live.db`), so fake or simulated PnL can never mix with real PnL.
  - Mode state (`app_settings`, `mode_changes`) lives only in `data/control.db`. No reset or seed script may touch control.db.
  - The engine always starts in PAPER. Boot resets the requested and active mode to PAPER, but never clears `kill_switch`.
  - The UI can only *request* a mode. The engine decides, and it records every attempt in `mode_changes`.
- **No secrets in the repo.**
  - Only `.env.example` is committed. `.env`, `data/raw/` and `*.db` are gitignored.
  - The UI must never have a field for a private key or seed phrase; it shows only public addresses.
  - Never log env values.
- **Rules fail closed.**
  - Missing or stale data means KILLED with `data_unavailable`.
  - An invalid `rules.yaml` stops the engine. The zod schema is strict and has no code defaults.
  - Errors never open a position.
- **Providers sit behind interfaces.**
  - Every external provider (Helius, DexScreener, RugCheck, Jupiter, SolanaTracker, Birdeye, LLMs) sits behind an interface in `packages/shared` and has recorded fixtures (`packages/shared/test/fixtures/`, with a `_provenance` field per file, either doc-derived or recorded). Provider notes live in `docs/providers/<name>.md`.
  - Tests never hit the network.
- **No real transactions outside M7.** No code path may sign or send a real transaction except the M7 live executor, and only behind its gate (PLAN §9):
  - `LIVE_ENABLED=true`
  - `LIVE_CONFIRM=I_UNDERSTAND_THE_RISK`
  - the wallet balance check
  - the dashboard confirmation
  - Before M7, nothing imports a signer or holds a private key.

## Conventions (PLAN §11)
- **Verify every external API against its current docs** before writing a client, and record endpoints, auth, rate limits and response shapes in `docs/providers/<name>.md`. Don't rely on memory for endpoints.
- **Respect rate limits.** Use queues plus exponential backoff with jitter, and log provider 429s.
- **Keep all thresholds in `config/rules.yaml`.** No magic numbers in code. A new threshold needs a schema entry in `packages/shared/src/config.ts`.
- **Use structured pino logs**, with `signal_id` on every line of the pipeline.
- **Enforce invariants in the DB where possible.** Examples: the unique `tx_sig` and one open position per mint.
- **Keep the schema Postgres-portable:** ms-integer timestamps, int booleans, JSON as text.
- **Push after every fast-forward of main:** run `git push origin main` (remote: git@github.com:hassanannajjar/smart-copy-bot.git). Never force-push. If the push fails, report it; don't retry with --force.

## Definition of done
- `pnpm build && pnpm test && pnpm lint` passes.
- The milestone's acceptance criteria in PLAN §10 are met.
- New logic has a test, including its failure paths.

## When stuck
Stop after three failed attempts. Report the error, what you tried and your hypothesis.
