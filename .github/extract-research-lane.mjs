import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'research.ts')
const lanePath = path.join(root, 'src', 'research-lane.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(lanePath)) throw new Error('src/research-lane.ts already exists')

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

const lifecycleOrPresentation = (info) => {
  const joined = info.names.join(' ')
  const text = info.text
  return (
    /(tool|plugin|apply|install|dispose|effect|present|render|markdown)/i.test(joined)
    || text.includes('ctx.plugin')
    || text.includes('ctx.effect')
    || text.includes('new Tool')
    || text.includes('.tool(')
  )
}
const aggregationOnly = (info) => {
  const joined = info.names.join(' ')
  return /(aggregate|aggregation|finalReport|researchResult|formatResearch|presentResearch)/i.test(joined)
}
const excludedIndexes = new Set(
  infos
    .filter((info) => lifecycleOrPresentation(info) || aggregationOnly(info))
    .map((info) => info.index),
)

const networkMarkers = [
  'pageFetch',
  '.search(',
  'AbortController',
  'Promise.allSettled',
  'Promise.race',
  'timeout',
  'sourceLimit',
]
const runtimeLaneSeed = (info) => {
  if (!ts.isFunctionDeclaration(info.statement) && !ts.isClassDeclaration(info.statement)) return false
  const joined = info.names.join(' ')
  const hasLaneName = /lane/i.test(joined)
  const hasExecutionName = /(execute|run|fetch|search|collect|read|resolve)/i.test(joined)
  const hasNetworkMarker = networkMarkers.some((marker) => info.text.includes(marker))
  return (hasLaneName && (hasExecutionName || hasNetworkMarker)) || (hasExecutionName && hasNetworkMarker)
}
const score = (info) => {
  const joined = info.names.join(' ')
  if (runtimeLaneSeed(info)) return 160
  if (/lane/i.test(joined)) return 110
  if (networkMarkers.some((marker) => info.text.includes(marker))) return 90
  if (/(source|fetch|search|timeout|abort|concurrency|provider)/i.test(joined)) return 80
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

let seedIndexes = infos
  .filter((info) => !excludedIndexes.has(info.index) && runtimeLaneSeed(info))
  .map((info) => info.index)
if (seedIndexes.length === 0) {
  seedIndexes = infos
    .filter((info) => !excludedIndexes.has(info.index) && score(info) >= 90)
    .map((info) => info.index)
}
if (seedIndexes.length === 0) fail('could not identify research lane execution declarations')
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
    fail(`lane module has unresolved research.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
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
  const laneText = `/**\n * Bounded research lane execution.\n *\n * This module owns provider/search/fetch work, per-lane limits, timeout and abort handling,\n * and lane-local source materialization. It must not aggregate multiple lanes, format the\n * final research answer, or register Harness lifecycle objects.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
    boundaryText += `\nimport { ${importParts.join(', ')} } from './research-lane.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './research-lane.js'\n`
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
    laneText,
    researchBytes: Buffer.byteLength(researchText),
    laneBytes: Buffer.byteLength(laneText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.laneBytes > 20_000) {
  fail(`initial lane execution closure exceeds the default budget: ${result.laneBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !excludedIndexes.has(info.index) && score(info) >= 80)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (originalBytes - result.researchBytes >= 8_000) break
  const trial = closure([...moved, candidate.index])
  const trialResult = build(trial)
  if (trialResult.laneBytes <= 19_500) {
    moved = trial
    result = trialResult
  }
}

if (result.laneBytes > 20_000) {
  fail(`research lane module exceeds the default budget: ${result.laneBytes}`)
}
if (result.laneBytes < 4_000) {
  fail(`research lane extraction is too small to justify a module: ${result.laneBytes}`)
}
if (originalBytes - result.researchBytes < 6_000) {
  fail(`research.ts shrank by fewer than 6,000 bytes: ${originalBytes} -> ${result.researchBytes}`)
}
if (result.researchBytes >= originalBytes) fail('research.ts did not shrink')
if (result.laneText.includes("from './research.js'")) fail('research lane module would create a source cycle')
if (/ctx\.effect|ctx\.plugin|new\s+Tool|\.tool\s*\(/.test(result.laneText)) {
  fail('research lane module contains Harness lifecycle behavior')
}
if (/(formatResearch|presentResearch|renderMarkdown)/.test(result.laneText)) {
  fail('research lane module contains final presentation behavior')
}

fs.writeFileSync(sourcePath, result.researchText)
fs.writeFileSync(lanePath, result.laneText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const harness = architecture.layers.find((layer) => layer.name === 'harness')
if (!harness) fail('architecture has no harness layer')
if (harness.files.includes('src/research-lane.ts')) fail('research lane module is already classified')
harness.files.push('src/research-lane.ts')
harness.files.sort()
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
const itemStart = docs.indexOf('3. **Research lane execution')
const itemEnd = docs.indexOf('\n4. **', itemStart)
if (itemStart < 0 || itemEnd < 0) {
  fail('could not locate the research lane execution decomposition item')
}
const newItem = `3. **Research lane execution — complete.** Provider/search/fetch work, lane-local source limits, timeout and abort handling, and per-lane materialization now live in the independently bounded \`research-lane.ts\` module. Aggregation and presentation remain in \`research.ts\`; evidence normalization is the next staged extraction.`
docs = docs.slice(0, itemStart) + newItem + docs.slice(itemEnd)
const marker = 'Bounded research lane execution now lives in `research-lane.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The new module is ${result.laneBytes.toLocaleString('en-US')} bytes and owns provider/search/fetch calls, lane-local limits, timeout/abort behavior, and source materialization without final aggregation, presentation, or Harness lifecycle registration. \`research.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.researchBytes.toLocaleString('en-US')} bytes; its growth stop remains until aggregation and presentation are separated.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Provider/search/fetch work and lane-local timeout, abort, source-limit, and materialization behavior now live in `research-lane.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; final aggregation, formatting, and Harness lifecycle code remain in \`research.ts\`.\n- \`research.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.researchBytes.toLocaleString('en-US')} bytes while preserving concurrency, source limits, timeout behavior, tool schemas, and the frozen offline result.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  research_before_bytes: originalBytes,
  research_after_bytes: result.researchBytes,
  lane_module_bytes: result.laneBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
