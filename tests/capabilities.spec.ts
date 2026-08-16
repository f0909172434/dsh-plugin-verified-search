import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createVerifiedJsonNumericSelectionTool } from '../src/json-numeric-tool.js'
import { createVerifiedJsonProjectionTool } from '../src/json-projection-tool.js'
import { createVerifiedJsonSelectionTool } from '../src/json-tool.js'
import type { OfflineEvaluationManifest } from '../src/offline-evaluation.js'
import { createVerifiedResearchTool } from '../src/research.js'
import { createVerifiedSearchTool } from '../src/tool.js'
import type { SearchOptions } from '../src/types.js'

interface CapabilityTool {
  name: string
  lifecycle: 'reviewed_release' | 'beta' | 'experimental' | 'deprecated'
  first_reviewed_release?: string
  first_main_version?: string
  main_installation: boolean
  removal_condition: string
}

interface CapabilityContract {
  $schema: string
  schema_version: string
  package: {
    name: string
    main_version: string
    main_status: string
    reviewed_release: {
      tag: string
      package_version: string
      tools: string[]
    }
  }
  maintainer_model: string
  runtime_contract: {
    node: string[]
    package_manager: string
    ci_operating_systems: string[]
  }
  upstream_contract: {
    cordis: string
    deepseek_harness: string
    compatibility_kind: string
  }
  model_facing_tools: CapabilityTool[]
  evaluation_contract: {
    corpus_id: string
    manifest: string
    case_count: number
    network_access_required: boolean
    capability_case_counts: Record<string, number>
  }
  non_goals: string[]
}

interface PackageContract {
  name: string
  version: string
  packageManager: string
  engines: { node: string }
  peerDependencies: Record<string, string>
  files: string[]
}

const searchOptions: SearchOptions = {
  apiKey: 'test-only',
  apiKeyRef: 'TEST_API_KEY',
  baseURL: 'https://api.deepseek.com/anthropic/v1',
  model: 'test-model',
  apiVersion: '2023-06-01',
  maxTokens: 64,
  maxUses: 1,
  maxResults: 1,
  recordRequest: () => undefined,
}

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as T
}

describe('machine-readable product contract', () => {
  it('matches package, runtime, and exact upstream versions', async () => {
    const capabilities = await readJson<CapabilityContract>('../capabilities.json')
    const packageJson = await readJson<PackageContract>('../package.json')

    expect(capabilities.$schema).toBe('./docs/capabilities.schema.json')
    expect(capabilities.schema_version).toBe('1.0.0')
    expect(capabilities.package.name).toBe(packageJson.name)
    expect(capabilities.package.main_version).toBe(packageJson.version)
    expect(capabilities.package.main_status).toBe('unreleased_experiment')
    expect(capabilities.maintainer_model).toBe('single_maintainer')
    expect(capabilities.runtime_contract.package_manager).toBe(packageJson.packageManager)
    expect(packageJson.engines.node).toBe('^22.19.0 || >=24.0.0')
    expect(capabilities.runtime_contract.node).toEqual(['22.19.x', '24.x'])
    expect(capabilities.runtime_contract.ci_operating_systems).toEqual([
      'ubuntu-latest',
      'windows-latest',
    ])
    expect(capabilities.upstream_contract).toEqual({
      cordis: packageJson.peerDependencies['@deepseek-ai/cordis'],
      deepseek_harness: '0.1.0-rc.6',
      compatibility_kind: 'exact_peer_contract',
    })
    expect(Object.entries(packageJson.peerDependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .every(([, version]) => version === capabilities.upstream_contract.deepseek_harness))
      .toBe(true)
  })

  it('matches the tools installed by the current main experiment', async () => {
    const capabilities = await readJson<CapabilityContract>('../capabilities.json')
    const actualNames = [
      createVerifiedSearchTool(() => searchOptions, 1_000),
      createVerifiedResearchTool(() => searchOptions, 1_000, 24),
      createVerifiedJsonSelectionTool(1_000),
      createVerifiedJsonNumericSelectionTool(1_000),
      createVerifiedJsonProjectionTool(1_000),
    ].map(tool => tool.name).toSorted()
    const declared = capabilities.model_facing_tools
      .filter(tool => tool.main_installation)
      .map(tool => tool.name)
      .toSorted()

    expect(declared).toEqual(actualNames)
    expect(new Set(declared).size).toBe(declared.length)
    expect(capabilities.package.reviewed_release).toEqual({
      tag: 'v0.1.1',
      package_version: '0.1.1',
      tools: ['verified_search'],
    })
  })

  it('binds the declared evaluation contract to the frozen manifest', async () => {
    const capabilities = await readJson<CapabilityContract>('../capabilities.json')
    const manifest = await readJson<OfflineEvaluationManifest>('../evaluation/manifest.json')
    const perCapability = Object.fromEntries(
      manifest.suites.map(suite => [suite.capability, suite.caseCount]),
    )

    expect(capabilities.evaluation_contract).toEqual({
      corpus_id: manifest.corpusId,
      manifest: 'evaluation/manifest.json',
      case_count: manifest.caseCount,
      network_access_required: manifest.networkAccessRequired,
      capability_case_counts: perCapability,
    })
    expect(manifest.networkAccessRequired).toBe(false)
    expect(manifest.suites.reduce((total, suite) => total + suite.caseCount, 0))
      .toBe(manifest.caseCount)
  })

  it('requires explicit lifecycle origins and removal conditions', async () => {
    const capabilities = await readJson<CapabilityContract>('../capabilities.json')

    for (const tool of capabilities.model_facing_tools) {
      expect(tool.removal_condition.length).toBeGreaterThanOrEqual(20)
      if (tool.lifecycle === 'reviewed_release') {
        expect(tool.first_reviewed_release).toMatch(/^v\d+\.\d+\.\d+$/u)
        expect(tool.first_main_version).toBeUndefined()
      } else {
        expect(tool.first_main_version).toBe(capabilities.package.main_version)
        expect(tool.first_reviewed_release).toBeUndefined()
      }
    }
    expect(capabilities.non_goals.length).toBeGreaterThan(0)
  })

  it('ships lifecycle and evaluation contracts in the package allowlist', async () => {
    const packageJson = await readJson<PackageContract>('../package.json')
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'capabilities.json',
      'evaluation',
      'CHANGELOG.md',
      'MAINTENANCE.md',
      'docs/COMPATIBILITY.md',
      'docs/OFFLINE_EVALUATION.md',
      'docs/capabilities.schema.json',
    ]))
  })
})
