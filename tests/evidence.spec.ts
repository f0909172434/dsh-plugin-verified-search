import { describe, expect, it } from 'vitest'
import { extractPageEvidence, normalizeFetchedPage } from '../src/evidence.js'

function normalizedHtml(body: string): string {
  return normalizeFetchedPage({
    url: 'https://example.com/html',
    mediaType: 'text/html',
    body,
    retrievedAt: '2026-08-14T00:00:00.000Z',
  }).text
}

describe('inert page normalization and exact excerpts', () => {
  it('normalizes XHTML through the inert HTML tokenizer', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: '<html><body><script>ignore()</script><p>Article 113 applies from 2 August 2026.</p></body></html>',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(normalized.text).toBe('Article 113 applies from 2 August 2026.')
  })

  it('retains query-relevant provisions beyond the old 100,000-character prefix', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: `<html><body><p>${'background material '.repeat(8_000)}</p><h2>Article 113</h2><p>This Regulation shall apply from 2 August 2026.</p></body></html>`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(normalized.text.length).toBeGreaterThan(100_000)
    expect(extractPageEvidence(normalized, 'Article 113 Regulation apply 2 August 2026')?.excerpt)
      .toContain('Article 113')
  })

  it('prefers an exact legal section heading over earlier cross-references and regulation identifiers', () => {
    const normalized = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item',
      mediaType: 'application/xhtml+xml',
      body: [
        '<p>Article 111 cross-refers to Article 113 and Regulation EU-2024-1689 but does not state entry into force.</p>',
        '<h2>Article&nbsp;113</h2>',
        '<h3>Entry into force and application</h3>',
        '<p>This Regulation shall apply from 2 August 2026.</p>',
      ].join(''),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(normalized, 'Article 113 entry into force application 2 August 2026')
    expect(evidence?.excerpt.startsWith('Article 113')).toBe(true)
    expect(evidence?.excerpt).toContain('2 August 2026')
  })

  it('does not mark a version-and-date claim covered without both values', () => {
    const generic = normalizedHtml('Latest stable release information is available on the downloads page. Production applications should use Active LTS releases.')
    const genericPage = normalizeFetchedPage({
      url: 'https://example.com/generic',
      mediaType: 'text/plain',
      body: generic,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const query = 'latest stable Node.js version number and release date'
    expect(extractPageEvidence(genericPage, query)).toBeUndefined()

    const exactPage = normalizeFetchedPage({
      url: 'https://example.com/exact',
      mediaType: 'text/plain',
      body: 'Latest stable Node.js version v26.7.0 was released on 5 August 2026.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(exactPage, query)?.excerpt).toContain('v26.7.0')
  })

  it('requires a local latest assertion instead of combining a generic link with a later table row', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/versions',
      mediaType: 'text/plain',
      body: [
        'The latest release for each version is on the downloads page.',
        'Unrelated navigation.',
        'Version 3.14.0 was released on 7 October 2025.',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(page, 'latest stable Python version number and release date')).toBeUndefined()
  })

  it('does not cover a scheduled meeting-date claim without a concrete date range', () => {
    const generic = normalizeFetchedPage({
      url: 'https://example.com/calendar',
      mediaType: 'text/plain',
      body: 'The committee holds eight scheduled meetings each year. 2026 FOMC Meetings.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(generic, 'latest completed scheduled FOMC meeting date range')).toBeUndefined()

    const exact = normalizeFetchedPage({
      url: 'https://example.com/calendar',
      mediaType: 'text/plain',
      body: 'July 28-29, 2026 FOMC Meeting. Statement released July 29, 2026.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(exact, 'scheduled FOMC meeting date range July 2026')?.excerpt)
      .toContain('July 28-29, 2026')
  })

  it('binds document evidence to the declared year-month instead of another FOMC statement', () => {
    const march = normalizeFetchedPage({
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260318a.htm',
      mediaType: 'text/plain',
      body: 'March 18, 2026 Federal Reserve issues FOMC statement. Voting for the monetary policy action were Example Person.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(
      march,
      'FOMC July 2026 statement voting for names',
      ['Voting for', '2026'],
      {
        kind: 'document',
        mustInclude: ['FOMC statement'],
        temporalAnchor: { kind: 'year_month', role: 'document', value: '2026-07' },
      },
    )).toBeUndefined()
  })

  it('does not treat a release date or Last Update footer as a July event row', () => {
    const calendar = normalizeFetchedPage({
      url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      mediaType: 'text/plain',
      body: [
        '2026 FOMC Meetings',
        'June',
        '16-17*',
        '(Released July 08, 2026)',
        'September',
        '15-16*',
        'Last Update:',
        'July 29, 2026',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(
      calendar,
      'FOMC July 2026 meeting date range',
      ['July', '2026'],
      {
        kind: 'event_row',
        mustInclude: ['FOMC', '2026'],
        temporalAnchor: { kind: 'year_month', role: 'event', value: '2026-07' },
      },
    )).toBeUndefined()

    const trailingLabel = normalizeFetchedPage({
      url: calendar.url,
      mediaType: 'text/plain',
      body: '2026 FOMC Meetings\nJuly 29, 2026 (Last Updated)',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(
      trailingLabel,
      'FOMC July 2026 meeting date range',
      ['July', '2026'],
      {
        kind: 'event_row',
        mustInclude: ['FOMC', '2026'],
        temporalAnchor: { kind: 'year_month', role: 'event', value: '2026-07' },
      },
    )).toBeUndefined()
  })

  it('keeps event years scoped and selects the first parsed event after a cutoff', () => {
    const wrongSection = normalizeFetchedPage({
      url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
      mediaType: 'text/plain',
      body: '2025 FOMC Meetings\n(Released July 08, 2026)\nSeptember\n15-16*',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = {
      kind: 'event_row' as const,
      mustInclude: ['FOMC', '2026'],
      temporalAnchor: { kind: 'after' as const, role: 'event' as const, value: '2026-07-31', select: 'first' as const },
    }
    expect(extractPageEvidence(wrongSection, 'FOMC next meeting date range after July 2026', ['FOMC'], scope))
      .toBeUndefined()

    const calendar = normalizeFetchedPage({
      url: wrongSection.url,
      mediaType: 'text/plain',
      body: '2026 FOMC Meetings\nJune\n16-17*\n(Released July 08, 2026)\nSeptember\n15-16*\nDecember\n8-9*',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(calendar, 'FOMC next meeting date range after July 2026', ['FOMC', '2026'], scope)
    expect(evidence?.excerpt).toContain('September\n15-16*')
    expect(evidence?.excerpt).not.toContain('December\n8-9*')
  })

  it('requires names and a preferred action for a dissent claim', () => {
    const generic = normalizeFetchedPage({
      url: 'https://example.com/statement',
      mediaType: 'text/plain',
      body: 'The committee approved the statement by a 9-3 vote and maintained the target range.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const query = 'vote dissenters names and their preferred action'
    expect(extractPageEvidence(generic, query)).toBeUndefined()

    const exact = normalizeFetchedPage({
      url: 'https://example.com/statement',
      mediaType: 'text/plain',
      body: 'Voting against the action were Beth M. Hammack, Neel Kashkari, and Lorie K. Logan, who preferred to raise the target range by 1/4 percentage point.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(exact, query)?.excerpt).toContain('Beth M. Hammack')
  })

  it('does not treat NVD CVSS tabs or generic vector prose as assigned metrics', () => {
    const page = normalizeFetchedPage({
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-20349',
      mediaType: 'text/plain',
      body: [
        'CVE-2026-20349',
        'NVD',
        'Metrics',
        'CVSS Version 4.0',
        'CVSS Version 3.x',
        'CVSS Version 2.0',
        'NVD enrichment efforts reference publicly available information to associate vector strings.',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = { kind: 'document' as const, mustInclude: ['CVE-2026-20349', 'NVD'] }

    expect(extractPageEvidence(page, 'assigned CVSS version', ['CVSS Version'], scope, 'cvss_assigned_version'))
      .toBeUndefined()
    expect(extractPageEvidence(page, 'full CVSS vector', ['CVSS v', 'Vector'], scope, 'cvss_vector'))
      .toBeUndefined()
    expect(extractPageEvidence(page, 'CVSS base score', ['Base Score'], scope, 'cvss_base_score'))
      .toBeUndefined()
  })

  it('requires a complete typed CVSS metric block', () => {
    const body = [
      'CVE-2026-20349',
      'NVD',
      'CVSS Version 4.0',
      'Base Score: 8.7',
      'Vector: CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N',
    ].join('\n')
    const page = normalizeFetchedPage({
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-20349',
      mediaType: 'text/plain',
      body,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = { kind: 'document' as const, mustInclude: ['CVE-2026-20349', 'NVD'] }

    expect(extractPageEvidence(page, 'assigned CVSS version', ['CVSS Version'], scope, 'cvss_assigned_version')?.excerpt)
      .toContain('CVSS Version 4.0')
    expect(extractPageEvidence(page, 'full CVSS vector', ['Vector'], scope, 'cvss_vector')?.excerpt)
      .toContain('CVSS:4.0/AV:N')
    expect(extractPageEvidence(page, 'CVSS base score', ['Base Score'], scope, 'cvss_base_score')?.excerpt)
      .toContain('Base Score: 8.7')

    const invalidScore = normalizeFetchedPage({ ...page, body: body.replace('8.7', '11.0') })
    expect(extractPageEvidence(invalidScore, 'CVSS base score', ['Base Score'], scope, 'cvss_base_score'))
      .toBeUndefined()
    const incompleteVector = normalizeFetchedPage({
      ...page,
      body: body.replace('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N', 'CVSS:4.0/AV:N'),
    })
    expect(extractPageEvidence(incompleteVector, 'full CVSS vector', ['Vector'], scope, 'cvss_vector'))
      .toBeUndefined()
  })

  it('accepts one line-wrapped NVD CVSS 3.1 block with its numeric score and complete vector', () => {
    const page = normalizeFetchedPage({
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-20349',
      mediaType: 'text/html',
      body: `<main><h1>NVD - CVE-2026-20349</h1><h2>Metrics</h2>
        <div>CVSS Version 4.0</div><div>CVSS Version 3.x</div><div>CVSS Version 2.0</div>
        <p>NVD enrichment efforts reference publicly available information to associate vector strings.</p>
        <h3>CVSS 4.0 Severity and Vector Strings:</h3><div>NIST: NVD</div><div>N/A</div>
        <div>NVD assessment</div><div>not yet provided.</div>
        <h3>CVSS 3.x Severity and Vector Strings:</h3><div>CNA: Cisco Systems, Inc.</div>
        <div>Base</div><div>Score: 8.6 HIGH</div>
        <div>Vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H</div>
        <h3>CVSS 2.0 Severity and Vector Strings:</h3><div>NIST: NVD</div><div>Base</div><div>Score: N/A</div>
      </main>`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = { kind: 'document' as const, mustInclude: ['CVE-2026-20349', 'NVD'] }
    const assigned = extractPageEvidence(
      page,
      'assigned CVSS version',
      ['CVSS Version'],
      scope,
      'cvss_assigned_version',
    )
    const vector = extractPageEvidence(page, 'full CVSS vector', ['Vector'], scope, 'cvss_vector')
    const score = extractPageEvidence(page, 'CVSS base score', ['Base Score'], scope, 'cvss_base_score')

    for (const evidence of [assigned, vector, score]) {
      expect(evidence?.excerpt).toContain('CVSS 3.x Severity and Vector Strings:')
      expect(evidence?.excerpt).toContain('Base\nScore: 8.6 HIGH')
      expect(evidence?.excerpt).toContain('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H')
    }
    expect(assigned?.excerpt).toContain('CVSS Version 3.x')
  })

  it('selects concrete fixed-release and remediation sections instead of cross-references', () => {
    const page = normalizeFetchedPage({
      url: 'https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/example',
      mediaType: 'text/plain',
      body: [
        'Cisco Security Advisory',
        'CVE-2026-20349',
        'Affected Products',
        'For information about vulnerable releases, see the Fixed Software section of this advisory.',
        'Workarounds',
        'There are no workarounds that address this vulnerability.',
        'Fixed Software',
        'Cisco Secure Firewall ASA Software Release',
        'Hot Fix Name',
        '9.20',
        '9.20.4.235',
        'To fully remediate this vulnerability, upgrade to the listed hot fix.',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = { kind: 'document' as const, mustInclude: ['Cisco Security Advisory', 'CVE-2026-20349'] }
    const fixed = extractPageEvidence(
      page,
      'fixed Cisco ASA software releases',
      ['Fixed Software'],
      scope,
      'generic_text',
    )
    const workaround = extractPageEvidence(
      page,
      'official remediation workaround',
      ['Workarounds'],
      scope,
      'generic_text',
    )

    expect(fixed?.excerpt).toContain('9.20.4.235')
    expect(fixed?.excerpt).toContain('Hot Fix Name')
    expect(workaround?.excerpt).toContain('fully remediate')
    expect(extractPageEvidence(
      normalizeFetchedPage({ ...page, body: page.text.split('\n').slice(0, 4).join('\n') }),
      'fixed Cisco ASA software releases',
      ['Fixed Software'],
      scope,
      'generic_text',
    )).toBeUndefined()
  })

  it('does not let affected and fixed version sections satisfy the opposite query intent', () => {
    const scope = { kind: 'document' as const, mustInclude: ['Cisco Security Advisory', 'CVE-2026-20349'] }
    const page = (body: readonly string[]) => normalizeFetchedPage({
      url: 'https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/example',
      mediaType: 'text/plain',
      body: ['Cisco Security Advisory', 'CVE-2026-20349', 'Cisco ASA', ...body].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const affectedOnly = page([
      'Affected Versions',
      '9.18.4',
      'Fixed Software',
      'No fixed or patched release is currently listed.',
    ])
    expect(extractPageEvidence(
      affectedOnly,
      'fixed Cisco ASA software releases',
      ['Fixed Software'],
      scope,
    )).toBeUndefined()

    const fixedOnly = page([
      'Affected Versions',
      'No affected or vulnerable release is currently listed.',
      'Fixed Software',
      'Hot Fix Name',
      '9.20.4.235',
    ])
    expect(extractPageEvidence(
      fixedOnly,
      'affected Cisco ASA versions',
      ['Affected Versions'],
      scope,
    )).toBeUndefined()

    const both = page([
      'Affected Versions',
      '9.18.4',
      'Fixed Software',
      'Hot Fix Name',
      '9.20.4.235',
    ])
    expect(extractPageEvidence(
      both,
      'affected and fixed Cisco ASA software versions',
      ['Affected Versions', 'Fixed Software'],
      scope,
    )?.excerpt).toContain('9.20.4.235')
  })

  it('does not borrow versions from adjacent affected-product or CVSS sections', () => {
    const page = normalizeFetchedPage({
      url: 'https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/example',
      mediaType: 'text/plain',
      body: [
        'Cisco Security Advisory',
        'CVE-2026-20349',
        'Cisco ASA Fixed Software',
        'No patched release is currently listed.',
        'Affected Products',
        'Cisco ASA 9.18.4',
        'CVSS Version 3.1',
        'Vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(
      page,
      'fixed Cisco ASA software releases',
      ['Fixed Software'],
      { kind: 'document', mustInclude: ['Cisco Security Advisory', 'CVE-2026-20349'] },
    )).toBeUndefined()
  })

  it('rejects N/A and metrics split across incompatible CVSS sections', () => {
    const scope = { kind: 'document' as const, mustInclude: ['CVE-2026-20349', 'NVD'] }
    const nA = normalizeFetchedPage({
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-20349',
      mediaType: 'text/plain',
      body: [
        'CVE-2026-20349',
        'NVD',
        'CVSS Version 3.1',
        'CVSS 3.x Severity and Vector Strings:',
        'CNA: Example',
        'Base',
        'Score: N/A',
        'Vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H',
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const split = normalizeFetchedPage({
      ...nA,
      body: [
        'CVE-2026-20349',
        'NVD',
        'CVSS Version 3.1',
        'CVSS 3.x Severity and Vector Strings:',
        'CNA: Example',
        'Base Score: 8.6 HIGH',
        'CVSS 4.0 Severity and Vector Strings:',
        'Vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H',
      ].join('\n'),
    })
    const ambiguous = normalizeFetchedPage({
      ...nA,
      body: [
        'CVE-2026-20349',
        'NVD',
        'CVSS Version 3.1',
        'CVSS 3.x Severity and Vector Strings:',
        'CNA: Example A',
        'Base Score: 8.6 HIGH',
        'CNA: Example B',
        'Base Score: N/A',
        'Vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:N/A:H',
      ].join('\n'),
    })
    for (const page of [nA, split, ambiguous]) {
      expect(extractPageEvidence(page, 'assigned CVSS version', ['CVSS Version'], scope, 'cvss_assigned_version'))
        .toBeUndefined()
      expect(extractPageEvidence(page, 'full CVSS vector', ['Vector'], scope, 'cvss_vector'))
        .toBeUndefined()
      expect(extractPageEvidence(page, 'CVSS base score', ['Base Score'], scope, 'cvss_base_score'))
        .toBeUndefined()
    }
  })

  it('does not treat one structured row as proof of a global extremum or all ties', () => {
    const row = normalizeFetchedPage({
      url: 'https://example.com/events.json',
      mediaType: 'application/json',
      body: '{"id":"event-1","magnitude":7.4,"status":"reviewed"}',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const query = 'maximum magnitude event and all ties'
    expect(extractPageEvidence(row, query)).toBeUndefined()

    const assertion = normalizeFetchedPage({
      url: 'https://example.com/summary',
      mediaType: 'text/plain',
      body: 'The maximum magnitude was 7.4. It was the unique highest event, with no ties.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(assertion, query)?.excerpt).toContain('no ties')
  })

  it('rejects Artemis planning or negation as evidence of actual mission outcomes', () => {
    const scope = { kind: 'document' as const, mustInclude: ['Artemis II'] }
    const planning = normalizeFetchedPage({
      url: 'https://www.nasa.gov/artemis-ii-planning/',
      mediaType: 'text/plain',
      body: 'Artemis II launch planning remains underway. No launch has occurred. The mission is targeted for April 2026 and will travel 600,000 miles over 10 days before a scheduled splashdown.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(planning, 'actual Artemis II launch UTC', ['launch'], scope)).toBeUndefined()
    expect(extractPageEvidence(planning, 'actual Artemis II splashdown UTC', ['splashdown'], scope)).toBeUndefined()
    expect(extractPageEvidence(planning, 'actual Artemis II total miles', ['miles'], scope)).toBeUndefined()
    expect(extractPageEvidence(planning, 'actual Artemis II mission duration days', ['days'], scope)).toBeUndefined()

    const completed = normalizeFetchedPage({
      url: 'https://www.nasa.gov/artemis-ii-complete/',
      mediaType: 'text/plain',
      body: 'Artemis II launched on April 2, 2026 at 10:30 UTC and splashdown occurred on April 12, 2026 at 11:45 UTC. The completed mission traveled 625,000 miles and lasted 10.1 days.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(completed, 'actual Artemis II launch UTC', ['launch'], scope)?.excerpt)
      .toContain('launched')
    expect(extractPageEvidence(completed, 'actual Artemis II splashdown UTC', ['splashdown'], scope)?.excerpt)
      .toContain('splashdown occurred')
    expect(extractPageEvidence(completed, 'actual Artemis II total miles', ['miles'], scope)?.excerpt)
      .toContain('625,000 miles')
    expect(extractPageEvidence(completed, 'actual Artemis II mission duration days', ['days'], scope)?.excerpt)
      .toContain('10.1 days')
  })

  it('removes executable/hidden HTML and decodes text entities', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/current',
      mediaType: 'text/html',
      body: `<!doctype html><html><head><style>secret-style</style><script>ignore me</script></head>
        <body><nav>ignore navigation</nav><main><h1>Current &amp; official model</h1>
        <p>The model identifier is model-v4-pro.</p></main><footer>ignore footer</footer></body></html>`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(page.text).toContain('Current & official model')
    expect(page.text).toContain('model-v4-pro')
    expect(page.text).not.toContain('secret-style')
    expect(page.text).not.toContain('ignore me')
    expect(page.text).not.toContain('ignore navigation')
    expect(page.contentSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('recovers a document content root after implicitly closed navigation chrome', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/release-history',
      mediaType: 'text/html',
      body: '<header><nav>outer<nav>nested</nav></header><main><h1>Release History</h1><p>go1.26.6 released 2026-08-13.</p></main>',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(page.text).toBe('Release History\ngo1.26.6 released 2026-08-13.')
    expect(page.text).not.toContain('outer')
    expect(page.text).not.toContain('nested')
  })

  it('uses document scope as a page-global identity boundary while keeping evidence phrases local', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/long-law',
      mediaType: 'text/plain',
      body: [
        'Regulation identity marker 2026/1744',
        ...Array.from({ length: 400 }, (_, index) => `background line ${index}`),
        "Application and enforcement timeline\nThe Commission’s enforcement powers enter into application on 2 August 2026.",
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const scope = { kind: 'document' as const, mustInclude: ['2026/1744'] }
    const evidence = extractPageEvidence(
      page,
      'Commission enforcement powers application date',
      ["Commission's enforcement powers"],
      scope,
    )

    expect(evidence?.excerpt).toContain('2 August 2026')
    expect(evidence?.excerpt).not.toContain('Regulation identity marker')
    expect(extractPageEvidence(
      page,
      'Commission enforcement powers application date',
      ["Commission's enforcement powers"],
      { kind: 'document', mustInclude: ['missing document marker'] },
    )).toBeUndefined()
  })

  it('crops around required phrases instead of an earlier query hit', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/guidelines',
      mediaType: 'text/plain',
      body: [
        `Commission application background ${'context '.repeat(320)}`,
        "Application and enforcement timeline\nFrom 2 August 2026, the Commission’s enforcement powers enter into application.",
      ].join('\n'),
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(
      page,
      'Commission enforcement powers application date',
      ["Commission's enforcement powers"],
      { kind: 'document', mustInclude: ['Application and enforcement timeline'] },
    )

    expect(evidence?.excerpt).toContain('2 August 2026')
    expect(evidence?.excerpt).toContain('Commission’s enforcement powers')
    expect(evidence?.excerpt.length).toBeLessThanOrEqual(2_000)
  })

  it('recognizes an Official Journal dotted date for a document month anchor', () => {
    const page = normalizeFetchedPage({
      url: 'https://publications.europa.eu/resource/cellar/item/DOC_1',
      mediaType: 'text/plain',
      body: 'Official Journal of the European Union\n2026/1744\n24.7.2026\nArticle 4\nThis Regulation enters into force on the third day following publication.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    expect(extractPageEvidence(
      page,
      'entry into force rule Article 4',
      ['third day following'],
      {
        kind: 'document',
        mustInclude: ['2026/1744'],
        temporalAnchor: { kind: 'year_month', role: 'document', value: '2026-07' },
      },
    )?.excerpt).toContain('third day following')
  })

  it('drops an unclosed suppressed block and bounds malformed HTML work', () => {
    const started = performance.now()
    const page = normalizeFetchedPage({
      url: 'https://example.com/malformed',
      mediaType: 'text/html',
      body: `<main>Retained evidence</main>${'<script>'.repeat(80_000)}never executable`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(page.text).toBe('Retained evidence')
    expect(page.text).not.toContain('never executable')
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('handles raw-text, tree suppression, comments, and quoted tag delimiters', () => {
    expect(normalizedHtml('a<!-- hidden -->b')).toBe('a b')
    expect(normalizedHtml('a<!-- unclosed')).toBe('a')
    expect(normalizedHtml(`before<script>if (a < b) {
      const x = "<script>";
      const y = "<!--";
    }</script>after`)).toBe('before\nafter')
    expect(normalizedHtml('A<nav><script>const x = "</nav>"</script>hidden</nav>B')).toBe('A\nB')
    expect(normalizedHtml('<p title="1 > 0">kept</p>')).toBe('kept')
  })

  it('recovers after a stray quote without treating quoted greater-than signs as tag ends', () => {
    const html = [
      '<form action="/download.pdf"" name="pdfGeneration" method="post">',
      '<input type="hidden" value="untrusted-control">',
      '</form>',
      '<div title="1 > 0"><h2>Affected Products</h2><p>CVE-2026-20349 retained advisory evidence.</p></div>',
    ].join('')

    expect(normalizedHtml(html)).toBe('Affected Products\nCVE-2026-20349 retained advisory evidence.')
    expect(normalizedHtml('<p title="1 > 0">quoted delimiter retained</p>'))
      .toBe('quoted delimiter retained')
  })

  it('normalizes whitespace after scanning and bounds long numeric entities', () => {
    expect(normalizedHtml(`${' '.repeat(150_000)}<p>tail</p>`)).toBe('tail')
    expect(normalizedHtml(`${'a'.repeat(99_999)}${' '.repeat(150_000)}b`))
      .toBe(`${'a'.repeat(99_999)} b`)
    expect(normalizedHtml(`${'a'.repeat(99_999)}${' '.repeat(150_000)}`))
      .toBe('a'.repeat(99_999))
    expect(normalizedHtml(`&#${'0'.repeat(200_000)}65;tail`)).toBe('Atail')
    const splitAstral = normalizedHtml(`${'a'.repeat(99_999)}&#x1f600;`)
    expect(splitAstral.length).toBe(100_001)
    expect(splitAstral.charCodeAt(99_999)).toBe(0xd83d)
    expect(splitAstral.charCodeAt(100_000)).toBe(0xde00)
    expect(normalizedHtml('a'.repeat(2 * 1024 * 1024 + 100))).toHaveLength(2 * 1024 * 1024)
  })

  it('returns a contiguous excerpt with reproducible offsets and hash', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/current',
      mediaType: 'text/plain',
      body: 'Unrelated introduction.\nThe current official flagship model\nModel ID\nmodel-v4-pro\nAlias\nmodel-v4\nOther text.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(page, 'official flagship model ID')

    expect(evidence).toBeDefined()
    expect(page.text.slice(evidence!.excerptStart, evidence!.excerptEnd)).toBe(evidence!.excerpt)
    expect(evidence!.excerpt).toContain('model-v4-pro')
    expect(evidence!.contentSha256).toBe(page.contentSha256)
    expect(extractPageEvidence(page, 'totally absent zebras')).toBeUndefined()
  })

  it('does not mark a cropped excerpt as evidence after required terms fall outside it', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/cropped',
      mediaType: 'text/plain',
      body: `alpha ${'filler '.repeat(500)} flagship`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(extractPageEvidence(page, 'alpha flagship')).toBeUndefined()
  })

  it('fails closed when required phrases cannot coexist in the final 2,000-character excerpt', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/cropped-required-phrases',
      mediaType: 'text/plain',
      body: `alpha required-start ${'filler '.repeat(500)} required-end flagship`,
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })

    expect(extractPageEvidence(page, 'alpha flagship', ['required-start', 'required-end'])).toBeUndefined()
  })

  it('supports Chinese query terms without inventing text', () => {
    const page = normalizeFetchedPage({
      url: 'https://example.com/zh',
      mediaType: 'text/plain',
      body: '官方模型清單\n目前旗艦模型識別碼為 deepseek-v4-pro。',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })
    const evidence = extractPageEvidence(page, '目前官方旗艦模型識別碼')
    expect(evidence?.excerpt).toContain('deepseek-v4-pro')
  })
})
