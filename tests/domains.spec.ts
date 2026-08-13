import { describe, expect, it } from 'vitest'
import {
  filterAllowedSources,
  normalizeAllowedDomains,
  SearchFilterError,
  sourceMatchesDomain,
} from '../src/domains.js'

describe('normalizeAllowedDomains', () => {
  it('keeps absence and normalizes/deduplicates hostnames', () => {
    expect(normalizeAllowedDomains(undefined)).toBeUndefined()
    expect(normalizeAllowedDomains(['DeepSeek.COM', 'deepseek.com', 'docs.deepseek.com']))
      .toEqual(['deepseek.com', 'docs.deepseek.com'])
  })

  it.each<[string[]]>([
    [[]],
    [[' example.com']],
    [['https://example.com']],
    [['example.com/path']],
    [['example.com:443']],
    [['*.example.com']],
    [['localhost']],
    [['127.0.0.1']],
    [['127.1']],
    [['1.2.3']],
    [['0x7f.1']],
    [['0177.1']],
    [['例子.測試']],
  ])('rejects invalid allowlist %j', (value) => {
    expect(() => normalizeAllowedDomains(value)).toThrow(SearchFilterError)
  })

  it('rejects more than twenty entries', () => {
    expect(() => normalizeAllowedDomains(Array.from({ length: 21 }, (_, index) => `d${index}.example.com`)))
      .toThrow(/at most 20/u)
  })
})

describe('source postcondition', () => {
  it('accepts exact hosts and subdomains only', () => {
    expect(sourceMatchesDomain('https://deepseek.com/news', 'deepseek.com')).toBe(true)
    expect(sourceMatchesDomain('https://api.deepseek.com/news', 'deepseek.com')).toBe(true)
    expect(sourceMatchesDomain('https://notdeepseek.com', 'deepseek.com')).toBe(false)
    expect(sourceMatchesDomain('https://user:secret@deepseek.com', 'deepseek.com')).toBe(false)
    expect(sourceMatchesDomain('file:///etc/passwd', 'deepseek.com')).toBe(false)
  })

  it('removes non-matching sources before they enter tool output', () => {
    expect(filterAllowedSources([
      { url: 'https://api.deepseek.com/current', title: 'allowed' },
      { url: 'https://evil.example/path?token=secret-value', title: 'removed' },
    ], ['deepseek.com'])).toEqual({
      sources: [{ url: 'https://api.deepseek.com/current', title: 'allowed' }],
      filteredOut: 1,
    })
  })
})
