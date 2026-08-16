import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main as evaluationMain } from '../src/evaluate-offline-cli.js'
import {
  evaluateOfflineCorpus,
  OfflineEvaluationContractError,
  parseOfflineEvaluationManifest,
  parseOfflineEvaluationSuite,
  type LoadedOfflineEvaluationSuite,
  type OfflineEvaluationManifest,
} from '../src/offline-evaluation.js'

async function loadBundle(): Promise<{
  readonly manifest: OfflineEvaluationManifest
  readonly suites: readonly LoadedOfflineEvaluationSuite[]
}> {
  const manifestUrl = new URL('../evaluation/manifest.json', import.meta.url)
  const manifest = parseOfflineEvaluationManifest(JSON.parse(await readFile(manifestUrl, 'utf8')))
  const suites: LoadedOfflineEvaluationSuite[] = []
  for (const expected of manifest.suites) {
    const url = new URL(`../evaluation/${expected.file}`, import.meta.url)
    const bytes = await readFile(url)
    suites.push({
      file: expected.file,
      bytes,
      suite: parseOfflineEvaluationSuite(JSON.parse(bytes.toString('utf8'))),
    })
  }
  return { manifest, suites }
}

describe('frozen offline evaluation corpus', () => {
  it('passes every hash-bound case without network access', async () => {
    const { manifest, suites } = await loadBundle()
    const first = evaluateOfflineCorpus(manifest, suites)
    const second = evaluateOfflineCorpus(manifest, suites)

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: '1.0.0',
      corpusId: 'verified-search-offline-v1',
      networkAccessRequired: false,
      caseCount: 42,
      passed: 42,
      failed: 0,
      status: 'PASS',
      capabilityResults: {
        domain_filter: { cases: 11, passed: 11, failed: 0 },
        json_date_selection: { cases: 10, passed: 10, failed: 0 },
        json_numeric_selection: { cases: 10, passed: 10, failed: 0 },
        json_projection: { cases: 11, passed: 11, failed: 0 },
      },
    })
    expect(first.resultSha256).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(first.cases.every(result => result.status === 'PASS')).toBe(true)
  })

  it('fails closed when suite bytes do not match the manifest', async () => {
    const { manifest, suites } = await loadBundle()
    const tampered = suites.map((suite, index) => index === 0
      ? { ...suite, bytes: Buffer.concat([suite.bytes, Buffer.from('\n')]) }
      : suite)

    expect(() => evaluateOfflineCorpus(manifest, tampered)).toThrowError(OfflineEvaluationContractError)
  })

  it('reports assertion regressions instead of rewriting expectations', async () => {
    const { manifest, suites } = await loadBundle()
    const changed = structuredClone(suites) as LoadedOfflineEvaluationSuite[]
    const firstCase = changed[0]!.suite.cases[0]!
    if (firstCase.expected.status !== 'pass') throw new Error('fixture contract changed')
    const firstAssertion = firstCase.expected.assertions[0]!
    Object.assign(firstAssertion, { equals: ['unexpected.example'] })

    const report = evaluateOfflineCorpus(manifest, changed)
    expect(report.status).toBe('FAIL')
    expect(report.failed).toBe(1)
    expect(report.cases[0]).toMatchObject({
      id: 'domains-normalize-lowercase-dedupe',
      status: 'FAIL',
      observedStatus: 'pass',
    })
    expect(report.cases[0]!.failures[0]).toContain('unexpected.example')
  })

  it('writes a machine-readable report through the compiled CLI contract', async ({ task }) => {
    const output = join('work', `offline-evaluation-${task.id}.json`)
    expect(await evaluationMain([
      '--manifest',
      'evaluation/manifest.json',
      '--out',
      output,
    ])).toBe(0)
    const report = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({
      status: 'PASS',
      caseCount: 42,
      passed: 42,
      failed: 0,
    })
  })
})
