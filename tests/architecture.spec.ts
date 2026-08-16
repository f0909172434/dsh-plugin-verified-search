import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

type LayerName = 'foundation' | 'engine' | 'harness' | 'cli' | 'composition'

interface ArchitectureLayer {
  readonly name: LayerName
  readonly purpose: string
  readonly files: readonly string[]
  readonly may_import_layers: readonly LayerName[]
}

interface SizeException {
  readonly path: string
  readonly baseline_bytes: number
  readonly max_bytes: number
  readonly target_bytes: number
  readonly reason: string
  readonly next_extraction: string
  readonly removal_condition: string
}

interface ArchitectureContract {
  readonly $schema: string
  readonly schema_version: string
  readonly baseline_commit: string
  readonly source_root: string
  readonly default_module_max_bytes: number
  readonly dependency_rules: {
    readonly relative_import_cycles: 'forbidden'
    readonly unclassified_source_files: 'forbidden'
    readonly unresolved_relative_imports: 'forbidden'
    readonly harness_external_prefixes: readonly string[]
    readonly harness_external_import_layers: readonly LayerName[]
  }
  readonly layers: readonly ArchitectureLayer[]
  readonly size_exceptions: readonly SizeException[]
}

const ROOT = fileURLToPath(new URL('../', import.meta.url))

function repoPath(path: string): string {
  return relative(ROOT, path).split(sep).join('/')
}

async function readContract(): Promise<ArchitectureContract> {
  return JSON.parse(await readFile(join(ROOT, 'architecture.json'), 'utf8')) as ArchitectureContract
}

async function listProductionSources(directory: string): Promise<string[]> {
  const paths: string[] = []
  const walk = async (absolute: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(absolute, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        paths.push(repoPath(child))
      }
    }
  }
  await walk(directory)
  return paths.toSorted()
}

function moduleSpecifiers(source: string, path: string): readonly string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) specifiers.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function resolveRelativeImport(
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string {
  const importerDirectory = dirname(resolve(ROOT, importer))
  const absoluteBase = resolve(importerDirectory, specifier)
  const candidates = specifier.endsWith('.js')
    ? [absoluteBase.slice(0, -3) + '.ts']
    : specifier.endsWith('.ts')
      ? [absoluteBase]
      : [`${absoluteBase}.ts`, join(absoluteBase, 'index.ts')]
  for (const candidate of candidates) {
    const normalized = repoPath(candidate)
    if (sourceFiles.has(normalized)) return normalized
  }
  throw new Error(`unresolved relative import ${specifier} from ${importer}`)
}

async function importGraph(
  contract: ArchitectureContract,
  sourceFiles: readonly string[],
): Promise<Map<string, Set<string>>> {
  const sourceSet = new Set(sourceFiles)
  const layerByFile = new Map<string, ArchitectureLayer>()
  for (const layer of contract.layers) {
    for (const file of layer.files) layerByFile.set(file, layer)
  }
  const harnessLayers = new Set(contract.dependency_rules.harness_external_import_layers)
  const graph = new Map<string, Set<string>>()
  for (const file of sourceFiles) {
    const layer = layerByFile.get(file)
    if (layer === undefined) throw new Error(`unclassified production source: ${file}`)
    const targets = new Set<string>()
    const source = await readFile(join(ROOT, file), 'utf8')
    for (const specifier of moduleSpecifiers(source, file)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelativeImport(file, specifier, sourceSet)
        const targetLayer = layerByFile.get(target)
        if (targetLayer === undefined) throw new Error(`unclassified import target: ${target}`)
        if (!layer.may_import_layers.includes(targetLayer.name)) {
          throw new Error(
            `${file} (${layer.name}) may not import ${target} (${targetLayer.name})`,
          )
        }
        targets.add(target)
      } else if (contract.dependency_rules.harness_external_prefixes
        .some(prefix => specifier.startsWith(prefix))
        && !harnessLayers.has(layer.name)) {
        throw new Error(`${file} (${layer.name}) may not import Harness package ${specifier}`)
      }
    }
    graph.set(file, targets)
  }
  return graph
}

function assertAcyclic(graph: ReadonlyMap<string, ReadonlySet<string>>): void {
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const visit = (file: string): void => {
    if (visited.has(file)) return
    if (active.has(file)) {
      const start = stack.indexOf(file)
      throw new Error(`relative import cycle: ${[...stack.slice(start), file].join(' -> ')}`)
    }
    active.add(file)
    stack.push(file)
    for (const target of graph.get(file) ?? []) visit(target)
    stack.pop()
    active.delete(file)
    visited.add(file)
  }
  for (const file of graph.keys()) visit(file)
}

describe('source architecture contract', () => {
  it('classifies every production source exactly once', async () => {
    const contract = await readContract()
    const sourceFiles = await listProductionSources(join(ROOT, contract.source_root))
    const layerNames = contract.layers.map(layer => layer.name)
    const declaredFiles = contract.layers.flatMap(layer => layer.files)

    expect(contract.$schema).toBe('./docs/architecture.schema.json')
    expect(contract.schema_version).toBe('1.0.0')
    expect(contract.baseline_commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(new Set(layerNames).size).toBe(layerNames.length)
    expect(new Set(declaredFiles).size).toBe(declaredFiles.length)
    expect(declaredFiles.toSorted()).toEqual(sourceFiles)
    for (const layer of contract.layers) {
      expect(layer.purpose.length).toBeGreaterThanOrEqual(20)
      expect(layer.may_import_layers).toContain(layer.name)
      expect(new Set(layer.may_import_layers).size).toBe(layer.may_import_layers.length)
    }
  })

  it('enforces layer direction, resolved imports, and Harness isolation', async () => {
    const contract = await readContract()
    const sourceFiles = await listProductionSources(join(ROOT, contract.source_root))
    const graph = await importGraph(contract, sourceFiles)

    expect(graph.size).toBe(sourceFiles.length)
    expect(contract.dependency_rules.unclassified_source_files).toBe('forbidden')
    expect(contract.dependency_rules.unresolved_relative_imports).toBe('forbidden')
  })

  it('forbids relative-import cycles', async () => {
    const contract = await readContract()
    const sourceFiles = await listProductionSources(join(ROOT, contract.source_root))
    const graph = await importGraph(contract, sourceFiles)

    expect(contract.dependency_rules.relative_import_cycles).toBe('forbidden')
    expect(() => assertAcyclic(graph)).not.toThrow()
  })

  it('stops module growth and makes every exception removable', async () => {
    const contract = await readContract()
    const sourceFiles = await listProductionSources(join(ROOT, contract.source_root))
    const sourceSet = new Set(sourceFiles)
    const exceptionByPath = new Map(contract.size_exceptions.map(entry => [entry.path, entry]))

    expect(exceptionByPath.size).toBe(contract.size_exceptions.length)
    for (const exception of contract.size_exceptions) {
      expect(sourceSet.has(exception.path)).toBe(true)
      expect(exception.baseline_bytes).toBeGreaterThan(contract.default_module_max_bytes)
      expect(exception.max_bytes).toBeGreaterThanOrEqual(exception.baseline_bytes)
      expect(exception.target_bytes).toBeLessThanOrEqual(contract.default_module_max_bytes)
      expect(exception.reason.length).toBeGreaterThanOrEqual(30)
      expect(exception.next_extraction.length).toBeGreaterThanOrEqual(30)
      expect(exception.removal_condition.length).toBeGreaterThanOrEqual(30)
    }

    for (const file of sourceFiles) {
      const bytes = (await readFile(join(ROOT, file))).byteLength
      const exception = exceptionByPath.get(file)
      if (exception === undefined) {
        expect(bytes, `${file} exceeds the default module budget`).toBeLessThanOrEqual(
          contract.default_module_max_bytes,
        )
      } else {
        expect(bytes, `${file} exceeded its temporary growth stop`).toBeLessThanOrEqual(
          exception.max_bytes,
        )
        expect(
          bytes,
          `${file} now fits the default budget; remove its architecture exception`,
        ).toBeGreaterThan(contract.default_module_max_bytes)
      }
    }
  })
})
