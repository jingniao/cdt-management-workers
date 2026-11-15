/** Only poll visible pages. Returning to the panel refreshes immediately. */
export function startPolling(
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
  refresh: () => Promise<unknown>,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let busy = false
  let stopped = false
  const tick = async () => {
    if (stopped || busy || page.visibilityState !== 'visible') return
    busy = true
    try { await refresh() } catch { /* The caller presents request errors. */ }
    finally { busy = false }
  }
  const schedule = () => {
    clearInterval(timer)
    timer = undefined
    if (!stopped && page.visibilityState === 'visible') timer = setInterval(() => void tick(), 60_000)
  }
  const onVisibility = () => { schedule(); void tick() }
  page.addEventListener('visibilitychange', onVisibility)
  schedule()
  return () => {
    stopped = true
    clearInterval(timer)
    page.removeEventListener('visibilitychange', onVisibility)
  }
}
