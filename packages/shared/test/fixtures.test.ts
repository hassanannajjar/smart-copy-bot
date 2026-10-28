import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beGainersSchema, beIdentitiesSchema } from '../src/providers/birdeye.js';
import { stLeaderboardSchema, stPositionsSchema } from '../src/providers/solanatracker.js';

// Every fixture (doc-derived or recorded with --record) must parse through its provider schema.
const SCHEMAS = {
  solanatracker: { 'leaderboard-top': stLeaderboardSchema, positions: stPositionsSchema },
  birdeye: { 'gainers-losers': beGainersSchema, 'identity-multiple': beIdentitiesSchema },
} as const;

const dir = (p: string) => new URL(`./fixtures/${p}/`, import.meta.url);

describe('provider fixtures', () => {
  for (const [provider, schemas] of Object.entries(SCHEMAS)) {
    const files = readdirSync(dir(provider)).filter((f) => f.endsWith('.json'));

    it(`${provider}: has a fixture for every schema`, () => {
      expect(files.sort()).toEqual(
        Object.keys(schemas)
          .map((n) => `${n}.json`)
          .sort(),
      );
    });

    for (const file of files) {
      it(`${provider}/${file}: has provenance and parses`, () => {
        const f = JSON.parse(readFileSync(new URL(file, dir(provider)), 'utf8'));
        expect(f._provenance).toMatch(/^(doc-derived|recorded)\b/);
        const schema = schemas[file.replace('.json', '') as keyof typeof schemas];
        expect(() => schema.parse(f.response)).not.toThrow();
      });
    }
  }
});
