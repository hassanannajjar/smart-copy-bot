import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { beGainersSchema, beIdentitiesSchema } from '../src/providers/birdeye.js';
import {
  heliusLogsNotificationSchema,
  heliusSignaturesSchema,
  heliusTxSchema,
  rpcResultSchema,
} from '../src/providers/helius.js';
import { stLeaderboardSchema, stPositionsSchema } from '../src/providers/solanatracker.js';

// Every fixture (doc-derived or recorded with --record) must parse through its provider schema.
const SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  solanatracker: { 'leaderboard-top': stLeaderboardSchema, positions: stPositionsSchema },
  birdeye: { 'gainers-losers': beGainersSchema, 'identity-multiple': beIdentitiesSchema },
  helius: {
    'logs-notification': heliusLogsNotificationSchema,
    signatures: rpcResultSchema(heliusSignaturesSchema),
    'tx-': rpcResultSchema(heliusTxSchema), // prefix: one file per parse outcome
  },
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
});
