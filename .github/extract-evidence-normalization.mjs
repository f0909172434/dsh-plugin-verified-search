import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'evidence.ts')
const normalizationPath = path.join(root, 'src', 'evidence-normalization.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(normalizationPath)) throw new Error('src/evidence-normalization.ts already exists')

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const file = program.getSourceFile(sourcePath)
if (!file) throw new Error('TypeScript program did not load src/evidence.ts')
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

const highLevelName = (info) => /(claim|attribut|excerpt|hash|digest|evidenceRecord|buildEvidence|createEvidence)/i.test(info.names.join(' '))
const normalizationMarkers = [
  'html',
  'entity',
  'whitespace',
  'normalize',
  'decode',
  'strip',
  'text',
  'tag',
  'characterReference',
  'numericReference',
]
const normalizationSeed = (info) => {
  if (highLevelName(info)) return false
  const joined = info.names.join(' ')
  const named = /(normalize|decode|entity|html|whitespace|strip|sanitize|plainText|textContent|scanTag)/i.test(joined)
  const bodyMarkers = normalizationMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length
  return (
    (ts.isFunctionDeclaration(info.statement) || ts.isClassDeclaration(info.statement))
    && (named || bodyMarkers >= 3)
  )
}
const score = (info) => {
  const joined = info.names.join(' ')
  if (normalizationSeed(info)) return 160
  if (highLevelName(info)) return 0
  if (/(entity|html|whitespace|character|tag|text)/i.test(joined)) return 100
  if (normalizationMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length >= 2) return 80
  if (!info.exported && ts.isFunctionDeclaration(info.statement)) return 20
  if (info.typeOnly) return 15
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

let seedIndexes = infos.filter(normalizationSeed).map((info) => info.index)
if (seedIndexes.length === 0) {
  seedIndexes = infos.filter((info) => score(info) >= 100).map((info) => info.index)
}
if (seedIndexes.length === 0) fail('could not identify evidence normalization declarations')
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
  const highLevelMoved = movedInfos.filter(highLevelName)
  if (highLevelMoved.length > 0) {
    fail(`normalization closure pulled claim/excerpt/hash declarations: ${highLevelMoved.flatMap((info) => info.names).join(', ')}`)
  }

  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  if (externalDependencies.size > 0) {
    fail(`normalization module has unresolved evidence.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
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
  const normalizationText = `/**\n * Byte-stable HTML and text normalization for evidence inputs.\n *\n * This module owns entity decoding, tag/text scanning, and whitespace normalization. Claim\n * attribution, excerpt construction, source ordering, and content hashing remain in evidence.ts.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
    boundaryText += `\nimport { ${importParts.join(', ')} } from './evidence-normalization.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './evidence-normalization.js'\n`
  }
  const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
  edits.push({ start: importEnd, end: importEnd, text: boundaryText })
  edits.sort((left, right) => right.start - left.start)
  let evidenceText = source
  for (const edit of edits) {
    evidenceText = evidenceText.slice(0, edit.start) + edit.text + evidenceText.slice(edit.end)
  }
  evidenceText = evidenceText.replace(/\n{4,}/g, '\n\n\n')
  return {
    evidenceText,
    normalizationText,
    evidenceBytes: Buffer.byteLength(evidenceText),
    normalizationBytes: Buffer.byteLength(normalizationText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.normalizationBytes > 20_000) {
  fail(`initial normalization closure exceeds the default budget: ${result.normalizationBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !highLevelName(info) && score(info) >= 80)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (originalBytes - result.evidenceBytes >= 8_000) break
  const trial = closure([...moved, candidate.index])
  try {
    const trialResult = build(trial)
    if (trialResult.normalizationBytes <= 19_500) {
      moved = trial
      result = trialResult
    }
  } catch {
    // Keep high-level claim/excerpt/hash behavior in evidence.ts.
  }
}

if (result.normalizationBytes > 20_000) {
  fail(`evidence normalization module exceeds the default budget: ${result.normalizationBytes}`)
}
if (result.normalizationBytes < 4_000) {
  fail(`evidence normalization extraction is too small to justify a module: ${result.normalizationBytes}`)
}
if (originalBytes - result.evidenceBytes < 6_000) {
  fail(`evidence.ts shrank by fewer than 6,000 bytes: ${originalBytes} -> ${result.evidenceBytes}`)
}
if (result.evidenceBytes >= originalBytes) fail('evidence.ts did not shrink')
if (result.normalizationText.includes("from './evidence.js'")) fail('normalization module would create a source cycle')
if (/createHash\s*\(|sha256|claimAttribut|buildExcerpt|selectExcerpt/i.test(result.normalizationText)) {
  fail('normalization module contains hashing, claim attribution, or excerpt construction')
}

fs.writeFileSync(sourcePath, result.evidenceText)
fs.writeFileSync(normalizationPath, result.normalizationText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const engine = architecture.layers.find((layer) => layer.name === 'engine')
if (!engine) fail('architecture has no engine layer')
if (engine.files.includes('src/evidence-normalization.ts')) fail('evidence normalization is already classified')
engine.files.push('src/evidence-normalization.ts')
engine.files.sort()
if (result.evidenceBytes <= architecture.default_module_max_bytes) {
  architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/evidence.ts')
}
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
if (result.evidenceBytes <= architecture.default_module_max_bytes) {
  docs = docs
    .split('\n')
    .filter((line) => !line.includes('`evidence.ts`'))
    .join('\n')
}
const itemStart = docs.indexOf('4. **Evidence normalization')
const itemEnd = docs.indexOf('\n5. **', itemStart)
if (itemStart < 0 || itemEnd < 0) {
  fail('could not locate the evidence normalization decomposition item')
}
const newItem = `4. **Evidence normalization — complete.** Byte-stable HTML entity decoding, tag/text scanning, and whitespace normalization now live in the independently bounded \`evidence-normalization.ts\` module. Claim attribution, source ordering, retained excerpt construction, and content hashing remain in \`evidence.ts\`; network policy and transport are the next staged extraction.`
docs = docs.slice(0, itemStart) + newItem + docs.slice(itemEnd)
const marker = 'Byte-stable HTML and text normalization now lives in `evidence-normalization.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const exceptionState = result.evidenceBytes <= architecture.default_module_max_bytes
    ? `Both modules fit the default budget, so the evidence growth stop is removed and ${architecture.size_exceptions.length} remain.`
    : `The ${result.evidenceBytes.toLocaleString('en-US')}-byte attribution/excerpt module retains its growth stop; ${architecture.size_exceptions.length} remain.`
  const paragraph = `\n${marker}. The normalization module is ${result.normalizationBytes.toLocaleString('en-US')} bytes and contains no content hashing, claim attribution, or excerpt selection. \`evidence.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.evidenceBytes.toLocaleString('en-US')} bytes while preserving content hashes, retained excerpt bytes, source order, and attribution. ${exceptionState}\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Byte-stable HTML entity decoding, tag/text scanning, and whitespace normalization now live in `evidence-normalization.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const exceptionText = result.evidenceBytes <= architecture.default_module_max_bytes
    ? 'Both evidence modules fit the default budget and the temporary evidence exception is removed.'
    : `The ${result.evidenceBytes.toLocaleString('en-US')}-byte attribution/excerpt module retains its existing growth stop.`
  const entry = `${changelogMarker}; claim attribution, retained excerpts, source order, and content hashing remain in \`evidence.ts\`.\n- \`evidence.ts\` shrinks from ${originalBytes.toLocaleString('en-US')} to ${result.evidenceBytes.toLocaleString('en-US')} bytes and normalization occupies ${result.normalizationBytes.toLocaleString('en-US')} bytes. ${exceptionText}\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  evidence_before_bytes: originalBytes,
  evidence_after_bytes: result.evidenceBytes,
  normalization_module_bytes: result.normalizationBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
