import { type Config, loadConfig } from '@scb/shared';
import { paths } from './paths';

/** rules.yaml, or null when it is unreadable (callers fall back to raw codes / no budget). */
export const readRules = (): Config | null => {
  try {
    return loadConfig(paths.rules);
  } catch {
    return null;
  }
};
