import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { sourceMatchesDomain } from './domains.js'
import { sanitizeSourceUrl } from './provider.js'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_BODY_IDLE_MS = 2_000
const DEFAULT_DNS_TIMEOUT_MS = 1_500

export class EvidenceFetchError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EvidenceFetchError'
  }
}

export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface TransportResponse {
  readonly statusCode: number
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly bytes: Uint8Array
}

export interface EvidenceTransport {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]>
  request(
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal | undefined,
    limits: { readonly maxBytes: number; readonly timeoutMs: number; readonly bodyIdleMs: number },
  ): Promise<TransportResponse>
}

export interface FetchEvidenceOptions {
  readonly maxBytes?: number
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly bodyIdleMs?: number
  readonly transport?: EvidenceTransport
}

export interface FetchedPage {
  readonly url: string
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'application/json' | 'text/plain' | 'text/markdown'
  readonly body: string
  readonly retrievedAt: string
  /** Original official URL when a narrowly scoped alternate representation was used. */
  readonly derivedFrom?: string
}

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedIpv4.addSubnet(network, prefix, 'ipv4')
const blockedIpv6 = new BlockList()
const allocatedGlobalIpv6 = new BlockList()
allocatedGlobalIpv6.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) blockedIpv6.addSubnet(network, prefix, 'ipv6')

export function isPublicAddress(value: ResolvedAddress): boolean {
  const parsedFamily = isIP(value.address)
  if (parsedFamily !== value.family) return false
  return value.family === 4
    ? !blockedIpv4.check(value.address, 'ipv4')
    : allocatedGlobalIpv6.check(value.address, 'ipv6') && !blockedIpv6.check(value.address, 'ipv6')
}

function abortError(signal?: AbortSignal, cause?: unknown): EvidenceFetchError {
  if (signal?.reason instanceof EvidenceFetchError) return signal.reason
  return new EvidenceFetchError('evidence fetch aborted', 'VERIFIED_RESEARCH_FETCH_ABORTED', {
    cause: signal?.reason ?? cause,
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal)
}

async function boundedWait<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  timeoutError = new EvidenceFetchError('evidence DNS resolution timed out', 'VERIFIED_RESEARCH_FETCH_DNS_ERROR'),
): Promise<T> {
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      callback()
    }
    const timer = setTimeout(() => finish(() => reject(timeoutError)), timeoutMs)
    timer.unref?.()
    const aborted = (): void => finish(() => reject(abortError(signal)))
    signal?.addEventListener('abort', aborted, { once: true })
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all === true) {
      callback(null, [{ address: address.address, family: address.family }])
      return
    }
    callback(null, address.address, address.family)
  }
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : value?.join(', ')
}

function mediaTypeOf(headers: Readonly<Record<string, string | readonly string[] | undefined>>): FetchedPage['mediaType'] {
  const raw = headerValue(headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (raw === 'text/html' || raw === 'application/xhtml+xml' || raw === 'application/json'
    || raw === 'text/plain' || raw === 'text/markdown') return raw
  throw new EvidenceFetchError('evidence response used an unsupported content type', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR')
}

type SupportedTextEncoding = 'utf-8' | 'windows-1252'

const WINDOWS_1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const

/** Deterministic WHATWG-compatible mapping for Node 22 builds with incomplete ICU data. */
function decodeWindows1252(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1').replace(/[\u0080-\u009f]/gu, character =>
    String.fromCodePoint(WINDOWS_1252_C1[character.charCodeAt(0) - 0x80]!))
}

function textEncodingOf(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): SupportedTextEncoding {
  const raw = headerValue(headers, 'content-type')
  if (raw === undefined) return 'utf-8'
  let foundCharset = false
  let encoding: SupportedTextEncoding = 'utf-8'
  for (const parameter of raw.split(';').slice(1)) {
    const equals = parameter.indexOf('=')
    const name = (equals === -1 ? parameter : parameter.slice(0, equals)).trim().toLowerCase()
    if (name !== 'charset') continue
    if (foundCharset || equals === -1) {
      throw new EvidenceFetchError('evidence response declared an invalid charset', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR')
    }
    foundCharset = true
    let label = parameter.slice(equals + 1).trim()
    if (label.startsWith('"') || label.endsWith('"')) {
      if (label.length < 2 || !label.startsWith('"') || !label.endsWith('"')) {
        throw new EvidenceFetchError('evidence response declared an invalid charset', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR')
      }
      label = label.slice(1, -1).trim()
    }
    switch (label.toLowerCase()) {
      case 'utf-8':
      case 'utf8':
        encoding = 'utf-8'
        break
      case 'iso-8859-1':
      case 'windows-1252':
        // WHATWG treats ISO-8859-1 web content as Windows-1252. Using the
        // canonical decoder preserves Cisco advisory punctuation in U+0080-009F.
        encoding = 'windows-1252'
        break
      default:
        throw new EvidenceFetchError('evidence response declared an unsupported charset', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR')
    }
  }
  return encoding
}

function requestHeaders(url: URL): Readonly<Record<string, string>> {
  if (url.hostname === 'publications.europa.eu' && url.pathname.startsWith('/resource/')) {
    return {
      accept: 'application/xhtml+xml',
      'accept-language': 'eng',
      'accept-max-cs-size': String(DEFAULT_MAX_BYTES),
      'accept-encoding': 'identity',
      'user-agent': 'dsh-plugin-verified-search/0.3.0-experiment.0',
    }
  }
  return {
    accept: 'text/html, application/xhtml+xml;q=0.95, application/json;q=0.9, text/plain;q=0.85, text/markdown;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-plugin-verified-search/0.3.0-experiment.0',
  }
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | readonly string[] | undefined> {
  const normalized: Record<string, string | readonly string[] | undefined> = {}
  for (const [name, value] of Object.entries(headers)) normalized[name.toLowerCase()] = value
  return normalized
}

export class PinnedHttpsTransport implements EvidenceTransport {
  constructor(private readonly requestImpl: typeof httpsRequest = httpsRequest) {}

  async resolve(hostname: string, signal?: AbortSignal): Promise<readonly ResolvedAddress[]> {
    let values: Array<{ address: string; family: number }>
    try {
      values = await boundedWait(
        dnsLookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>,
        DEFAULT_DNS_TIMEOUT_MS,
        signal,
      )
    } catch (error: unknown) {
      if (error instanceof EvidenceFetchError) throw error
      throw new EvidenceFetchError('evidence DNS resolution failed', 'VERIFIED_RESEARCH_FETCH_DNS_ERROR', { cause: error })
    }
    return values.map((value) => {
      if (value.family !== 4 && value.family !== 6) {
        throw new EvidenceFetchError('evidence DNS returned an unsupported address family', 'VERIFIED_RESEARCH_FETCH_DNS_ERROR')
      }
      return { address: value.address, family: value.family }
    })
  }

  async request(
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal | undefined,
    limits: { readonly maxBytes: number; readonly timeoutMs: number; readonly bodyIdleMs: number },
  ): Promise<TransportResponse> {
    throwIfAborted(signal)
    return await new Promise<TransportResponse>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(overallTimer)
        callback()
      }
      const fail = (error: unknown): void => {
        if (!request.destroyed) request.destroy()
        finish(() => reject(
          signal?.aborted === true
            ? abortError(signal, error)
            : error instanceof EvidenceFetchError
              ? error
              : new EvidenceFetchError('evidence HTTPS request failed', 'VERIFIED_RESEARCH_FETCH_NETWORK_ERROR', { cause: error }),
        ))
      }
      const overallTimer = setTimeout(() => request.destroy(new EvidenceFetchError(
        'evidence HTTPS request timed out',
        'VERIFIED_RESEARCH_FETCH_TIMEOUT',
      )), limits.timeoutMs)
      overallTimer.unref?.()
      const request = this.requestImpl(url, {
        method: 'GET',
        agent: false,
        signal,
        lookup: pinnedLookup(address),
        headers: requestHeaders(url),
      }, response => {
        const statusCode = response.statusCode ?? 0
        const headers = normalizeHeaders(response.headers)
        if ([202, 301, 302, 303, 307, 308].includes(statusCode)) {
          response.destroy()
          request.destroy()
          finish(() => resolve({ statusCode, headers, bytes: new Uint8Array() }))
          return
        }
        if (statusCode !== 200) {
          response.destroy()
          fail(new EvidenceFetchError(`evidence endpoint returned HTTP ${statusCode}`, 'VERIFIED_RESEARCH_FETCH_HTTP_ERROR'))
          return
        }
        const encoding = headerValue(headers, 'content-encoding')?.trim().toLowerCase()
        if (encoding !== undefined && encoding !== 'identity') {
          response.destroy()
          fail(new EvidenceFetchError('evidence response used unsupported content encoding', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR'))
          return
        }
        const disposition = headerValue(headers, 'content-disposition')?.toLowerCase()
        if (disposition?.includes('attachment') === true) {
          response.destroy()
          fail(new EvidenceFetchError('evidence response was an attachment', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR'))
          return
        }
        try {
          mediaTypeOf(headers)
        } catch (error: unknown) {
          response.destroy()
          fail(error)
          return
        }
        const declared = Number(headerValue(headers, 'content-length'))
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          response.destroy()
          fail(new EvidenceFetchError('evidence response exceeded the byte limit', 'VERIFIED_RESEARCH_FETCH_SIZE_ERROR'))
          return
        }
        const chunks: Uint8Array[] = []
        let size = 0
        response.setTimeout(limits.bodyIdleMs, () => response.destroy(new EvidenceFetchError(
          'evidence response body stalled',
          'VERIFIED_RESEARCH_FETCH_TIMEOUT',
        )))
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > limits.maxBytes) {
            response.destroy(new EvidenceFetchError('evidence response exceeded the byte limit', 'VERIFIED_RESEARCH_FETCH_SIZE_ERROR'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', fail)
        response.on('end', () => {
          const body = Buffer.concat(chunks, size)
          if (body.subarray(0, Math.min(body.length, 8192)).includes(0)) {
            fail(new EvidenceFetchError('evidence response appeared to be binary', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR'))
            return
          }
          finish(() => resolve({ statusCode, headers, bytes: body }))
        })
      })
      request.on('error', fail)
      request.end()
    })
  }
}

const defaultTransport = new PinnedHttpsTransport()

function validatedEvidenceUrl(value: string, allowedDomains: readonly string[] | undefined): URL {
  let sanitized: string
  try {
    sanitized = sanitizeSourceUrl(value)
  } catch (error: unknown) {
    throw new EvidenceFetchError('evidence URL was invalid or unsafe', 'VERIFIED_RESEARCH_FETCH_URL_ERROR', { cause: error })
  }
  const url = new URL(sanitized)
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')
    || url.username.length > 0 || url.password.length > 0
    || url.hostname.startsWith('[') || url.hostname.endsWith(']') || isIP(url.hostname) !== 0) {
    throw new EvidenceFetchError(
      'evidence URL must use HTTPS on port 443 with a DNS hostname and no credentials',
      'VERIFIED_RESEARCH_FETCH_URL_ERROR',
    )
  }
  if (allowedDomains !== undefined && !allowedDomains.some(domain => sourceMatchesDomain(url.toString(), domain))) {
    throw new EvidenceFetchError('evidence URL did not match the lane allowlist', 'VERIFIED_RESEARCH_FETCH_URL_ERROR')
  }
  url.hash = ''
  return url
}

/** Canonicalize one evidence URL, remove sensitive/tracking material, and enforce its allowlist. */
export function normalizeEvidenceUrl(value: string, allowedDomains: readonly string[] | undefined): string {
  return validatedEvidenceUrl(value, allowedDomains).toString()
}

function cellarAlternateFor(
  source: URL,
  allowedDomains: readonly string[] | undefined,
): URL | undefined {
  if (source.hostname !== 'eur-lex.europa.eu' || source.pathname !== '/legal-content/EN/TXT/') return undefined
  const uriValues = source.searchParams.getAll('uri')
  if (uriValues.length !== 1 || [...source.searchParams.keys()].some(name => name !== 'uri')) return undefined
  const raw = uriValues[0]
  const match = /^CELEX:([0-9A-Z]{1,32})$/u.exec(raw ?? '')
  if (match === null || allowedDomains === undefined
    || !allowedDomains.includes('eur-lex.europa.eu')
    || !allowedDomains.includes('publications.europa.eu')) return undefined
  const alternate = new URL(`https://publications.europa.eu/resource/celex/${match[1]}`)
  return alternate
}

const CELLAR_DOCUMENT_PATH = /^\/resource\/cellar\/[A-Za-z0-9._~-]+\/DOC_[1-9][0-9]*$/u

function cellarDocumentRedirect(current: URL, expectedWorkUrl: string, location: string): URL | undefined {
  let candidate: URL
  try {
    candidate = new URL(location, current)
  } catch {
    return undefined
  }
  if (current.toString() !== expectedWorkUrl
    || current.hostname !== 'publications.europa.eu'
    || (candidate.protocol !== 'http:' && candidate.protocol !== 'https:')
    || candidate.hostname !== 'publications.europa.eu'
    || candidate.port !== ''
    || candidate.username.length > 0
    || candidate.password.length > 0
    || candidate.search !== ''
    || candidate.hash !== ''
    || !CELLAR_DOCUMENT_PATH.test(candidate.pathname)) return undefined
  if (candidate.protocol === 'http:') candidate.protocol = 'https:'
  return candidate
}

/** Fetch one public HTTPS page through a DNS-pinned transport, enforcing an allowlist when supplied. */
export async function fetchEvidencePage(
  sourceUrl: string,
  allowedDomains: readonly string[] | undefined,
  signal?: AbortSignal,
  input: FetchEvidenceOptions = {},
): Promise<FetchedPage> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const bodyIdleMs = input.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
  if (!Number.isInteger(maxBytes) || maxBytes < 1
    || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5
    || !Number.isInteger(timeoutMs) || timeoutMs < 1
    || !Number.isInteger(bodyIdleMs) || bodyIdleMs < 1) {
    throw new EvidenceFetchError('invalid evidence fetch limits', 'VERIFIED_RESEARCH_FETCH_CONFIG_ERROR')
  }
  const transport = input.transport ?? defaultTransport
  throwIfAborted(signal)
  const deadline = Date.now() + timeoutMs
  const deadlineError = new EvidenceFetchError('evidence fetch exceeded its overall deadline', 'VERIFIED_RESEARCH_FETCH_TIMEOUT')
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), timeoutMs)
  deadlineTimer.unref?.()
  const operationSignal = signal === undefined
    ? deadlineController.signal
    : AbortSignal.any([signal, deadlineController.signal])
  const remaining = (): number => {
    const value = deadline - Date.now()
    if (value <= 0) throw deadlineError
    return Math.max(1, value)
  }
  try {
    let current = validatedEvidenceUrl(sourceUrl, allowedDomains)
    const original = current.toString()
    let origin = current.origin
    let cellarState: 'normal' | 'resolver' | 'document' = 'normal'
    let cellarWorkUrl: string | undefined
    let cellarDocumentUrl: string | undefined
    const seen = new Set<string>()
    for (let redirects = 0; ; redirects++) {
      throwIfAborted(operationSignal)
      if (seen.has(current.href)) {
        throw new EvidenceFetchError('evidence redirect loop detected', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
      }
      seen.add(current.href)
      const resolveBudget = remaining()
      const addresses = await boundedWait(
        transport.resolve(current.hostname, operationSignal),
        resolveBudget,
        operationSignal,
        deadlineError,
      )
      if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address))) {
        throw new EvidenceFetchError('evidence hostname did not resolve exclusively to public IP addresses', 'VERIFIED_RESEARCH_FETCH_SSRF_BLOCKED')
      }
      const requestBudget = remaining()
      const response = await boundedWait(
        transport.request(current, addresses[0]!, operationSignal, {
          maxBytes,
          timeoutMs: requestBudget,
          bodyIdleMs: Math.min(bodyIdleMs, requestBudget),
        }),
        requestBudget,
        operationSignal,
        deadlineError,
      )
      if (response.statusCode === 202) {
        if (cellarState !== 'normal') {
          throw new EvidenceFetchError('official evidence representation remained pending', 'VERIFIED_RESEARCH_FETCH_PENDING')
        }
        if (redirects >= maxRedirects) {
          throw new EvidenceFetchError('evidence redirect limit exceeded', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        if (redirects !== 0 || current.toString() !== original) {
          throw new EvidenceFetchError('EUR-Lex alternate requires the original CELEX request', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        const alternate = cellarAlternateFor(current, allowedDomains)
        if (alternate === undefined) {
          throw new EvidenceFetchError('evidence endpoint returned HTTP 202', 'VERIFIED_RESEARCH_FETCH_PENDING')
        }
        cellarState = 'resolver'
        cellarWorkUrl = alternate.toString()
        current = alternate
        origin = current.origin
        continue
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        if (cellarState === 'document') {
          throw new EvidenceFetchError('Cellar document redirects were blocked', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        if (redirects >= maxRedirects) {
          throw new EvidenceFetchError('evidence redirect limit exceeded', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        const location = headerValue(response.headers, 'location')
        if (location === undefined) {
          throw new EvidenceFetchError('evidence redirect omitted Location', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        let target: URL
        try {
          if (cellarState === 'resolver') {
            if (response.statusCode !== 303 || cellarWorkUrl === undefined || current.toString() !== cellarWorkUrl) {
              throw new EvidenceFetchError('Cellar work endpoint required an exact HTTP 303 representation redirect', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
            }
            const document = cellarDocumentRedirect(current, cellarWorkUrl, location)
            if (document === undefined) {
              throw new EvidenceFetchError('Cellar work endpoint returned an invalid representation redirect', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
            }
            target = validatedEvidenceUrl(document.toString(), allowedDomains)
            cellarDocumentUrl = target.toString()
            cellarState = 'document'
          } else {
            target = validatedEvidenceUrl(new URL(location, current).toString(), allowedDomains)
          }
        } catch (error: unknown) {
          if (error instanceof EvidenceFetchError) throw error
          throw new EvidenceFetchError('evidence redirect Location was invalid', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR', { cause: error })
        }
        if (target.origin !== origin) {
          throw new EvidenceFetchError('cross-origin evidence redirect was blocked', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
        }
        current = target
        continue
      }
      if (cellarState === 'resolver') {
        throw new EvidenceFetchError('Cellar work endpoint did not return its required HTTP 303 redirect', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
      }
      if (response.statusCode !== 200) {
        throw new EvidenceFetchError(`evidence endpoint returned HTTP ${response.statusCode}`, 'VERIFIED_RESEARCH_FETCH_HTTP_ERROR')
      }
      if (cellarState === 'document' && (cellarDocumentUrl === undefined || current.toString() !== cellarDocumentUrl)) {
        throw new EvidenceFetchError('Cellar alternate did not end at its exact representation URL', 'VERIFIED_RESEARCH_FETCH_REDIRECT_ERROR')
      }
      const mediaType = mediaTypeOf(response.headers)
      const textEncoding = textEncodingOf(response.headers)
      if (cellarState === 'document' && mediaType !== 'application/xhtml+xml') {
        throw new EvidenceFetchError('Cellar alternate did not return application/xhtml+xml', 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR')
      }
      let body: string
      try {
        body = textEncoding === 'windows-1252'
          ? decodeWindows1252(response.bytes)
          : new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)
      } catch (error: unknown) {
        throw new EvidenceFetchError(`evidence response was not valid ${textEncoding} text`, 'VERIFIED_RESEARCH_FETCH_CONTENT_ERROR', { cause: error })
      }
      return {
        url: current.toString(),
        mediaType,
        body,
        retrievedAt: new Date().toISOString(),
        ...(cellarState === 'document' ? { derivedFrom: original } : {}),
      }
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
}
