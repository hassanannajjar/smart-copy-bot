# RugCheck

Verified on **2026-10-29** against the official Swagger spec, and against real reports recorded the same day with `pnpm rules:record`.

Sources:
- Swagger UI: https://api.rugcheck.xyz/swagger/index.html
- Spec: https://api.rugcheck.xyz/swagger/doc.json
- Keyed plans: https://fluxrpc.com/rugcheck/ (third party, not verified by us)

Code: `packages/shared/src/providers/rugcheck.ts`. Fixtures: `packages/shared/test/fixtures/rugcheck/report-<mint8>.json`.

## Auth, limits, cost
- **`GET /v1/tokens/{id}/report` has no `security` entry in the spec, so it needs no key.** We have no RugCheck key.
  - Endpoints that do need a JWT in the `Authorization` header: bulk reports, lockers and verification.
  - The `refresh=true` parameter (force a fresh report) is "paid API keys only".
- **Rate limit:** the spec documents a 429 response but gives no number.
  - A keyless response carried `x-rate-limit-limit: 15` and `x-rate-limit-remaining: 14`, with no window header.
  - Third-party write-ups say per minute: 10 unauthenticated and 60 authenticated (2025). Newer sources say 3 rps on the free FluxRPC key.
  - We assume **15/min** and throttle to 1 call per 4.5 s (`enricher.rugcheck.min_interval_ms: 4500`, about 13/min).
- Cost: free (keyless).
- **Freshness:** the keyless report can be a **cached** report, and the response doesn't say how old it is. `detectedAt` is when RugCheck first saw the token, not the report time. The top-holder and LP numbers can lag the chain. This is listed in the review items of the M2 note.

## Endpoint used: `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report`
Amounts are **raw base units**; divide by `10^token.decimals`. `pct` fields are percentages (0–100).

| Field | Used for |
|---|---|
| `token.supply`, `token.decimals` | The denominator for R3 and R4. |
| `token.mintAuthority`, `token.freezeAuthority` | R6. `null` means revoked. The top-level `mintAuthority` and `freezeAuthority` repeat them. |
| `creator`, `creatorBalance` | R3: `creatorBalance / supply`. This is the creator wallet only (see limits). |
| `topHolders[]` | R2. Each is `{address (token account), owner, amount, pct, insider, …}`. **20 entries.** |
| `knownAccounts{addr: {name, type}}` | R2 exclusions. Seen types: `AMM` (pool vaults, the pump.fun curve), `LOCKER`, `CREATOR`. |
| `markets[]` | Each market is `{pubkey (= DexScreener pairAddress), marketType, mintLP, liquidityA/B (vaults), lp{lpLockedPct, baseUSD, quoteUSD, …}}`. Seen `marketType` values: `pump_fun`, `pump_fun_amm`, `raydium_cpmm`, `meteora_damm_v2`. |
| `insiderNetworks[]` | R4. Each is `{id, size, type: "transfer", tokenAmount, currentHolding, activeAccounts}`: wallet clusters linked by transfers or funding. It is `null` when none are found. |
| `graphInsidersDetected`, `totalHolders`, `rugged`, `risks[]` | Kept in `raw_json` for tuning; no rule uses them. |

## How the rules read it
- **R2:** the top holders minus:
  - holders whose owner or address has a type listed in `enricher.R2_exclude_known_types` (default `[AMM]`),
  - market vault accounts (`liquidityA` / `liquidityB`),
  - owners in `enricher.R2_exclude_owners` (the incinerator and the system program).

  Then we sum the first 10. Lockers and the creator **still count**: locked team tokens are still concentrated supply.
- **R6, LP part:** we use the market whose `pubkey` equals the chosen DexScreener pair.
  - `mintLP` = `11111111111111111111111111111111` means the venue has no LP token, so the LP leg doesn't apply. That covers the pump.fun curve and Meteora DAMM v2 position NFTs.
  - Otherwise `lp.lpLockedPct` must be at least `rules.R6_min_lp_locked_pct`.
  - If no market matches the pair, the result is `data_unavailable`.
- **R1 fallback:** when DexScreener has no `liquidity.usd` (pump.fun curve), liquidity is that market's `lp.baseUSD + lp.quoteUSD`.

## Known limits
- R3 sees only the `creator` wallet. A dev who moved tokens to other wallets is only caught by R2 or R4 (insider networks).
- `topHolders` stops at 20. If more than 10 of them are excluded, R2 sums fewer than 10 holders.
