import { EventEmitter } from 'node:events'
import type { request as httpsRequest } from 'node:https'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinnedHttpsTransport } from '../src/page-fetch.js'

interface HarnessOptions {
  readonly statusCode?: number
  readonly headers?: Record<string, string>
  readonly chunks?: readonly Uint8Array[]
  readonly emitResponse?: boolean
  readonly endResponse?: boolean
}

type FakeResponse = EventEmitter & {
  statusCode: number
  headers: Record<string, string>
  destroyed: boolean
  destroy(error?: Error): void
  setTimeout(ms: number, callback: () => void): void
}

function requestHarness(input: HarnessOptions = {}) {
  const response = new EventEmitter() as FakeResponse
  response.statusCode = input.statusCode ?? 200
  response.headers = input.headers ?? { 'content-type': 'text/plain' }
  response.destroyed = false
  let idleCallback: (() => void) | undefined
  response.destroy = vi.fn((error?: Error) => {
    response.destroyed = true
    if (error !== undefined) response.emit('error', error)
  })
  response.setTimeout = vi.fn((_ms: number, callback: () => void) => { idleCallback = callback })

  const request = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    destroy(error?: Error): void
    end(): void
  }
  request.destroyed = false
  request.destroy = vi.fn((error?: Error) => {
    request.destroyed = true
    if (error !== undefined) request.emit('error', error)
  })
  let callback: ((response: FakeResponse) => void) | undefined
  let capturedOptions: Record<string, unknown> | undefined
  request.end = vi.fn(() => {
    if (input.emitResponse === false || callback === undefined) return
    callback(response)
    for (const chunk of input.chunks ?? []) {
      if (response.destroyed) break
      response.emit('data', Buffer.from(chunk))
    }
    if (input.endResponse !== false && !response.destroyed) response.emit('end')
  })
  const implementation = vi.fn((_url: unknown, options: Record<string, unknown>, listener: typeof callback) => {
    capturedOptions = options
    callback = listener
    return request
  }) as unknown as typeof httpsRequest
  return {
    transport: new PinnedHttpsTransport(implementation),
    request,
    response,
    options: () => capturedOptions,
    triggerIdle: () => idleCallback?.(),
  }
}

const limits = { maxBytes: 16, timeoutMs: 1_000, bodyIdleMs: 100 }
const address = { address: '93.184.216.34', family: 4 as const }

afterEach(() => vi.useRealTimers())

describe('pinned HTTPS transport resource bounds', () => {
  it.each([
    [202, { 'content-type': 'text/html', 'set-cookie': 'ignored=1' }, 'resolve'],
    [302, { location: '/next' }, 'resolve'],
    [404, { 'content-type': 'text/plain' }, 'reject'],
    [200, { 'content-type': 'application/pdf' }, 'reject'],
    [200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }, 'reject'],
    [200, { 'content-type': 'text/plain', 'content-disposition': 'attachment' }, 'reject'],
    [200, { 'content-type': 'text/plain', 'content-length': '999' }, 'reject'],
  ] as const)('destroys request and response on early status/content exit %#', async (statusCode, headers, outcome) => {
    const harness = requestHarness({ statusCode, headers })
    const pending = harness.transport.request(new URL('https://example.com/start'), address, undefined, limits)
    if (outcome === 'resolve') await expect(pending).resolves.toMatchObject({ statusCode })
    else await expect(pending).rejects.toBeDefined()
    expect(harness.response.destroy).toHaveBeenCalledOnce()
    expect(harness.request.destroy).toHaveBeenCalledOnce()
    expect(harness.response.destroyed).toBe(true)
    expect(harness.request.destroyed).toBe(true)
  })

  it('uses a fixed credential-free request profile for official Cellar representations', async () => {
    const harness = requestHarness({ headers: { 'content-type': 'application/xhtml+xml' } })
    await expect(harness.transport.request(
      new URL('https://publications.europa.eu/resource/celex/32024R1689'),
      address,
      undefined,
      { ...limits, maxBytes: 2 * 1024 * 1024 },
    )).resolves.toMatchObject({ statusCode: 200 })
    const headers = harness.options()?.headers as Record<string, string>
    expect(headers).toMatchObject({
      accept: 'application/xhtml+xml',
      'accept-language': 'eng',
      'accept-max-cs-size': '2097152',
      'accept-encoding': 'identity',
    })
    expect(headers).not.toHaveProperty('cookie')
    expect(headers).not.toHaveProperty('authorization')
    expect(headers).not.toHaveProperty('referer')
  })

  it('pins lookup to the validated address and enforces the streamed byte limit', async () => {
    const harness = requestHarness({ chunks: [new Uint8Array(17)] })
    const pending = harness.transport.request(new URL('https://example.com/large'), address, undefined, limits)
    await expect(pending).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_SIZE_ERROR' })
    const lookup = harness.options()?.lookup as (
      hostname: string,
      options: { all: true },
      callback: (error: null, values: Array<{ address: string; family: number }>) => void,
    ) => void
    const callback = vi.fn()
    lookup('attacker-controlled.example', { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [address])
    expect(harness.request.destroyed).toBe(true)
  })

  it('destroys a binary response and an idle response', async () => {
    const binary = requestHarness({ chunks: [new Uint8Array([65, 0, 66])] })
    await expect(binary.transport.request(new URL('https://example.com/binary'), address, undefined, limits))
      .rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR' })
    expect(binary.request.destroyed).toBe(true)

    const idle = requestHarness({ endResponse: false })
    const pending = idle.transport.request(new URL('https://example.com/idle'), address, undefined, limits)
    idle.triggerIdle()
    await expect(pending).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_TIMEOUT' })
    expect(idle.response.destroyed).toBe(true)
    expect(idle.request.destroyed).toBe(true)
  })

  it('destroys a request that never returns response headers at the overall deadline', async () => {
    vi.useFakeTimers()
    const harness = requestHarness({ emitResponse: false })
    const pending = harness.transport.request(
      new URL('https://example.com/timeout'),
      address,
      undefined,
      { ...limits, timeoutMs: 10 },
    )
    const rejection = expect(pending).rejects.toMatchObject({ code: 'VERIFIED_RESEARCH_FETCH_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await rejection
    expect(harness.request.destroyed).toBe(true)
  })
})
