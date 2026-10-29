import { z } from 'zod';

export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_THE_RISK';

const optionalKey = z
  .string()
  .optional()
  .transform((v) => v || undefined);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATA_DIR: z.string().min(1).default('./data'),
  RULES_PATH: z.string().min(1).default('./config/rules.yaml'),
  HELIUS_API_KEY: optionalKey,
  SOLANATRACKER_API_KEY: optionalKey,
  BIRDEYE_API_KEY: optionalKey,
  JUPITER_API_KEY: optionalKey, // M3, optional: keyless works at 0.5 rps
  LIVE_ENABLED: z.string().default('false'),
  LIVE_CONFIRM: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export const parseEnv = (source: Record<string, string | undefined> = process.env): Env =>
  envSchema.parse(source);

/** Exact-match only: "1", "TRUE", or a near-miss phrase must never arm live trading. */
export const isLiveArmed = (env: Env) =>
  env.LIVE_ENABLED === 'true' && env.LIVE_CONFIRM === LIVE_CONFIRM_PHRASE;
