#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  evaluateOfflineCorpus,
  OfflineEvaluationContractError,
  parseOfflineEvaluationManifest,
  parseOfflineEvaluationSuite,
  type LoadedOfflineEvaluationSuite,
} from './offline-evaluation.js'

interface CliOptions {
  readonly manifest: string
  readonly out?: string
}

function usage(): string {
  return [
    'Usage: node lib/evaluate-offline.js [options]',
    '',
    'Options:',
    '  --manifest <path>  Corpus manifest (default: evaluation/manifest.json)',
    '  --out <path>       Write the full deterministic JSON report',
    '  --help             Show this message',
  ].join('\n')
}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let manifest = 'evaluation/manifest.json'
  let out: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help') return 'help'
    if (argument === '--manifest' || argument === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new OfflineEvaluationContractError(`${argument} requires a path`)
      }
      if (argument === '--manifest') manifest = value
      else out = value
      index++
      continue
    }
    throw new OfflineEvaluationContractError(`unsupported argument: ${argument}`)
  }
  return { manifest, ...(out === undefined ? {} : { out }) }
}

async function loadJson(path: string): Promise<{ readonly bytes: Uint8Array; readonly value: unknown }> {
  const bytes = await readFile(path)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error: unknown) {
    throw new OfflineEvaluationContractError(
      `cannot parse JSON ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { bytes, value }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv)
    if (options === 'help') {
      console.log(usage())
      return 0
    }

    const manifestPath = resolve(options.manifest)
    const manifestDocument = await loadJson(manifestPath)
    const manifest = parseOfflineEvaluationManifest(manifestDocument.value)
    const manifestDirectory = dirname(manifestPath)
    const suites: LoadedOfflineEvaluationSuite[] = []
    for (const expected of manifest.suites) {
      const suitePath = resolve(manifestDirectory, expected.file)
      const suiteDocument = await loadJson(suitePath)
      suites.push({
        file: expected.file,
        bytes: suiteDocument.bytes,
        suite: parseOfflineEvaluationSuite(suiteDocument.value),
      })
    }

    const report = evaluateOfflineCorpus(manifest, suites)
    if (options.out !== undefined) {
      const outputPath = resolve(options.out)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    console.log(JSON.stringify({
      status: report.status,
      corpusId: report.corpusId,
      cases: report.caseCount,
      passed: report.passed,
      failed: report.failed,
      resultSha256: report.resultSha256,
      ...(options.out === undefined ? {} : { out: options.out }),
    }, null, 2))
    return report.status === 'PASS' ? 0 : 1
  } catch (error: unknown) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = await main()
}
