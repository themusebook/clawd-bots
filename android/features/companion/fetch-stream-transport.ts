import { CompanionApiError, TransportError } from '@/companion-core/pairing'
import type { StreamTransport } from '@/companion-core/live-session'

/**
 * The app-side stream transport: fetch with a readable body, yielding text
 * chunks as they arrive. The request carries no API timeout — the events
 * endpoint is long-lived by design (see CompanionClient.eventsUrl: the
 * harness keepalive is 25s, so any short deadline would reconnect-loop).
 *
 * If a device build has no readable fetch body, open() fails loudly with a
 * TransportError rather than silently buffering the whole stream — that is
 * the failure the iOS client hit with line-folding readers. Verifying this
 * on real hardware is part of the first on-device build.
 */
export class FetchStreamTransport implements StreamTransport {
  async *open(url: string, headers: Record<string, string>): AsyncIterable<string> {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      throw new CompanionApiError(response.status, undefined)
    }
    const body = response.body as unknown as {
      getReader?: () => {
        read(): Promise<{ done: boolean; value?: Uint8Array }>
      }
    } | null
    if (!body?.getReader) {
      throw new TransportError('This device cannot hold the event stream open (no readable response body).')
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield decoder.decode(value, { stream: true })
    }
  }
}
