import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { beGainersSchema, beIdentitiesSchema } from '../src/providers/birdeye.js';
import { dsTokenPairsSchema } from '../src/providers/dexscreener.js';
import { gtOhlcvSchema } from '../src/providers/geckoterminal.js';
import {
  heliusAccountSchema,
  heliusLogsNotificationSchema,
  heliusPriorityFeeSchema,
  heliusSignaturesSchema,
  heliusTxPageSchema,
  heliusTxSchema,
  rpcResultSchema,
} from '../src/providers/helius.js';
import { jupOrderSchema, jupPriceSchema } from '../src/providers/jupiter.js';
import { rcReportSchema } from '../src/providers/rugcheck.js';
import { stLeaderboardSchema, stPositionsSchema } from '../src/providers/solanatracker.js';

// Every fixture (doc-derived or recorded with --record) must parse through its provider schema.
const SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  solanatracker: { 'leaderboard-top': stLeaderboardSchema, positions: stPositionsSchema },
  birdeye: { 'gainers-losers': beGainersSchema, 'identity-multiple': beIdentitiesSchema },
  helius: {
    'logs-notification': heliusLogsNotificationSchema,
    signatures: rpcResultSchema(heliusSignaturesSchema),
    'tx-': rpcResultSchema(heliusTxSchema), // prefix: one file per parse outcome
    'account-': rpcResultSchema(heliusAccountSchema), // prefix: wallet, token, missing
    'launch-': rpcResultSchema(heliusTxPageSchema), // prefix: one file per mint (M2, R4)
    'priority-fee': rpcResultSchema(heliusPriorityFeeSchema), // M3 paper fees
  },
  // M3 paper executor: quotes (buy/sell/no-route) and Price V3.
  jupiter: { 'order-': jupOrderSchema, 'price-': jupPriceSchema },
  // M2 (pnpm rules:record): one file per mint, or per pool for OHLCV.
  dexscreener: { 'token-pairs-': dsTokenPairsSchema },
  rugcheck: { 'report-': rcReportSchema },
  geckoterminal: { 'ohlcv-': gtOhlcvSchema },
};

const dir = (p: string) => new URL(`./fixtures/${p}/`, import.meta.url);
const schemaFor = (schemas: Record<string, z.ZodType>, name: string) =>
  schemas[name] ??
  schemas[Object.keys(schemas).find((k) => k.endsWith('-') && name.startsWith(k)) ?? ''];

describe('provider fixtures', () => {
  for (const [provider, schemas] of Object.entries(SCHEMAS)) {
    const files = readdirSync(dir(provider)).filter((f) => f.endsWith('.json'));

    it(`${provider}: has a fixture for every schema`, () => {
      for (const key of Object.keys(schemas))
        expect(
          files.some((f) => (key.endsWith('-') ? f.startsWith(key) : f === `${key}.json`)),
        ).toBe(true);
    });

    for (const file of files) {
      it(`${provider}/${file}: has provenance and parses`, () => {
        const f = JSON.parse(readFileSync(new URL(file, dir(provider)), 'utf8'));
        expect(f._provenance).toMatch(/^(doc-derived|recorded)\b/);
        const schema = schemaFor(schemas, file.replace('.json', ''));
        expect(schema).toBeDefined();
        expect(() => schema?.parse(f.response)).not.toThrow();
      });
    }
  }

  it('no fixture contains an API key', () => {
    // Real key values from a local .env (when present), plus the auth markers they'd ride on.
    const envFile = new URL('../../../.env', import.meta.url);
    const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
    const secrets = Object.entries(env)
      .filter(([k, v]) => k.endsWith('_API_KEY') && v && v.length >= 8)
      .map(([, v]) => v as string);
    for (const provider of readdirSync(dir('.'))) {
      for (const file of readdirSync(dir(provider)).filter((f) => f.endsWith('.json'))) {
        const text = readFileSync(new URL(file, dir(provider)), 'utf8');
        expect(text, `${provider}/${file}`).not.toMatch(/api-key=|x-api-key|"apiKey"/i);
        for (const s of secrets) expect(text.includes(s), `${provider}/${file}`).toBe(false);
      }
    }
  });
});
