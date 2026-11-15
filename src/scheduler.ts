/** Five-minute Cron; on-demand operations keep their immediate execution path.
 * One settings snapshot is shared by the round. Daily reports use the collected
 * state, and billing has an independent six-hour cache.
 */
import type { Env } from "./env";
import * as repo from "./repo";
import * as dns from "./dns";
import * as billing from "./billing";
import { dailyReport, reconcileAll } from "./shift";
import { resolveSettings } from "./settings";

const PRUNE_INTERVAL_SECONDS = 3600;
const LAST_PRUNE_FLAG = "scheduler_last_prune";

function tzParts(tzName: string, at: Date): { hour: number; minute: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value;
  let hour = Number(parts["hour"]);
  if (hour === 24) hour = 0;
  return {
    hour,
    minute: Number(parts["minute"]),
    dateStr: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
  };
}

async function maybeDailyReport(env: Env, config: Record<string, string>): Promise<void> {
  if (config["daily_report_enabled"] !== "1") return;
  if (config.initialized !== "1") return;

  const tzName = config["timezone"] || "Asia/Shanghai";
  const now = new Date();
  const { hour, minute, dateStr } = tzParts(tzName, now);
  const target = config["daily_report_time"] || "23:58";
  const [targetHour, targetMinute] = target.split(":").map((v) => Number(v) || 0);
  // Select the most recent due daily slot. A 23:58 report is delivered at
  // 00:00, keyed to the previous date, instead of being missed every day.
  const pastTarget = hour * 60 + minute >= (targetHour ?? 23) * 60 + (targetMinute ?? 58);
  const previousDate = new Date(Date.parse(`${dateStr}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  await dailyReport(env, config, false, pastTarget ? dateStr : previousDate);
}

export async function runReconcile(env: Env): Promise<void> {
  const config = await repo.getSettings(env);
  try {
    await reconcileAll(env, config);
  } catch (e) {
    console.error("reconcile round failed", e);
  }

  try {
    await maybeDailyReport(env, config);
  } catch (e) {
    console.error("daily report check failed", e);
  }

  // DNS: only issues real requests when a target is running but its
  // resolution disagrees; steady state costs nothing.
  try {
    await dns.reconcile(env, config);
  } catch (e) {
    console.error("DNS reconcile failed", e);
  }

  // Billing is slow data; refreshDue() applies its own six-hour TTL and
  // only calls out when a snapshot is actually due.
  try {
    await billing.refreshDue(env, undefined, config);
  } catch (e) {
    console.error("billing refresh failed", e);
  }

  // Hourly prune of old events. The timestamp is a D1 flag (see header):
  // flags are presence-only, so `flagAge` reads the `created_at` of the
  // last prune and clear+set refreshes it.
  try {
    const age = await repo.flagAge(env, LAST_PRUNE_FLAG);
    if (age < 0 || age > PRUNE_INTERVAL_SECONDS) {
      await repo.pruneEvents(env, resolveSettings(env).eventRetainDays);
      await repo.clearFlag(env, LAST_PRUNE_FLAG);
      await repo.setFlag(env, LAST_PRUNE_FLAG);
    }
  } catch (e) {
    console.error("prune events failed", e);
  }
}
