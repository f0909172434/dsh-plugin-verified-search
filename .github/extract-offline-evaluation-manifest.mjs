import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'offline-evaluation.ts')
const manifestPath = path.join(root, 'src', 'offline-evaluation-manifest.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(manifestPath)) throw new Error('src/offline-evaluation-manifest.ts already exists')

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const file = program.getSourceFile(sourcePath)
if (!file) throw new Error('TypeScript program did not load src/offline-evaluation.ts')
const checker = program.getTypeChecker()

const fail = (message) => {
  throw new Error(message)
}

const imports = [...file.statements].filter(ts.isImportDeclaration)
const declarations = [...file.statements].filter((statement) => !ts.isImportDeclaration(statement))

const declarationNames = (statement) => {
  if (
    ts.isFunctionDeclaration(statement)
    || ts.isClassDeclaration(statement)
    || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : []
  }
  if (ts.isVariableStatement(statement)) {
    const names = []
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
    }
    return names
  }
  return []
}
const hasExport = (statement) => Boolean(
  statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
)
const typeOnlyStatement = (statement) => (
  ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
)

const infos = declarations
  .map((statement, index) => ({
    index,
    statement,
    names: declarationNames(statement),
    exported: hasExport(statement),
    typeOnly: typeOnlyStatement(statement),
    text: source.slice(statement.getStart(file), statement.end),
  }))
  .filter((info) => info.names.length > 0)
const statementToInfo = new Map(infos.map((info) => [info.statement, info]))
const nameToInfo = new Map()
for (const info of infos) {
  for (const name of info.names) {
    if (nameToInfo.has(name)) fail(`duplicate top-level declaration name: ${name}`)
    nameToInfo.set(name, info)
  }
}

const topLevelStatement = (node) => {
  let current = node
  while (current.parent && current.parent !== file) current = current.parent
  return current.parent === file ? current : undefined
}

const dependencies = new Map(infos.map((info) => [info.index, new Set()]))
const importedNamesByInfo = new Map(infos.map((info) => [info.index, new Set()]))
for (const info of infos) {
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node)
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = checker.getAliasedSymbol(symbol)
        } catch {
          // Keep unresolved aliases local to this conservative extraction.
        }
      }
      for (const declaration of symbol?.declarations ?? []) {
        const top = topLevelStatement(declaration)
        const dependencyInfo = top ? statementToInfo.get(top) : undefined
        if (dependencyInfo && dependencyInfo.index !== info.index) {
          dependencies.get(info.index).add(dependencyInfo.index)
        }
        if (
          ts.isImportSpecifier(declaration)
          || ts.isImportClause(declaration)
          || ts.isNamespaceImport(declaration)
        ) {
          importedNamesByInfo.get(info.index).add(node.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(info.statement, visit)
}
const reverseDependencies = new Map(infos.map((info) => [info.index, new Set()]))
for (const [sourceIndex, targets] of dependencies) {
  for (const target of targets) reverseDependencies.get(target).add(sourceIndex)
}

const highLevelExecution = (info) => {
  if (!ts.isFunctionDeclaration(info.statement) && !ts.isClassDeclaration(info.statement)) return false
  const joined = info.names.join(' ')
  return /(execute|dispatch|evaluateCase|runCase|runOperation|applyOperation|compareResult|assertResult|evaluateOffline)/i.test(joined)
}
const manifestMarkers = [
  'manifest',
  'corpus',
  'suite',
  'readFile',
  'JSON.parse',
  'createHash',
  'sha256',
  'integrity',
  'schema',
  'caseFile',
]
const manifestSeed = (info) => {
  if (highLevelExecution(info)) return false
  const joined = info.names.join(' ')
  const named = /(manifest|corpus|suite|load|parse|validate|integrity|hash|sha|readJson|caseFile)/i.test(joined)
  const markers = manifestMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length
  return (
    (ts.isFunctionDeclaration(info.statement) || ts.isClassDeclaration(info.statement))
    && named
    && markers >= 1
  )
}
const score = (info) => {
  const joined = info.names.join(' ')
  if (manifestSeed(info)) return 160
  if (highLevelExecution(info)) return 0
  if (/(manifest|corpus|suite|integrity|hash|sha|schema|caseFile)/i.test(joined)) return 110
  if (manifestMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length >= 2) return 80
  if (info.typeOnly) return 25
  if (!info.exported && ts.isFunctionDeclaration(info.statement)) return 15
  return 0
}

const closure = (seedIndexes) => {
  const moved = new Set(seedIndexes)
  const queue = [...seedIndexes]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const dependency of dependencies.get(current)) {
      if (!moved.has(dependency)) {
        moved.add(dependency)
        queue.push(dependency)
      }
    }
  }
  return moved
}

let seedIndexes = infos.filter(manifestSeed).map((info) => info.index)
if (seedIndexes.length === 0) {
  seedIndexes = infos.filter((info) => score(info) >= 110).map((info) => info.index)
}
if (seedIndexes.length === 0) fail('could not identify offline manifest and corpus integrity declarations')
let moved = closure(seedIndexes)

const renderFilteredImports = (usedNames) => {
  const rendered = []
  for (const declaration of imports) {
    const clause = declaration.importClause
    if (!clause) continue
    const moduleName = declaration.moduleSpecifier.text
    const defaultName = clause.name?.text
    const defaultUsed = defaultName ? usedNames.has(defaultName) : false
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (usedNames.has(bindings.name.text)) {
        rendered.push(`import ${clause.isTypeOnly ? 'type ' : ''}* as ${bindings.name.text} from '${moduleName}'`)
      }
      continue
    }
    const named = []
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!usedNames.has(element.name.text)) continue
        const imported = element.propertyName?.text
        named.push(`${element.isTypeOnly ? 'type ' : ''}${imported ? `${imported} as ` : ''}${element.name.text}`)
      }
    }
    if (!defaultUsed && named.length === 0) continue
    let specifier = ''
    if (defaultUsed) specifier += defaultName
    if (named.length > 0) specifier += `${specifier ? ', ' : ''}{ ${named.join(', ')} }`
    rendered.push(`import ${clause.isTypeOnly ? 'type ' : ''}${specifier} from '${moduleName}'`)
  }
  return rendered.join('\n')
}

const renderStatement = (info, exportNeeded) => {
  const leading = source.slice(info.statement.getFullStart(), info.statement.getStart(file))
  let text = info.text
  if (exportNeeded && !info.exported) text = `export ${text}`
  return leading + text
}

const build = (movedIndexes) => {
  const movedInfos = infos.filter((info) => movedIndexes.has(info.index))
  const executionMoved = movedInfos.filter(highLevelExecution)
  if (executionMoved.length > 0) {
    fail(`manifest closure pulled operation execution declarations: ${executionMoved.flatMap((info) => info.names).join(', ')}`)
  }

  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  if (externalDependencies.size > 0) {
    fail(`manifest module has unresolved offline-evaluation.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
  }

  const boundaryNames = new Set()
  const locallyUsedBoundaryNames = new Set()
  const originallyExportedNames = new Set()
  for (const info of movedInfos) {
    if (info.exported) {
      for (const name of info.names) {
        boundaryNames.add(name)
        originallyExportedNames.add(name)
      }
    }
    const callers = reverseDependencies.get(info.index)
    if ([...callers].some((caller) => !movedIndexes.has(caller))) {
      for (const name of info.names) {
        boundaryNames.add(name)
        locallyUsedBoundaryNames.add(name)
      }
    }
  }

  const usedImportedNames = new Set()
  for (const info of movedInfos) {
    for (const name of importedNamesByInfo.get(info.index)) usedImportedNames.add(name)
  }
  const filteredImports = renderFilteredImports(usedImportedNames)
  const movedBody = movedInfos
    .sort((left, right) => left.statement.getFullStart() - right.statement.getFullStart())
    .map((info) => renderStatement(info, info.names.some((name) => boundaryNames.has(name))))
    .join('')
  const manifestText = `/**\n * Frozen offline corpus manifest, suite parsing, and integrity verification.\n *\n * This module loads and validates immutable corpus files and hash commitments. Capability\n * operation dispatch, expected-result comparison, report assembly, and CLI output remain in\n * offline-evaluation.ts.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

  const edits = movedInfos.map((info) => ({
    start: info.statement.getFullStart(),
    end: info.statement.end,
    text: source.slice(info.statement.getFullStart(), info.statement.getStart(file)),
  }))
  const localRuntime = []
  const localTypes = []
  for (const name of [...locallyUsedBoundaryNames].sort()) {
    const info = nameToInfo.get(name)
    if (info?.typeOnly) localTypes.push(name)
    else localRuntime.push(name)
  }
  const exportedRuntime = []
  const exportedTypes = []
  for (const name of [...originallyExportedNames].sort()) {
    const info = nameToInfo.get(name)
    if (info?.typeOnly) exportedTypes.push(name)
    else exportedRuntime.push(name)
  }
  const importParts = [...localRuntime, ...localTypes.map((name) => `type ${name}`)]
  const exportParts = [...exportedRuntime, ...exportedTypes.map((name) => `type ${name}`)]
  let boundaryText = ''
  if (importParts.length > 0) {
    boundaryText += `\nimport { ${importParts.join(', ')} } from './offline-evaluation-manifest.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './offline-evaluation-manifest.js'\n`
  }
  const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
  edits.push({ start: importEnd, end: importEnd, text: boundaryText })
  edits.sort((left, right) => right.start - left.start)
  let evaluatorText = source
  for (const edit of edits) {
    evaluatorText = evaluatorText.slice(0, edit.start) + edit.text + evaluatorText.slice(edit.end)
  }
  evaluatorText = evaluatorText.replace(/\n{4,}/g, '\n\n\n')
  return {
    evaluatorText,
    manifestText,
    evaluatorBytes: Buffer.byteLength(evaluatorText),
    manifestBytes: Buffer.byteLength(manifestText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.manifestBytes > 20_000) {
  fail(`initial manifest/integrity closure exceeds the default budget: ${result.manifestBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !highLevelExecution(info) && score(info) >= 80)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (result.evaluatorBytes <= 19_500) break
  const trial = closure([...moved, candidate.index])
  try {
    const trialResult = build(trial)
    if (trialResult.manifestBytes <= 19_500) {
      moved = trial
      result = trialResult
    }
  } catch {
    // Keep capability execution and expected-result comparison in offline-evaluation.ts.
  }
}

if (result.manifestBytes > 20_000) fail(`offline manifest module exceeds the default budget: ${result.manifestBytes}`)
if (result.manifestBytes < 3_000) fail(`offline manifest extraction is too small: ${result.manifestBytes}`)
if (result.evaluatorBytes > 20_000) fail(`offline-evaluation.ts remains above the default budget: ${result.evaluatorBytes}`)
if (originalBytes - result.evaluatorBytes < 4_000) {
  fail(`offline-evaluation.ts shrank by fewer than 4,000 bytes: ${originalBytes} -> ${result.evaluatorBytes}`)
}
if (result.manifestText.includes("from './offline-evaluation.js'")) fail('manifest module would create a source cycle')
for (const moduleName of (
  './domains.js',
  './json-selection.js',
  './json-numeric-selection.js',
  './json-projection.js',
)) {
  if (result.manifestText.includes(`from '${moduleName}'`)) {
    fail(`manifest module imports capability execution module ${moduleName}`)
  }
}
if (/(selectJson|projectJson|filterByAllowedDomains|selectNumeric|switch\s*\([^)]*operation)/i.test(result.manifestText)) {
  fail('manifest module contains capability operation dispatch')
}

fs.writeFileSync(sourcePath, result.evaluatorText)
fs.writeFileSync(manifestPath, result.manifestText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const engine = architecture.layers.find((layer) => layer.name === 'engine')
if (!engine) fail('architecture has no engine layer')
if (engine.files.includes('src/offline-evaluation-manifest.ts')) fail('offline manifest module is already classified')
engine.files.push('src/offline-evaluation-manifest.ts')
engine.files.sort()
architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/offline-evaluation.ts')
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
docs = docs
  .split('\n')
  .filter((line) => !line.includes('`offline-evaluation.ts`'))
  .join('\n')
const itemStart = docs.indexOf('6. **Offline evaluator parsing')
if (itemStart < 0) fail('could not locate the offline evaluator parsing decomposition item')
let itemEnd = docs.indexOf('\n\nOnly one', itemStart)
if (itemEnd < 0) itemEnd = docs.indexOf('\n## ', itemStart)
if (itemEnd < 0) itemEnd = docs.length
const newItem = `6. **Offline evaluator parsing — complete.** Frozen corpus manifest/suite parsing, path and hash integrity, and immutable case loading now live in the independently bounded \`offline-evaluation-manifest.ts\` module. Capability dispatch, exact expected-result comparison, and report assembly remain in \`offline-evaluation.ts\`. Both fit the default budget, completing the first architecture-decomposition sequence.`
docs = docs.slice(0, itemStart) + newItem + docs.slice(itemEnd)
const marker = 'Frozen offline manifest and corpus integrity now live in `offline-evaluation-manifest.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The parser/integrity module is ${result.manifestBytes.toLocaleString('en-US')} bytes and the capability dispatcher/report builder is ${result.evaluatorBytes.toLocaleString('en-US')} bytes. Both fit the default 20,000-byte budget, removing the offline-evaluator growth stop and leaving ${architecture.size_exceptions.length}. The frozen 42-case manifest, per-file hashes, exact result digest, operation semantics, and CLI report remain unchanged.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Frozen offline manifest/suite parsing and path/hash integrity now live in `offline-evaluation-manifest.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; capability dispatch, expected-result comparison, and report assembly remain in \`offline-evaluation.ts\`.\n- The ${result.manifestBytes.toLocaleString('en-US')}-byte parser/integrity module and ${result.evaluatorBytes.toLocaleString('en-US')}-byte dispatcher both fit the default budget, removing the temporary offline-evaluator exception while preserving the 42-case corpus and result digest.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  offline_evaluation_before_bytes: originalBytes,
  dispatcher_bytes: result.evaluatorBytes,
  manifest_module_bytes: result.manifestBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
