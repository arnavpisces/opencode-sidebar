export const SERVER_REQUEST_TIMEOUT_MS = 10_000
export const SERVER_HEALTH_TIMEOUT_MS = 2_000

// The event stream stays open for the lifetime of the sidebar. Only finite
// API requests should expire, including reads of their response bodies.
export function createServerFetch(timeoutMs = SERVER_REQUEST_TIMEOUT_MS, fetchRequest = globalThis.fetch) {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const route = new URL(request.url).pathname
    const streaming = route === "/global/event"
    const timeout = streaming ? undefined : AbortSignal.timeout(timeoutMs)
    const signal = timeout ? AbortSignal.any([request.signal, timeout]) : request.signal
    try {
      const response = await fetchRequest(new Request(request, { signal }))
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`OpenCode ${route} failed (HTTP ${response.status})`)
      }
      // Buffer finite responses here so body stalls receive the same deadline
      // and useful error message as stalls before the response headers.
      if (streaming) return response
      const body = response.body ? await response.arrayBuffer() : null
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (cause) {
      if (timeout?.aborted && !request.signal.aborted) {
        throw new Error(`OpenCode ${route} timed out after ${timeoutMs / 1000}s; retrying sync`, { cause })
      }
      throw cause
    }
  }
}
