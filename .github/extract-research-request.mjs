import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'research.ts')
const requestPath = path.join(root, 'src', 'research-request.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(requestPath)) throw new Error('src/research-request.ts already exists')

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const file = program.getSourceFile(sourcePath)
if (!file) throw new Error('TypeScript program did not load src/research.ts')
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

const excludedIndexes = new Set()
for (const info of infos) {
  const joined = info.names.join(' ')
  const text = info.text
  if (
    /(tool|plugin|apply|install|dispose|effect)/i.test(joined)
    || text.includes('ctx.plugin')
    || text.includes('ctx.effect')
    || text.includes('new Tool')
    || text.includes('.tool(')
  ) {
    excludedIndexes.add(info.index)
  }
}

const score = (info) => {
  const joined = info.names.join(' ')
  if (/(normalize|normalise|validat|request|input)/i.test(joined)) return 140
  if (/(schema|claim|domain|date|option|config)/i.test(joined)) return 90
  if (/(lane)/i.test(joined) && info.typeOnly) return 70
  if (!info.exported && ts.isFunctionDeclaration(info.statement)) return 25
  if (info.typeOnly) return 15
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
  .filter((info) => !excludedIndexes.has(info.index) && score(info) >= 140)
  .map((info) => info.index)
if (seedIndexes.length === 0) fail('could not identify research request normalization declarations')
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
  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  if (externalDependencies.size > 0) {
    fail(`request module has unresolved research.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
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
  const requestText = `/**\n * Research request schema, validation, and normalization boundary.\n *\n * This module must not perform network access, provider calls, lane execution, aggregation,\n * or Harness lifecycle registration.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
    boundaryText += `\nimport { ${importParts.join(', ')} } from './research-request.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './research-request.js'\n`
  }
  const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
  edits.push({ start: importEnd, end: importEnd, text: boundaryText })
  edits.sort((left, right) => right.start - left.start)
  let researchText = source
  for (const edit of edits) {
    researchText = researchText.slice(0, edit.start) + edit.text + researchText.slice(edit.end)
  }
  researchText = researchText.replace(/\n{4,}/g, '\n\n\n')
  return {
    researchText,
    requestText,
    researchBytes: Buffer.byteLength(researchText),
    requestBytes: Buffer.byteLength(requestText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.requestBytes > 20_000) {
  fail(`initial request normalization closure exceeds the default budget: ${result.requestBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !excludedIndexes.has(info.index) && score(info) >= 70)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (originalBytes - result.researchBytes >= 8_000) break
  const trial = closure([...moved, candidate.index])
  const trialResult = build(trial)
  if (trialResult.requestBytes <= 19_500) {
    moved = trial
    result = trialResult
  }
}

if (result.requestBytes > 20_000) {
  fail(`research request module exceeds the default budget: ${result.requestBytes}`)
}
if (result.requestBytes < 4_000) {
  fail(`research request extraction is too small to justify a module: ${result.requestBytes}`)
}
if (originalBytes - result.researchBytes < 6_000) {
  fail(`research.ts shrank by fewer than 6,000 bytes: ${originalBytes} -> ${result.researchBytes}`)
}
if (result.researchBytes >= originalBytes) fail('research.ts did not shrink')
if (result.requestText.includes("from './research.js'")) fail('research request module would create a source cycle')
if (/fetch\s*\(|provider|pageFetch|ctx\.effect|new Tool/.test(result.requestText)) {
  fail('research request module contains network, provider, or Harness lifecycle behavior')
}

fs.writeFileSync(sourcePath, result.researchText)
fs.writeFileSync(requestPath, result.requestText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const harness = architecture.layers.find((layer) => layer.name === 'harness')
if (!harness) fail('architecture has no harness layer')
if (harness.files.includes('src/research-request.ts')) fail('research request module is already classified')
harness.files.push('src/research-request.ts')
harness.files.sort()
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
const itemStart = docs.indexOf('2. **Research request normalization')
const itemEnd = docs.indexOf('\n3. **', itemStart)
if (itemStart < 0 || itemEnd < 0) {
  fail('could not locate the research request normalization decomposition item')
}
const newItem = `2. **Research request normalization — complete.** Model-facing request schemas, fail-closed validation, normalized claim/lane inputs, domain constraints, and date-context preparation now live in the independently bounded \`research-request.ts\` module. Research lane execution is the next staged extraction; provider, fetch, aggregation, and presentation behavior remain unchanged.`
docs = docs.slice(0, itemStart) + newItem + docs.slice(itemEnd)
const marker = 'Research request normalization now lives in `research-request.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The new module is ${result.requestBytes.toLocaleString('en-US')} bytes and performs no provider, network, aggregation, presentation, or Harness lifecycle work. \`research.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.researchBytes.toLocaleString('en-US')} bytes; its existing growth stop remains until lane execution and aggregation are separated.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Research request schemas, validation, and normalized claim/lane inputs now live in `research-request.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; the module has no provider, network, aggregation, presentation, or Harness lifecycle behavior.\n- \`research.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.researchBytes.toLocaleString('en-US')} bytes while preserving tool schemas, request errors, concurrency, source limits, and the frozen offline result; lane execution remains the next extraction.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  research_before_bytes: originalBytes,
  research_after_bytes: result.researchBytes,
  request_module_bytes: result.requestBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
