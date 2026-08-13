const MAX_ALLOWED_DOMAINS = 20

export class SearchFilterError extends Error {
  readonly code = 'VERIFIED_SEARCH_INVALID_FILTER'
}

/** @deprecated Use filterAllowedSources for provider-compatible degradation. */
export class SearchFilterViolationError extends Error {
  readonly code = 'VERIFIED_SEARCH_FILTER_VIOLATION'
}

/** Normalize the portable hostname-only allowlist. */
export function normalizeAllowedDomains(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined
  if (values.length === 0) throw new SearchFilterError('allowed_domains must contain at least one domain')
  if (values.length > MAX_ALLOWED_DOMAINS) {
    throw new SearchFilterError(`allowed_domains supports at most ${MAX_ALLOWED_DOMAINS} domains`)
  }
  const normalized = values.map((value) => {
    if (value.length === 0 || value !== value.trim()) {
      throw new SearchFilterError('allowed_domains entries must be non-empty and have no surrounding whitespace')
    }
    if (!/^[\x21-\x7e]+$/u.test(value)) {
      throw new SearchFilterError('allowed_domains entries must contain only printable ASCII')
    }
    if (value.length > 253 || value.includes('://') || /[\\/?#@:*]/u.test(value)) {
      throw new SearchFilterError('allowed_domains entries must be bare hostnames without scheme, path, port, wildcard, query, or credentials')
    }
    const hostname = value.toLowerCase()
    let parsedHostname: string
    try {
      parsedHostname = new URL(`http://${hostname}`).hostname.toLowerCase()
    } catch {
      throw new SearchFilterError('allowed_domains entries must be valid ASCII hostnames, not IP literals')
    }
    const labels = hostname.split('.')
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)
      || parsedHostname !== hostname
      || labels.length < 2
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
      throw new SearchFilterError('allowed_domains entries must be valid ASCII hostnames, not IP literals')
    }
    return hostname
  })
  return [...new Set(normalized)]
}

export function sourceMatchesDomain(sourceUrl: string, domain: string): boolean {
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username.length > 0 || url.password.length > 0) return false
  const sourceHost = url.hostname.toLowerCase()
  return sourceHost === domain || sourceHost.endsWith(`.${domain}`)
}

/** Keep only structured sources that satisfy the portable allowlist. */
export function filterAllowedSources<T extends { readonly url: string }>(
  sources: readonly T[],
  allowedDomains: readonly string[] | undefined,
): { readonly sources: readonly T[]; readonly filteredOut: number } {
  if (allowedDomains === undefined) return { sources, filteredOut: 0 }
  const accepted = sources.filter(source => allowedDomains.some(domain => sourceMatchesDomain(source.url, domain)))
  return { sources: accepted, filteredOut: sources.length - accepted.length }
}

/** @deprecated Retained for v0.1.x API compatibility; new code should post-filter. */
export function enforceAllowedSources(
  urls: readonly string[],
  allowedDomains: readonly string[] | undefined,
): void {
  if (allowedDomains === undefined) return
  const index = urls.findIndex(url => !allowedDomains.some(domain => sourceMatchesDomain(url, domain)))
  if (index === -1) return
  throw new SearchFilterViolationError(`search provider returned source ${index + 1} outside allowed_domains`)
}
