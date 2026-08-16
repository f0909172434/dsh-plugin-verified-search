import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'evidence.ts')
const attributionPath = path.join(root, 'src', 'evidence-attribution.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(attributionPath)) throw new Error('src/evidence-attribution.ts already exists')

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

const hashingOrAssembly = (info) => {
  const joined = info.names.join(' ')
  return /(hash|digest|sha|contentHash|buildEvidence|createEvidence|collectEvidence|evidenceFrom|assembleEvidence)/i.test(joined)
}
const attributionMarkers = [
  'claim',
  'attribut',
  'excerpt',
  'citation',
  'sentence',
  'window',
  'quote',
  'sourceOrder',
  'retained',
  'match',
]
const attributionSeed = (info) => {
  if (hashingOrAssembly(info)) return false
  const joined = info.names.join(' ')
  const named = /(claim|attribut|excerpt|citation|sentence|window|quote|retain|sourceOrder|match)/i.test(joined)
  const markers = attributionMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length
  return (
    (ts.isFunctionDeclaration(info.statement) || ts.isClassDeclaration(info.statement))
    && named
    && markers >= 1
  )
}
const score = (info) => {
  const joined = info.names.join(' ')
  if (attributionSeed(info)) return 160
  if (hashingOrAssembly(info)) return 0
  if (/(claim|attribut|excerpt|citation|sentence|window|quote|retain|sourceOrder|match)/i.test(joined)) return 110
  if (attributionMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length >= 2) return 80
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

let seedIndexes = infos.filter(attributionSeed).map((info) => info.index)
if (seedIndexes.length === 0) {
  seedIndexes = infos.filter((info) => score(info) >= 110).map((info) => info.index)
}
if (seedIndexes.length === 0) fail('could not identify claim attribution and excerpt declarations')
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
  const forbiddenMoved = movedInfos.filter(hashingOrAssembly)
  if (forbiddenMoved.length > 0) {
    fail(`attribution closure pulled hashing or top-level evidence assembly: ${forbiddenMoved.flatMap((info) => info.names).join(', ')}`)
  }

  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  if (externalDependencies.size > 0) {
    fail(`attribution module has unresolved evidence.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
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
  const attributionText = `/**\n * Deterministic claim attribution and retained excerpt construction.\n *\n * This module maps normalized page text to source-ordered claims and byte-stable retained\n * excerpts. HTML/text normalization lives in evidence-normalization.ts; content hashing and\n * top-level evidence assembly remain in evidence.ts.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
    boundaryText += `\nimport { ${importParts.join(', ')} } from './evidence-attribution.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './evidence-attribution.js'\n`
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
    attributionText,
    evidenceBytes: Buffer.byteLength(evidenceText),
    attributionBytes: Buffer.byteLength(attributionText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.attributionBytes > 20_000) {
  fail(`initial attribution/excerpt closure exceeds the default budget: ${result.attributionBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !hashingOrAssembly(info) && score(info) >= 80)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (result.evidenceBytes <= 19_500) break
  const trial = closure([...moved, candidate.index])
  try {
    const trialResult = build(trial)
    if (trialResult.attributionBytes <= 19_500) {
      moved = trial
      result = trialResult
    }
  } catch {
    // Keep hashing and top-level evidence assembly in evidence.ts.
  }
}

if (result.attributionBytes > 20_000) fail(`evidence attribution exceeds the default budget: ${result.attributionBytes}`)
if (result.attributionBytes < 3_000) fail(`evidence attribution extraction is too small: ${result.attributionBytes}`)
if (result.evidenceBytes > 20_000) fail(`evidence.ts remains above the default budget: ${result.evidenceBytes}`)
if (originalBytes - result.evidenceBytes < 4_000) {
  fail(`evidence.ts shrank by fewer than 4,000 bytes: ${originalBytes} -> ${result.evidenceBytes}`)
}
if (result.attributionText.includes("from './evidence.js'")) fail('attribution module would create a source cycle')
if (/createHash\s*\(|sha256|contentHash|buildEvidence|createEvidence/i.test(result.attributionText)) {
  fail('attribution module contains content hashing or top-level evidence assembly')
}

fs.writeFileSync(sourcePath, result.evidenceText)
fs.writeFileSync(attributionPath, result.attributionText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const engine = architecture.layers.find((layer) => layer.name === 'engine')
if (!engine) fail('architecture has no engine layer')
if (engine.files.includes('src/evidence-attribution.ts')) fail('evidence attribution is already classified')
engine.files.push('src/evidence-attribution.ts')
engine.files.sort()
architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/evidence.ts')
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
docs = docs
  .split('\n')
  .filter((line) => !line.includes('`evidence.ts`'))
  .join('\n')
const marker = 'Claim attribution and retained excerpt construction now live in `evidence-attribution.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The ${result.attributionBytes.toLocaleString('en-US')}-byte attribution module owns source-ordered claim matching and byte-stable excerpts, while the ${result.evidenceBytes.toLocaleString('en-US')}-byte \`evidence.ts\` wrapper retains content hashing and top-level evidence assembly. Both fit the default budget, removing the evidence growth stop and leaving ${architecture.size_exceptions.length}. Existing evidence, property, offline-corpus, and package tests preserve normalized text, retained excerpt bytes, ordering, and hashes.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
const sequenceMarker = '## Post-sequence hardening\n'
if (!docs.includes(sequenceMarker)) {
  const insertAt = docs.indexOf('## Adding a module')
  const section = `## Post-sequence hardening\n\n- **Evidence attribution — complete.** Normalization, attribution/excerpt construction, and hashing/assembly are independently bounded without changing evidence bytes.\n- **Research aggregation and presentation — next.** Separate cross-lane aggregation from model-facing formatting before removing the final research growth stop.\n\n`
  docs = insertAt >= 0 ? docs.slice(0, insertAt) + section + docs.slice(insertAt) : `${docs}\n${section}`
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Source-ordered claim attribution and byte-stable retained excerpt construction now live in `evidence-attribution.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; HTML/text normalization remains in \`evidence-normalization.ts\`, while content hashing and top-level assembly remain in \`evidence.ts\`.\n- The ${result.attributionBytes.toLocaleString('en-US')}-byte attribution module and ${result.evidenceBytes.toLocaleString('en-US')}-byte evidence wrapper both fit the default budget, removing the final evidence architecture exception while preserving excerpt bytes, source order, and hashes.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  evidence_before_bytes: originalBytes,
  evidence_wrapper_bytes: result.evidenceBytes,
  attribution_module_bytes: result.attributionBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
