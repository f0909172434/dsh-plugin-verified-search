import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main as evaluationMain } from '../src/evaluate-offline-cli.js'
import {
  evaluateOfflineCorpus,
  OfflineEvaluationContractError,
  parseOfflineEvaluationManifest,
  parseOfflineEvaluationSuite,
  sha256Prefixed,
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

  it('fails closed when the parsed suite object differs from its exact bytes', async () => {
    const { manifest, suites } = await loadBundle()
    const changed = structuredClone(suites) as LoadedOfflineEvaluationSuite[]
    const rawCase = changed[0]!.suite.cases[0] as any
    rawCase.expected.assertions[0].equals = ['unexpected.example']

    expect(() => evaluateOfflineCorpus(manifest, changed))
      .toThrowError(/loaded suite object does not match exact bytes/u)
  })

  it('reports assertion regressions when changed bytes are intentionally re-bound', async () => {
    const { manifest, suites } = await loadBundle()
    const rawSuite = JSON.parse(Buffer.from(suites[0]!.bytes).toString('utf8')) as any
    rawSuite.cases[0].expected.assertions[0].equals = ['unexpected.example']
    const bytes = Buffer.from(`${JSON.stringify(rawSuite, null, 2)}\n`, 'utf8')
    const changedSuites: LoadedOfflineEvaluationSuite[] = [
      {
        file: suites[0]!.file,
        bytes,
        suite: parseOfflineEvaluationSuite(rawSuite),
      },
      ...suites.slice(1),
    ]
    const changedManifest: OfflineEvaluationManifest = {
      ...manifest,
      suites: manifest.suites.map((suite, index) => index === 0
        ? { ...suite, sha256: sha256Prefixed(bytes) }
        : suite),
    }

    const report = evaluateOfflineCorpus(changedManifest, changedSuites)
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
