/**
 * Entrypoint — TypeScript port of `app/main.py` (app assembly + static
 * hosting) for Cloudflare Workers.
 *
 * - `fetch`: `/api/*` goes through the single ControlPlane Durable Object;
 *   it dispatches to Hono after serializing mutations. Everything else
 *   falls back to `env.ASSETS` (the React frontend built into `web/dist`
 *   via wrangler `[assets]`, SPA fallback handled by wrangler config).
 *   If no assets binding is configured, non-API paths return the same
 *   503 "frontend not built" hint the Python placeholder returned.
 * - `scheduled`: requests a serialized reconcile round from ControlPlane. There is
 *   no webhook path in this worker, so `scheduled` never runs anything
 *   else.
 *
 * NOTE: there is no startup hook in Workers (no equivalent of FastAPI
 * `on_event("startup")`). The DNS registry sync / legacy adoption that
 * Python ran at boot (`dns.sync_registry` + `dns.adopt_legacy`) is not
 * run here; it also runs on settings save (`POST /api/v1/settings` when
 * `ddns_records` changes) and on DNS bind, which covers the same
 * transitions lazily.
 */

import type { Env } from "./env";
export { ControlPlane } from "./control-plane";

function coordinator(env: Env): DurableObjectStub {
  if (!env.CONTROL_PLANE) throw new Error("CONTROL_PLANE binding is required");
  return env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName("deployment-control-plane"));
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (!env.CONTROL_PLANE) {
        return Response.json({ ok: false, code: "not_configured", message: "控制服务未配置，请更新完整部署配置" }, { status: 503 });
      }
      return coordinator(env).fetch(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response(
      JSON.stringify({
        message: "前端资源未构建。开发时请先 npm run build，或直接用 Vite dev server。",
        hint: "cd web && npm install && npm run build",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil((async () => {
      const response = await coordinator(env).fetch("https://control.internal/__scheduled", { method: "POST" });
      if (!response.ok) throw new Error(`Reconcile coordinator returned HTTP ${response.status}`);
    })());
  },
};
