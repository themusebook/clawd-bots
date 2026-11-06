import { describe, expect, it } from 'vitest'

import { CompanionClient } from './client'
import { parseConnection } from './connection'
import type { FetchFn, FetchResponseLike } from './pairing'
import type { RoutineInput } from './models'

interface RecordedCall {
  url: string
  method: string
  body: unknown
  rawBody?: unknown
}

function stubFetch(
  handler: (call: RecordedCall) => Partial<FetchResponseLike> & { jsonBody?: unknown; bytes?: Uint8Array },
) {
  const calls: RecordedCall[] = []
  const fetchFn: FetchFn = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      rawBody: typeof init.body !== 'string' ? init.body : undefined,
    }
    calls.push(call)
    const result = handler(call)
    return {
      status: result.status ?? 200,
      ok: (result.status ?? 200) < 300,
      json: async () => result.jsonBody ?? {},
      text: async () => '',
      headers: {
        get: (name: string) => {
          const headers = (result as { headersMap?: Record<string, string> }).headersMap ?? {}
          const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
          return key ? headers[key] : null
        },
      },
      arrayBuffer: async () => {
        const bytes = result.bytes ?? new TextEncoder().encode(JSON.stringify(result.jsonBody ?? {}))
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    }
  }
  return { client: new CompanionClient(parseConnection('ada.ts.net:8810')!, 'token-1', fetchFn), calls }
}

const daily: RoutineInput = {
  name: 'Morning',
  prompt: 'Say hi',
  botId: 'b1',
  runOn: 'clawd',
  schedule: { type: 'daily', time: '09:00', weekdays: [1, 2] },
  durationMinutes: 30,
}

describe('reading methods', () => {
  it('search unwraps hits and sends q + limit', async () => {
    const { client, calls } = stubFetch(() => ({ jsonBody: { hits: [{ threadId: 't1', messageId: 'm1' }] } }))
    const hits = await client.search('lobster', 10)
    expect(hits).toHaveLength(1)
    expect(calls[0].url).toBe('http://ada.ts.net:8810/api/search?q=lobster&limit=10')
  })

  it('instances and voices unwrap their envelopes', async () => {
    const { client } = stubFetch((call) =>
      call.url.includes('/api/instances')
        ? { jsonBody: { instances: [{ instanceId: 'ghost' }] } }
        : { jsonBody: { voices: [{ id: 'v1' }] } },
    )
    expect((await client.instances())[0].instanceId).toBe('ghost')
    expect((await client.voices())[0].id).toBe('v1')
  })

  it('export parses the server filename and falls back by format', async () => {
    const withName = stubFetch(() => ({
      bytes: new TextEncoder().encode('# chat'),
      headersMap: { 'Content-Disposition': 'attachment; filename="pesto-chat.md"', 'Content-Type': 'text/markdown' },
    }))
    const exported = await withName.client.exportTranscript('t1', 'md')
    expect(exported.filename).toBe('pesto-chat.md')
    expect(exported.contentType).toBe('text/markdown')
    expect(new TextDecoder().decode(exported.data)).toBe('# chat')

    const bare = stubFetch(() => ({ bytes: new Uint8Array([1]) }))
    expect((await bare.client.exportTranscript('t1', 'json')).filename).toBe('transcript.json')
    expect((await bare.client.exportTranscript('t1', 'md')).filename).toBe('transcript.md')
  })

  it('avatar paths are validated before any fetch happens', async () => {
    const { client, calls } = stubFetch(() => ({ bytes: new Uint8Array([9]) }))
    await expect(client.avatarData('/api/attachments/ok-name1.png')).resolves.toEqual(new Uint8Array([9]))
    expect(calls).toHaveLength(1)
    await expect(client.avatarData('/api/attachments/../secret.png')).rejects.toThrow(/avatar address/)
    await expect(client.avatarData('/etc/passwd')).rejects.toThrow(/avatar address/)
    await expect(client.avatarData('/api/attachments/noext')).rejects.toThrow(/avatar address/)
    expect(calls).toHaveLength(1)
  })

  it('message images come back as bytes from the nested route', async () => {
    const { client, calls } = stubFetch(() => ({ bytes: new Uint8Array([1, 2, 3]) }))
    await expect(client.messageImage('t1', 'm9')).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(calls[0].url).toContain('/api/threads/t1/messages/m9/image')
  })
})

describe('doing methods', () => {
  it('updateProfile encodes set/clear avatar semantics and omits absent fields', async () => {
    const { client, calls } = stubFetch(() => ({ jsonBody: { bot: { id: 'b1' } } }))
    await client.updateProfile('b1', { name: 'Pesto II', avatarUrl: { set: '/api/attachments/a.png' } })
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toContain('/api/bots/b1/profile')
    expect(calls[0].body).toEqual({ name: 'Pesto II', avatarUrl: '/api/attachments/a.png' })
    await client.updateProfile('b1', { avatarUrl: { clear: true } })
    expect(calls[1].body).toEqual({ avatarUrl: null })
  })

  it('uploadAvatar guards mime and size, then rebuilds the canonical path', async () => {
    const { client, calls } = stubFetch(() => ({ jsonBody: { path: '/data/files/pic-1.png' } }))
    await expect(client.uploadAvatar(new Uint8Array([1]), 'image/png')).resolves.toBe('/api/attachments/pic-1.png')
    expect(calls[0].rawBody).toBeInstanceOf(Uint8Array)
    await expect(client.uploadAvatar(new Uint8Array([1]), 'image/bmp')).rejects.toThrow(/up to 10 MB/)
    await expect(client.uploadAvatar(new Uint8Array(11 * 1024 * 1024), 'image/png')).rejects.toThrow(/up to 10 MB/)
  })

  it('generateAvatar truncates the prompt to 400 chars', async () => {
    const { client, calls } = stubFetch(() => ({ jsonBody: { bot: { id: 'b1' } } }))
    await client.generateAvatar('b1', 'x'.repeat(500))
    expect((calls[0].body as { prompt: string }).prompt).toHaveLength(400)
  })

  it('routines: body shape, unknown-schedule guard, enable patch, run unwrap, delete', async () => {
    const { client, calls } = stubFetch((call) =>
      call.url.endsWith('/run') ? { jsonBody: { run: { id: 'run1' } } } : { jsonBody: { routine: { id: 'r1' } } },
    )
    await client.createRoutine(daily)
    expect(calls[0].body).toEqual({
      name: 'Morning',
      prompt: 'Say hi',
      botId: 'b1',
      runOn: 'clawd',
      schedule: { type: 'daily', time: '09:00', weekdays: [1, 2] },
      durationMinutes: 30,
    })
    await expect(client.createRoutine({ ...daily, schedule: { type: 'unknown' } })).rejects.toThrow(
      /supported schedule/,
    )
    await client.setRoutineEnabled('r1', false)
    expect(calls[calls.length - 1].body).toEqual({ enabled: false })
    expect((await client.runRoutine('r1')).id).toBe('run1')
    await client.deleteRoutine('r1')
    expect(calls[calls.length - 1].method).toBe('DELETE')
  })

  it('authorizeConnector validates the slug and the returned https URL', async () => {
    const { client, calls } = stubFetch(() => ({ jsonBody: { url: 'https://connect.example.com/auth' } }))
    await expect(client.authorizeConnector('github', '  work ')).resolves.toBe('https://connect.example.com/auth')
    expect(calls[0].body).toEqual({ alias: 'work' })
    await expect(client.authorizeConnector('bad slug!')).rejects.toThrow(/connector name/)
    const insecure = stubFetch(() => ({ jsonBody: { url: 'http://connect.example.com/auth' } }))
    await expect(insecure.client.authorizeConnector('github')).rejects.toThrow(/can't open/)
  })

  it('reactions unwrap the message; branch unwrap the leaf; tasks hit their routes', async () => {
    const { client, calls } = stubFetch((call) => {
      if (call.url.includes('/reactions')) return { jsonBody: { message: { id: 'm1' } } }
      if (call.url.includes('/active-branch')) return { jsonBody: { activeLeafId: 'leaf-9' } }
      return { jsonBody: { bot: { id: 'b1' } } }
    })
    expect((await client.toggleReaction('t1', 'm1', '🦞')).id).toBe('m1')
    expect(await client.setActiveBranch('b1', 'm7')).toBe('leaf-9')
    await client.createTask('b1')
    expect(calls[calls.length - 1].body).toEqual({})
    await client.switchTask('b1', 't2')
    expect(calls[calls.length - 1].url).toContain('/api/bots/b1/tasks/t2')
    await client.deleteTask('b1', 't2')
    expect(calls[calls.length - 1].method).toBe('DELETE')
  })

  it('cloudDesktop unwraps joinUrl and refuses non-https', async () => {
    const { client } = stubFetch(() => ({ jsonBody: { joinUrl: 'https://view.example.com/join/abc' } }))
    expect((await client.cloudDesktop('b1')).url).toBe('https://view.example.com/join/abc')
    const bad = stubFetch(() => ({ jsonBody: { joinUrl: 'http://view.example.com/join/abc' } }))
    await expect(bad.client.cloudDesktop('b1')).rejects.toThrow(/can't open/)
  })

  it('previewVoice truncates text to 500 chars', async () => {
    const { client, calls } = stubFetch(() => ({ bytes: new Uint8Array([7]) }))
    await expect(client.previewVoice('y'.repeat(600), 'v1')).resolves.toEqual(new Uint8Array([7]))
    expect((calls[0].body as { text: string }).text).toHaveLength(500)
  })
})
