/**
 * SSE parsing — port of iOS `Sources/CompanionCore/SSE.swift` + `Frames.swift`.
 *
 * The iOS reader works on raw bytes for three reasons that apply here too:
 *  1. A "never" timeout that becomes a deadline silently kills the stream —
 *     the client (see `./client.ts`) must use a genuinely long-lived request.
 *  2. Letting the byte stream's owner go out of scope cancels the request —
 *     whoever opens the stream keeps an explicit handle for its whole life.
 *  3. Line iterators that fold consecutive newlines never report the blank
 *     line that terminates an SSE event — zero frames, no error. So events
 *     are split on blank lines here, by hand.
 *
 * This module is transport-free: feed it text chunks, get parsed frames.
 */

import type { Frame } from './models'

export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

/** Incremental SSE parser. Not a line folder: an event ends at a blank line. */
export class SSEParser {
  private buffer = ''

  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk
    const events: SSEEvent[] = []
    // Normalise CRLF so a \r\n\r\n boundary is a blank line too.
    this.buffer = this.buffer.replace(/\r\n/g, '\n')
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const parsed = parseEventBlock(block)
      if (parsed) events.push(parsed)
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }

  /** Discard any partial event (call when the stream is torn down on purpose). */
  reset() {
    this.buffer = ''
  }
}

function parseEventBlock(block: string): SSEEvent | null {
  let event: string | undefined
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue // comment / heartbeat
    const colon = line.indexOf(':')
    const field = colon >= 0 ? line.slice(0, colon) : line
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /, '') : ''
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }
  if (dataLines.length === 0 && !event) return null
  return { event, data: dataLines.join('\n'), id }
}

/**
 * Decode one event's data payload into a Frame. Unknown kinds are absorbed
 * and returned as-is (the fold decides what to do with them); malformed JSON
 * returns null instead of throwing — a bad frame must not kill the stream.
 */
export function decodeFrame(data: string): Frame | null {
  try {
    const parsed = JSON.parse(data) as Frame
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.kind !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
