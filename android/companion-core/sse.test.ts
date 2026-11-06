import { describe, expect, it } from 'vitest'
import { decodeFrame, SSEParser } from './sse'
import sseHello from './fixtures/sse-hello.json'
import sseFrames from './fixtures/sse-frames.json'
import type { Frame } from './models'

describe('SSEParser', () => {
  it('splits events on blank lines, not on single newlines', () => {
    const parser = new SSEParser()
    // A data line alone is not an event — the blank line terminates it.
    expect(parser.feed('data: {"kind":"hello"}\n')).toEqual([])
    const events = parser.feed('\n')
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].data)).toEqual({ kind: 'hello' })
  })

  it('does not fold consecutive newlines into one separator', () => {
    const parser = new SSEParser()
    const events = parser.feed('data: one\n\ndata: two\n\n')
    expect(events.map((e) => e.data)).toEqual(['one', 'two'])
  })

  it('reassembles an event split across chunks', () => {
    const parser = new SSEParser()
    expect(parser.feed('data: {"kind":"mes')).toEqual([])
    const events = parser.feed('sage"}\n\n')
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].data).kind).toBe('message')
  })

  it('joins multi-line data and skips comments', () => {
    const parser = new SSEParser()
    const events = parser.feed(': heartbeat\ndata: line1\ndata: line2\n\n')
    expect(events[0].data).toBe('line1\nline2')
  })
})

describe('decodeFrame', () => {
  it('decodes the captured hello fixture', () => {
    const frame = decodeFrame(JSON.stringify(sseHello))
    expect(frame).toMatchObject({ kind: 'hello', cursor: 'f5696cc9:3', resumed: false })
  })

  it('decodes every captured stream fixture', () => {
    for (const fixture of sseFrames as Frame[]) {
      const frame = decodeFrame(JSON.stringify(fixture))
      expect(frame?.kind).toBe(fixture.kind)
    }
  })

  it('absorbs unknown frame kinds instead of throwing', () => {
    const frame = decodeFrame('{"kind":"something-new","payload":1}')
    expect(frame?.kind).toBe('something-new')
  })

  it('returns null for malformed payloads', () => {
    expect(decodeFrame('not json')).toBeNull()
    expect(decodeFrame('{"noKind":true}')).toBeNull()
  })
})
