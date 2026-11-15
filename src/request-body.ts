/** Read the whole body before entering the shared mutation queue. */
export async function bufferMutation(request: Request): Promise<Request | Response> {
  const maxBytes = 64 * 1024;
  const fail = (status: number, message: string) =>
    Response.json({ ok: false, code: "invalid_request", message }, { status });
  if (Number(request.headers.get("content-length")) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    return fail(413, "请求内容过大");
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("body_timeout")), 5000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return fail(413, "请求内容过大");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
  } catch (error) {
    void reader.cancel().catch(() => {});
    return error instanceof Error && error.message === "body_timeout"
      ? fail(408, "请求接收超时，请重试")
      : fail(400, "无法读取请求内容");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}
