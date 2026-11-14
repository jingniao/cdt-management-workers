import type { Env } from "./env";
import { execute, queryOne } from "./db";

const WINDOW_SECONDS = 300;
const MAX_ATTEMPTS = 8;

/** Reserve before password verification, not after, so parallel calls count. */
export async function reserveAuthAttempt(env: Env, key: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  await execute(env.DB, "DELETE FROM auth_rate_limits WHERE window_start < ?", [now - WINDOW_SECONDS * 2]);
  const result = await queryOne<{ attempts: number }>(env.DB,
    "INSERT INTO auth_rate_limits(key,window_start,attempts) VALUES(?,?,1) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "attempts=CASE WHEN auth_rate_limits.window_start <= ? THEN 1 ELSE MIN(auth_rate_limits.attempts+1,9) END, " +
    "window_start=CASE WHEN auth_rate_limits.window_start <= ? THEN excluded.window_start ELSE auth_rate_limits.window_start END " +
    "RETURNING attempts",
    [key, now, now - WINDOW_SECONDS, now - WINDOW_SECONDS],
  );
  if (!result) throw new Error("Rate limit reservation failed");
  return result.attempts <= MAX_ATTEMPTS;
}

export async function resetAuthAttempts(env: Env, key: string): Promise<void> {
  await execute(env.DB, "DELETE FROM auth_rate_limits WHERE key=?", [key]);
}
