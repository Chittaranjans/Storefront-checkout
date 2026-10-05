import type { Config } from './types';

export const DEFAULT_CONFIG: Config = { n: 5, x: 10 };

/**
 * Reads coupon configuration from the environment.
 *
 *   COUPON_EVERY_N_ORDERS  (n) - every nth order unlocks one coupon. Positive integer.
 *   COUPON_PERCENT         (x) - the coupon's discount percent. Integer in [1, 100].
 *
 * Invalid values fail fast at startup rather than silently producing a
 * misconfigured reward system.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const n = parseIntegerEnv(env, 'COUPON_EVERY_N_ORDERS', DEFAULT_CONFIG.n, 1, Number.MAX_SAFE_INTEGER);
  const x = parseIntegerEnv(env, 'COUPON_PERCENT', DEFAULT_CONFIG.x, 1, 100);
  return { n, x };
}

function parseIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}
