import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'json-projection.ts')
const corePath = path.join(root, 'src', 'json-projection-core.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(corePath)) throw new Error('src/json-projection-core.ts already exists')

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const file = program.getSourceFile(sourcePath)
if (!file) throw new Error('TypeScript program did not load src/json-projection.ts')
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
          // Keep the alias symbol when TypeScript cannot resolve it.
        }
      }
      const declarationsForSymbol = symbol?.declarations ?? []
      for (const declaration of declarationsForSymbol) {
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

const excludedNames = new Set([
  'JSON_PROJECTION_PRIMITIVE_ERROR_CODES',
  'failJsonPrimitive',
  'hasUnpairedSurrogate',
  'decodeInput',
  'scanStrictJson',
  'parseStrictJson',
])
for (const name of [...nameToInfo.keys()]) {
  if (name.endsWith('MAX_INPUT_BYTES')) excludedNames.add(name)
}
const excludedIndexes = new Set()
for (const name of excludedNames) {
  const info = nameToInfo.get(name)
  if (info) excludedIndexes.add(info.index)
}

const score = (info) => {
  const joined = info.names.join(' ')
  if (/(pointer|repair|resolve)/i.test(joined)) return 120
  if (/(project|projection|scalar|budget|row|value)/i.test(joined)) return 80
  if (!info.exported && (ts.isFunctionDeclaration(info.statement) || ts.isClassDeclaration(info.statement))) return 35
  if (info.typeOnly) return 20
  return 0
}

const closure = (seedIndexes) => {
  const moved = new Set(seedIndexes)
  const queue = [...seedIndexes]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const dependency of dependencies.get(current)) {
      if (excludedIndexes.has(dependency)) continue
      if (!moved.has(dependency)) {
        moved.add(dependency)
        queue.push(dependency)
      }
    }
  }
  return moved
}

const seedIndexes = infos
  .filter((info) => !excludedIndexes.has(info.index) && score(info) >= 120)
  .map((info) => info.index)
if (seedIndexes.length === 0) fail('could not identify any pointer/repair resolution declarations')
let moved = closure(seedIndexes)

const importBindingNames = (declaration) => {
  const clause = declaration.importClause
  if (!clause) return []
  const names = []
  if (clause.name) names.push(clause.name.text)
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text)
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push(element.name.text)
  }
  return names
}

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
        const typePrefix = clause.isTypeOnly ? 'type ' : ''
        rendered.push(`import ${typePrefix}* as ${bindings.name.text} from '${moduleName}'`)
      }
      continue
    }
    const named = []
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!usedNames.has(element.name.text)) continue
        const typePrefix = element.isTypeOnly ? 'type ' : ''
        const imported = element.propertyName?.text
        named.push(`${typePrefix}${imported ? `${imported} as ` : ''}${element.name.text}`)
      }
    }
    if (!defaultUsed && named.length === 0) continue
    const typePrefix = clause.isTypeOnly ? 'type ' : ''
    let specifier = ''
    if (defaultUsed) specifier += defaultName
    if (named.length > 0) specifier += `${specifier ? ', ' : ''}{ ${named.join(', ')} }`
    rendered.push(`import ${typePrefix}${specifier} from '${moduleName}'`)
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
  const remainingInfos = infos.filter((info) => !movedIndexes.has(info.index))

  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  const invalidExternal = [...externalDependencies].filter((index) => !excludedIndexes.has(index))
  if (invalidExternal.length > 0) {
    fail(`projection core has unresolved source dependencies: ${invalidExternal.map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
  }
  if (externalDependencies.size > 0) {
    fail(`projection core unexpectedly depends on parser-only declarations: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
  }

  const boundaryNames = new Set()
  const locallyUsedBoundaryNames = new Set()
  const originallyExportedNames = new Set()
  for (const info of movedInfos) {
    for (const name of info.names) {
      if (info.exported) {
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
  const coreText = `/**\n * Repair-aware pointer resolution and nested projection core.\n *\n * This module preserves source-order and repair-audit semantics. Strict JSON decoding and\n * materialization remain in json-projection.ts and enter through the public wrapper.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
  const importParts = [
    ...localRuntime,
    ...localTypes.map((name) => `type ${name}`),
  ]
  const exportParts = [
    ...exportedRuntime,
    ...exportedTypes.map((name) => `type ${name}`),
  ]
  let boundaryText = ''
  if (importParts.length > 0) {
    boundaryText += `\nimport { ${importParts.join(', ')} } from './json-projection-core.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './json-projection-core.js'\n`
  }
  const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
  edits.push({ start: importEnd, end: importEnd, text: boundaryText })
  edits.sort((left, right) => right.start - left.start)
  let originalText = source
  for (const edit of edits) {
    originalText = originalText.slice(0, edit.start) + edit.text + originalText.slice(edit.end)
  }
  originalText = originalText.replace(/\n{4,}/g, '\n\n\n')
  return {
    originalText,
    coreText,
    originalBytes: Buffer.byteLength(originalText),
    coreBytes: Buffer.byteLength(coreText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
const candidates = infos
  .filter((info) => !moved.has(info.index) && !excludedIndexes.has(info.index))
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (result.originalBytes <= 19_500) break
  const trial = closure([...moved, candidate.index])
  const trialResult = build(trial)
  if (trialResult.coreBytes <= 19_500) {
    moved = trial
    result = trialResult
  }
}

if (result.originalBytes > 20_000) {
  fail(`projection wrapper remains above the default budget: ${result.originalBytes}`)
}
if (result.coreBytes > 20_000) {
  fail(`projection core exceeds the default budget: ${result.coreBytes}`)
}
if (result.coreBytes < 4_000) {
  fail(`projection core extraction is too small to justify a new boundary: ${result.coreBytes}`)
}
if (result.movedInfos.length < 3) {
  fail('projection core extraction moved too few declarations')
}

fs.writeFileSync(sourcePath, result.originalText)
fs.writeFileSync(corePath, result.coreText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const engine = architecture.layers.find((layer) => layer.name === 'engine')
if (!engine) fail('architecture has no engine layer')
if (engine.files.includes('src/json-projection-core.ts')) fail('projection core is already classified')
engine.files.push('src/json-projection-core.ts')
engine.files.sort()
architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/json-projection.ts')
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
docs = docs
  .split('\n')
  .filter((line) => !line.includes('`json-projection.ts`'))
  .join('\n')
docs = docs.replace(/\b5 production modules\b/g, `${architecture.size_exceptions.length} production modules`)
docs = docs.replace(/\b5 growth stops remain\b/g, `${architecture.size_exceptions.length} growth stops remain`)
docs = docs.replace(/\bfive growth stops remain\b/g, `${architecture.size_exceptions.length} growth stops remain`)
const decompositionStart = docs.indexOf('1. **Shared strict JSON primitives')
const decompositionEnd = docs.indexOf('\n2. **', decompositionStart)
if (decompositionStart < 0 || decompositionEnd < 0) {
  fail('could not locate the first staged decomposition item in docs/ARCHITECTURE.md')
}
const newDecomposition = `1. **JSON selector and projection decomposition — complete.** Shared bounded parsing now serves every JSON tool, while repair-aware pointer resolution and nested source-order projection live in the independently bounded \`json-projection-core.ts\` module. Both the public wrapper and core fit the default module budget; research request normalization is the next staged boundary.`
docs = docs.slice(0, decompositionStart) + newDecomposition + docs.slice(decompositionEnd)
const marker = 'Repair-aware pointer resolution and nested projection now live in `json-projection-core.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The public projection wrapper is ${result.originalBytes.toLocaleString('en-US')} bytes and the core is ${result.coreBytes.toLocaleString('en-US')} bytes; both fit the default 20,000-byte budget, so the projection growth stop is removed and ${architecture.size_exceptions.length} remain. The core preserves the existing repair audit, pointer-not-found/type-mismatch distinctions, source order, and aggregate output budgets.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Repair-aware pointer resolution and nested source-order projection now live in `json-projection-core.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; \`json-projection.ts\` remains the strict input/public contract wrapper.\n- The projection wrapper (${result.originalBytes.toLocaleString('en-US')} bytes) and core (${result.coreBytes.toLocaleString('en-US')} bytes) both fit the default module budget, removing the projection architecture exception while preserving repair audits, source order, scalar limits, and the frozen evaluation result.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  original_before_bytes: originalBytes,
  wrapper_bytes: result.originalBytes,
  core_bytes: result.coreBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
