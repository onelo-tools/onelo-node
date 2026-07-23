/**
 * Minimal Server-Sent-Events frame parser. Node has no `EventSource`, so we read
 * the `fetch` response body stream and parse frames ourselves — the equivalent
 * of Python's `httpx_sse`.
 *
 * Feed decoded text chunks via `push()`; it returns any COMPLETE events. Handles
 * chunk boundaries splitting a frame (partial line stays buffered). Comment lines
 * (`:` heartbeats) and `retry:` lines are consumed but not surfaced as events —
 * the consumer tracks liveness from raw bytes read, not from parsed comments.
 */
export interface SseEvent {
  event: string
  data: string
}

export class SseParser {
  private buffer = ''
  private eventType = ''
  private dataLines: string[] = []

  /** Feed a text chunk; return any events completed by it. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []

    // Process complete lines; keep the trailing partial line buffered.
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

      if (line === '') {
        // Blank line dispatches the accumulated event.
        if (this.dataLines.length > 0 || this.eventType !== '') {
          events.push({ event: this.eventType, data: this.dataLines.join('\n') })
        }
        this.eventType = ''
        this.dataLines = []
        continue
      }

      if (line.startsWith(':')) {
        // Comment / heartbeat — ignored (liveness tracked by bytes read).
        continue
      }

      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'event') this.eventType = value
      else if (field === 'data') this.dataLines.push(value)
      // 'id', 'retry', and unknown fields are ignored.
    }

    return events
  }
}
