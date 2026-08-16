import { createHash } from 'node:crypto'
import {
  filterAllowedSources,
  normalizeAllowedDomains,
  sourceMatchesDomain,
} from './domains.js'
import {
  selectJsonNumericTies,
  type JsonNumericSelectionRequest,
} from './json-numeric-selection.js'
import {
  projectJsonRows,
  type JsonProjectionRequest,
} from './json-projection.js'
import {
  selectJsonMaxTies,
  type JsonSelectionRequest,
} from './json-selection.js'

export type OfflineEvaluationCapability =
  | 'domain_filter'
  | 'json_date_selection'
  | 'json_numeric_selection'
  | 'json_projection'

export type OfflineEvaluationOperation =
  | 'normalize_domains'
  | 'source_matches_domain'
  | 'filter_allowed_sources'
  | 'json_date_selection'
  | 'json_numeric_selection'
  | 'json_projection'

export type OfflineJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OfflineJsonValue[]
  | { readonly [key: string]: OfflineJsonValue }

export interface OfflineEvaluationAssertion {
  readonly pointer: string
  readonly equals: OfflineJsonValue
}

export type OfflineEvaluationExpectation =
  | {
      readonly status: 'pass'
      readonly assertions: readonly OfflineEvaluationAssertion[]
    }
  | {
      readonly status: 'error'
      readonly code: string
    }

export interface OfflineEvaluationCase {
  readonly id: string
  readonly capability: OfflineEvaluationCapability
  readonly operation: OfflineEvaluationOperation
  readonly payload: Readonly<Record<string, unknown>>
  readonly expected: OfflineEvaluationExpectation
}

export interface OfflineEvaluationSuite {
  readonly $schema: './suite.schema.json'
  readonly schemaVersion: '1.0.0'
  readonly suiteId: string
  readonly capability: OfflineEvaluationCapability
  readonly cases: readonly OfflineEvaluationCase[]
}

export interface OfflineEvaluationManifestSuite {
  readonly capability: OfflineEvaluationCapability
  readonly suiteId: string
  readonly file: string
  readonly sha256: string
  readonly caseCount: number
}

export interface OfflineEvaluationManifest {
  readonly $schema: './manifest.schema.json'
  readonly schemaVersion: '1.0.0'
  readonly corpusId: string
  readonly description: string
  readonly networkAccessRequired: false
  readonly caseCount: number
  readonly suites: readonly OfflineEvaluationManifestSuite[]
}

export interface LoadedOfflineEvaluationSuite {
  readonly file: string
  readonly bytes: Uint8Array
  readonly suite: OfflineEvaluationSuite
}

export interface OfflineEvaluationCaseResult {
  readonly id: string
  readonly capability: OfflineEvaluationCapability
  readonly operation: OfflineEvaluationOperation
  readonly status: 'PASS' | 'FAIL'
  readonly observedStatus: 'pass' | 'error'
  readonly observedSha256?: string
  readonly observedErrorCode?: string
  readonly assertionsChecked: number
  readonly failures: readonly string[]
}

export interface OfflineEvaluationCapabilityResult {
  readonly cases: number
  readonly passed: number
  readonly failed: number
}

export interface OfflineEvaluationReport {
  readonly schemaVersion: '1.0.0'
  readonly corpusId: string
  readonly networkAccessRequired: false
  readonly caseCount: number
  readonly passed: number
  readonly failed: number
  readonly status: 'PASS' | 'FAIL'
  readonly capabilityResults: Readonly<Record<OfflineEvaluationCapability, OfflineEvaluationCapabilityResult>>
  readonly cases: readonly OfflineEvaluationCaseResult[]
  readonly resultSha256: string
}

export class OfflineEvaluationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineEvaluationContractError'
  }
}

const CAPABILITIES: readonly OfflineEvaluationCapability[] = [
  'domain_filter',
  'json_date_selection',
  'json_numeric_selection',
  'json_projection',
]

const OPERATIONS: readonly OfflineEvaluationOperation[] = [
  'normalize_domains',
  'source_matches_domain',
  'filter_allowed_sources',
  'json_date_selection',
  'json_numeric_selection',
  'json_projection',
]

const OPERATION_CAPABILITY: Readonly<Record<OfflineEvaluationOperation, OfflineEvaluationCapability>> = {
  normalize_domains: 'domain_filter',
  source_matches_domain: 'domain_filter',
  filter_allowed_sources: 'domain_filter',
  json_date_selection: 'json_date_selection',
  json_numeric_selection: 'json_numeric_selection',
  json_projection: 'json_projection',
}

function contractFail(message: string): never {
  throw new OfflineEvaluationContractError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) contractFail(`${label} contains unsupported property "${key}"`)
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      contractFail(`${label} is missing required property "${key}"`)
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) contractFail(`${label} must be an object`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) contractFail(`${label} must be a non-empty string`)
  return value
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    contractFail(`${label} must be a safe integer >= ${minimum}`)
  }
  return value as number
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) contractFail(`${label} must be an array`)
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`))
}

function requireJsonValue(value: unknown, label: string): OfflineJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) contractFail(`${label} must not contain a non-finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => requireJsonValue(entry, `${label}[${index}]`))
  if (isRecord(value)) {
    const result: Record<string, OfflineJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = requireJsonValue(entry, `${label}.${key}`)
    }
    return result
  }
  contractFail(`${label} must be a JSON value`)
}

function parseCapability(value: unknown, label: string): OfflineEvaluationCapability {
  if (typeof value !== 'string' || !CAPABILITIES.includes(value as OfflineEvaluationCapability)) {
    contractFail(`${label} is not a registered capability`)
  }
  return value as OfflineEvaluationCapability
}

function parseOperation(value: unknown, label: string): OfflineEvaluationOperation {
  if (typeof value !== 'string' || !OPERATIONS.includes(value as OfflineEvaluationOperation)) {
    contractFail(`${label} is not a registered operation`)
  }
  return value as OfflineEvaluationOperation
}

function parseExpected(value: unknown, label: string): OfflineEvaluationExpectation {
  const record = requireRecord(value, label)
  const status = record.status
  if (status === 'pass') {
    assertExactKeys(record, ['status', 'assertions'], ['status', 'assertions'], label)
    if (!Array.isArray(record.assertions) || record.assertions.length === 0) {
      contractFail(`${label}.assertions must be a non-empty array`)
    }
    return {
      status,
      assertions: record.assertions.map((raw, index) => {
        const assertion = requireRecord(raw, `${label}.assertions[${index}]`)
        assertExactKeys(assertion, ['pointer', 'equals'], ['pointer', 'equals'], `${label}.assertions[${index}]`)
        const pointer = typeof assertion.pointer === 'string'
          ? assertion.pointer
          : contractFail(`${label}.assertions[${index}].pointer must be a string`)
        if (pointer !== '' && !pointer.startsWith('/')) {
          contractFail(`${label}.assertions[${index}].pointer must be an RFC 6901 JSON Pointer`)
        }
        return {
          pointer,
          equals: requireJsonValue(assertion.equals, `${label}.assertions[${index}].equals`),
        }
      }),
    }
  }
  if (status === 'error') {
    assertExactKeys(record, ['status', 'code'], ['status', 'code'], label)
    return { status, code: requireString(record.code, `${label}.code`) }
  }
  contractFail(`${label}.status must be "pass" or "error"`)
}

function parseCase(value: unknown, label: string): OfflineEvaluationCase {
  const record = requireRecord(value, label)
  assertExactKeys(
    record,
    ['id', 'capability', 'operation', 'payload', 'expected'],
    ['id', 'capability', 'operation', 'payload', 'expected'],
    label,
  )
  const id = requireString(record.id, `${label}.id`)
  if (!/^[a-z][a-z0-9-]{2,95}$/u.test(id)) contractFail(`${label}.id has an invalid format`)
  const capability = parseCapability(record.capability, `${label}.capability`)
  const operation = parseOperation(record.operation, `${label}.operation`)
  if (OPERATION_CAPABILITY[operation] !== capability) {
    contractFail(`${label} operation ${operation} does not belong to capability ${capability}`)
  }
  return {
    id,
    capability,
    operation,
    payload: requireRecord(record.payload, `${label}.payload`),
    expected: parseExpected(record.expected, `${label}.expected`),
  }
}

export function parseOfflineEvaluationSuite(value: unknown): OfflineEvaluationSuite {
  const record = requireRecord(value, 'suite')
  assertExactKeys(
    record,
    ['$schema', 'schemaVersion', 'suiteId', 'capability', 'cases'],
    ['$schema', 'schemaVersion', 'suiteId', 'capability', 'cases'],
    'suite',
  )
  if (record.$schema !== './suite.schema.json') contractFail('suite.$schema is not registered')
  if (record.schemaVersion !== '1.0.0') contractFail('suite.schemaVersion is not supported')
  const suiteId = requireString(record.suiteId, 'suite.suiteId')
  const capability = parseCapability(record.capability, 'suite.capability')
  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    contractFail('suite.cases must be a non-empty array')
  }
  const cases = record.cases.map((entry, index) => parseCase(entry, `suite.cases[${index}]`))
  const ids = new Set<string>()
  for (const testCase of cases) {
    if (testCase.capability !== capability) contractFail(`case ${testCase.id} does not match suite capability`)
    if (ids.has(testCase.id)) contractFail(`suite contains duplicate case ID ${testCase.id}`)
    ids.add(testCase.id)
  }
  return {
    $schema: './suite.schema.json',
    schemaVersion: '1.0.0',
    suiteId,
    capability,
    cases,
  }
}

export function parseOfflineEvaluationManifest(value: unknown): OfflineEvaluationManifest {
  const record = requireRecord(value, 'manifest')
  assertExactKeys(
    record,
    ['$schema', 'schemaVersion', 'corpusId', 'description', 'networkAccessRequired', 'caseCount', 'suites'],
    ['$schema', 'schemaVersion', 'corpusId', 'description', 'networkAccessRequired', 'caseCount', 'suites'],
    'manifest',
  )
  if (record.$schema !== './manifest.schema.json') contractFail('manifest.$schema is not registered')
  if (record.schemaVersion !== '1.0.0') contractFail('manifest.schemaVersion is not supported')
  if (record.networkAccessRequired !== false) contractFail('offline corpus must declare networkAccessRequired=false')
  if (!Array.isArray(record.suites) || record.suites.length === 0) {
    contractFail('manifest.suites must be a non-empty array')
  }
  const suites = record.suites.map((raw, index): OfflineEvaluationManifestSuite => {
    const suite = requireRecord(raw, `manifest.suites[${index}]`)
    assertExactKeys(
      suite,
      ['capability', 'suiteId', 'file', 'sha256', 'caseCount'],
      ['capability', 'suiteId', 'file', 'sha256', 'caseCount'],
      `manifest.suites[${index}]`,
    )
    const file = requireString(suite.file, `manifest.suites[${index}].file`)
    if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') {
      contractFail(`manifest.suites[${index}].file must be a basename`)
    }
    const sha256 = requireString(suite.sha256, `manifest.suites[${index}].sha256`)
    if (!/^sha256:[0-9a-f]{64}$/u.test(sha256)) {
      contractFail(`manifest.suites[${index}].sha256 must be a lowercase SHA-256 digest`)
    }
    return {
      capability: parseCapability(suite.capability, `manifest.suites[${index}].capability`),
      suiteId: requireString(suite.suiteId, `manifest.suites[${index}].suiteId`),
      file,
      sha256,
      caseCount: requireInteger(suite.caseCount, `manifest.suites[${index}].caseCount`, 1),
    }
  })
  return {
    $schema: './manifest.schema.json',
    schemaVersion: '1.0.0',
    corpusId: requireString(record.corpusId, 'manifest.corpusId'),
    description: requireString(record.description, 'manifest.description'),
    networkAccessRequired: false,
    caseCount: requireInteger(record.caseCount, 'manifest.caseCount', 1),
    suites,
  }
}

export function sha256Prefixed(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function verifyOfflineEvaluationBundle(
  manifest: OfflineEvaluationManifest,
  loadedSuites: readonly LoadedOfflineEvaluationSuite[],
): void {
  if (loadedSuites.length !== manifest.suites.length) {
    contractFail(`loaded ${loadedSuites.length} suites, expected ${manifest.suites.length}`)
  }
  const loadedByFile = new Map<string, LoadedOfflineEvaluationSuite>()
  for (const loaded of loadedSuites) {
    if (loadedByFile.has(loaded.file)) contractFail(`duplicate loaded suite file ${loaded.file}`)
    loadedByFile.set(loaded.file, loaded)
  }

  const globalIds = new Set<string>()
  const capabilities = new Set<OfflineEvaluationCapability>()
  let caseCount = 0
  for (const expected of manifest.suites) {
    if (capabilities.has(expected.capability)) {
      contractFail(`manifest contains duplicate capability ${expected.capability}`)
    }
    capabilities.add(expected.capability)
    const loaded = loadedByFile.get(expected.file)
    if (loaded === undefined) contractFail(`manifest suite file is not loaded: ${expected.file}`)
    if (sha256Prefixed(loaded.bytes) !== expected.sha256) {
      contractFail(`suite hash mismatch for ${expected.file}`)
    }
    if (loaded.suite.suiteId !== expected.suiteId) {
      contractFail(`suite ID mismatch for ${expected.file}`)
    }
    if (loaded.suite.capability !== expected.capability) {
      contractFail(`suite capability mismatch for ${expected.file}`)
    }
    if (loaded.suite.cases.length !== expected.caseCount) {
      contractFail(`suite case count mismatch for ${expected.file}`)
    }
    caseCount += loaded.suite.cases.length
    for (const testCase of loaded.suite.cases) {
      if (globalIds.has(testCase.id)) contractFail(`corpus contains duplicate case ID ${testCase.id}`)
      globalIds.add(testCase.id)
    }
  }
  if (caseCount !== manifest.caseCount) {
    contractFail(`corpus contains ${caseCount} cases, expected ${manifest.caseCount}`)
  }
}

function payloadString(payload: Readonly<Record<string, unknown>>, key: string, label: string): string {
  return requireString(payload[key], `${label}.${key}`)
}

function payloadStringArray(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): readonly string[] {
  return requireStringArray(payload[key], `${label}.${key}`)
}

function executeOperation(testCase: OfflineEvaluationCase): unknown {
  const label = `case ${testCase.id}.payload`
  switch (testCase.operation) {
    case 'normalize_domains':
      return normalizeAllowedDomains(payloadStringArray(testCase.payload, 'values', label))
    case 'source_matches_domain':
      return sourceMatchesDomain(
        payloadString(testCase.payload, 'sourceUrl', label),
        payloadString(testCase.payload, 'domain', label),
      )
    case 'filter_allowed_sources': {
      const rawSources = testCase.payload.sources
      if (!Array.isArray(rawSources)) contractFail(`${label}.sources must be an array`)
      const sources = rawSources.map((raw, index) => {
        const source = requireRecord(raw, `${label}.sources[${index}]`)
        requireString(source.url, `${label}.sources[${index}].url`)
        return requireJsonValue(source, `${label}.sources[${index}]`) as Readonly<Record<string, OfflineJsonValue>> & { readonly url: string }
      })
      return filterAllowedSources(
        sources,
        payloadStringArray(testCase.payload, 'allowedDomains', label),
      )
    }
    case 'json_date_selection':
      return selectJsonMaxTies(
        payloadString(testCase.payload, 'input', label),
        requireRecord(testCase.payload.request, `${label}.request`) as unknown as JsonSelectionRequest,
      )
    case 'json_numeric_selection':
      return selectJsonNumericTies(
        payloadString(testCase.payload, 'input', label),
        requireRecord(testCase.payload.request, `${label}.request`) as unknown as JsonNumericSelectionRequest,
      )
    case 'json_projection':
      return projectJsonRows(
        payloadString(testCase.payload, 'input', label),
        requireRecord(testCase.payload.request, `${label}.request`) as unknown as JsonProjectionRequest,
      )
  }
}

function canonicalValue(value: OfflineJsonValue): OfflineJsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, OfflineJsonValue> = {}
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]!)
    return result
  }
  return value
}

function canonicalJson(value: OfflineJsonValue): string {
  return JSON.stringify(canonicalValue(value))
}

function pointerSegments(pointer: string): readonly string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) contractFail(`assertion pointer must start with '/': ${pointer}`)
  return pointer.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) contractFail(`assertion pointer has an invalid escape: ${pointer}`)
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~')
  })
}

function resolveAssertionPointer(root: OfflineJsonValue, pointer: string): OfflineJsonValue {
  let value: OfflineJsonValue = root
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        contractFail(`assertion pointer contains a non-canonical array index: ${pointer}`)
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= value.length) {
        contractFail(`assertion pointer was not found: ${pointer}`)
      }
      value = value[index]!
      continue
    }
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) {
      contractFail(`assertion pointer was not found: ${pointer}`)
    }
    value = value[segment]!
  }
  return value
}

function extractErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function evaluateCase(testCase: OfflineEvaluationCase): OfflineEvaluationCaseResult {
  let observedStatus: 'pass' | 'error'
  let observedSha256: string | undefined
  let observedErrorCode: string | undefined
  let assertionsChecked = 0
  const failures: string[] = []

  try {
    const rawResult = executeOperation(testCase)
    const result = requireJsonValue(rawResult, `case ${testCase.id} result`)
    observedStatus = 'pass'
    observedSha256 = sha256Prefixed(canonicalJson(result))
    if (testCase.expected.status === 'error') {
      failures.push(`expected error ${testCase.expected.code}, but operation passed`)
    } else {
      for (const assertion of testCase.expected.assertions) {
        assertionsChecked++
        const actual = resolveAssertionPointer(result, assertion.pointer)
        if (canonicalJson(actual) !== canonicalJson(assertion.equals)) {
          failures.push(
            `assertion ${assertion.pointer || '<root>'} expected ${canonicalJson(assertion.equals)}, got ${canonicalJson(actual)}`,
          )
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof OfflineEvaluationContractError) throw error
    observedStatus = 'error'
    observedErrorCode = extractErrorCode(error)
    if (testCase.expected.status === 'pass') {
      failures.push(
        `expected pass, got ${observedErrorCode ?? 'untyped error'}: ${extractErrorMessage(error)}`,
      )
    } else if (observedErrorCode !== testCase.expected.code) {
      failures.push(
        `expected error ${testCase.expected.code}, got ${observedErrorCode ?? 'untyped error'}: ${extractErrorMessage(error)}`,
      )
    }
  }

  return {
    id: testCase.id,
    capability: testCase.capability,
    operation: testCase.operation,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    observedStatus,
    ...(observedSha256 === undefined ? {} : { observedSha256 }),
    ...(observedErrorCode === undefined ? {} : { observedErrorCode }),
    assertionsChecked,
    failures,
  }
}

function emptyCapabilityResults(): Record<OfflineEvaluationCapability, OfflineEvaluationCapabilityResult> {
  return {
    domain_filter: { cases: 0, passed: 0, failed: 0 },
    json_date_selection: { cases: 0, passed: 0, failed: 0 },
    json_numeric_selection: { cases: 0, passed: 0, failed: 0 },
    json_projection: { cases: 0, passed: 0, failed: 0 },
  }
}

export function evaluateOfflineCorpus(
  manifest: OfflineEvaluationManifest,
  loadedSuites: readonly LoadedOfflineEvaluationSuite[],
): OfflineEvaluationReport {
  verifyOfflineEvaluationBundle(manifest, loadedSuites)
  const suiteByFile = new Map(loadedSuites.map(loaded => [loaded.file, loaded] as const))
  const results: OfflineEvaluationCaseResult[] = []
  for (const expectedSuite of manifest.suites) {
    const loaded = suiteByFile.get(expectedSuite.file)
    if (loaded === undefined) contractFail(`suite disappeared after verification: ${expectedSuite.file}`)
    for (const testCase of loaded.suite.cases) results.push(evaluateCase(testCase))
  }

  const capabilityResults = emptyCapabilityResults()
  for (const result of results) {
    const current = capabilityResults[result.capability]
    capabilityResults[result.capability] = {
      cases: current.cases + 1,
      passed: current.passed + (result.status === 'PASS' ? 1 : 0),
      failed: current.failed + (result.status === 'FAIL' ? 1 : 0),
    }
  }
  const passed = results.filter(result => result.status === 'PASS').length
  const failed = results.length - passed
  const digestPayload = requireJsonValue({
    corpusId: manifest.corpusId,
    suites: manifest.suites.map(suite => ({ file: suite.file, sha256: suite.sha256 })),
    cases: results,
  }, 'evaluation digest payload')
  return {
    schemaVersion: '1.0.0',
    corpusId: manifest.corpusId,
    networkAccessRequired: false,
    caseCount: results.length,
    passed,
    failed,
    status: failed === 0 ? 'PASS' : 'FAIL',
    capabilityResults,
    cases: results,
    resultSha256: sha256Prefixed(canonicalJson(digestPayload)),
  }
}
