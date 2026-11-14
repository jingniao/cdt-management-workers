import type { Env } from "./env";
import { app } from "./api";
import { runReconcile } from "./scheduler";

/**
 * One named Durable Object owns all control-plane mutations for this deployment.
 * A promise chain serializes the entire read/decide/cloud-write operation,
 * including awaits. DO fetch handlers alone are not mutually exclusive.
 * Do not replace this with blockConcurrencyWhile: cloud operations may exceed
 * that API's 30-second initialization timeout.
 */
export class ControlPlane {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(_state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const scheduled = path === "/__scheduled" && request.method === "POST";
    if (!scheduled && path !== "/api" && !path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    if (!scheduled && (request.method === "GET" || request.method === "HEAD")) {
      return app.fetch(request, this.env);
    }
    // Cron ticks do not build a backlog while a manual operation is in flight.
    if (scheduled && this.pending > 0) return new Response(null, { status: 202 });
    if (this.pending >= 32) {
      return Response.json({ ok: false, code: "busy", message: "操作较多，请稍后重试" }, { status: 503 });
    }
    this.pending++;
    const result = this.tail.then(async () => {
      try {
        if (scheduled) {
          await runReconcile(this.env);
          return Response.json({ ok: true });
        }
        return await app.fetch(request, this.env);
      } finally {
        this.pending--;
      }
    });
    // A failed call must not poison the queue for all later operations.
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
