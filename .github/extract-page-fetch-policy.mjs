import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'page-fetch.ts')
const policyPath = path.join(root, 'src', 'page-fetch-policy.ts')
const tsconfigPath = path.join(root, 'tsconfig.json')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
if (fs.existsSync(policyPath)) throw new Error('src/page-fetch-policy.ts already exists')

const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const file = program.getSourceFile(sourcePath)
if (!file) throw new Error('TypeScript program did not load src/page-fetch.ts')
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

const highLevelTransport = (info) => {
  if (!ts.isFunctionDeclaration(info.statement) && !ts.isClassDeclaration(info.statement)) return false
  const joined = info.names.join(' ')
  return /(fetchPage|readPage|requestPage|transport|redirect|response|decodeBody|readBody|contentType|charset)/i.test(joined)
}
const addressMarkers = [
  'isIP',
  'lookup',
  'hostname',
  'address',
  'loopback',
  'private',
  'public',
  'cidr',
  'dns',
  'ipv4',
  'ipv6',
]
const addressSeed = (info) => {
  if (highLevelTransport(info)) return false
  const joined = info.names.join(' ')
  const named = /(address|hostname|host|ip|dns|public|private|loopback|cidr|resolve)/i.test(joined)
  const markers = addressMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length
  return (
    (ts.isFunctionDeclaration(info.statement) || ts.isClassDeclaration(info.statement))
    && named
    && markers >= 1
  )
}
const score = (info) => {
  const joined = info.names.join(' ')
  if (addressSeed(info)) return 160
  if (highLevelTransport(info)) return 0
  if (/(address|hostname|host|ip|dns|public|private|loopback|cidr|resolve)/i.test(joined)) return 100
  if (addressMarkers.filter((marker) => info.text.toLowerCase().includes(marker.toLowerCase())).length >= 2) return 80
  if (info.typeOnly) return 20
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

let seedIndexes = infos.filter(addressSeed).map((info) => info.index)
if (seedIndexes.length === 0) {
  seedIndexes = infos.filter((info) => score(info) >= 100).map((info) => info.index)
}
if (seedIndexes.length === 0) fail('could not identify public-address policy declarations')
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
  const transportMoved = movedInfos.filter(highLevelTransport)
  if (transportMoved.length > 0) {
    fail(`address-policy closure pulled transport declarations: ${transportMoved.flatMap((info) => info.names).join(', ')}`)
  }

  const externalDependencies = new Set()
  for (const info of movedInfos) {
    for (const dependency of dependencies.get(info.index)) {
      if (!movedIndexes.has(dependency)) externalDependencies.add(dependency)
    }
  }
  if (externalDependencies.size > 0) {
    fail(`address policy has unresolved page-fetch.ts dependencies: ${[...externalDependencies].map((index) => infos.find((info) => info.index === index)?.names.join('/')).join(', ')}`)
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
  const policyText = `/**\n * Public-address and hostname resolution policy for bounded HTTPS page reads.\n *\n * This module classifies literals and resolved addresses and rejects private, loopback, link-\n * local, multicast, unspecified, and otherwise non-public destinations. HTTPS transport,\n * redirects, body decoding, media limits, and response state remain in page-fetch.ts.\n */\n${filteredImports ? `${filteredImports}\n\n` : ''}${movedBody.trimStart()}\n`

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
    boundaryText += `\nimport { ${importParts.join(', ')} } from './page-fetch-policy.js'\n`
  }
  if (exportParts.length > 0) {
    boundaryText += `export { ${exportParts.join(', ')} } from './page-fetch-policy.js'\n`
  }
  const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
  edits.push({ start: importEnd, end: importEnd, text: boundaryText })
  edits.sort((left, right) => right.start - left.start)
  let transportText = source
  for (const edit of edits) {
    transportText = transportText.slice(0, edit.start) + edit.text + transportText.slice(edit.end)
  }
  transportText = transportText.replace(/\n{4,}/g, '\n\n\n')
  return {
    transportText,
    policyText,
    transportBytes: Buffer.byteLength(transportText),
    policyBytes: Buffer.byteLength(policyText),
    movedInfos,
    boundaryNames,
  }
}

let result = build(moved)
if (result.policyBytes > 20_000) {
  fail(`initial address-policy closure exceeds the default budget: ${result.policyBytes}`)
}
const candidates = infos
  .filter((info) => !moved.has(info.index) && !highLevelTransport(info) && score(info) >= 80)
  .sort((left, right) => score(right) - score(left) || right.text.length - left.text.length)
for (const candidate of candidates) {
  if (result.transportBytes <= 19_500) break
  const trial = closure([...moved, candidate.index])
  try {
    const trialResult = build(trial)
    if (trialResult.policyBytes <= 19_500) {
      moved = trial
      result = trialResult
    }
  } catch {
    // Keep HTTPS transport and response-state behavior in page-fetch.ts.
  }
}

if (result.policyBytes > 20_000) fail(`address policy exceeds the default budget: ${result.policyBytes}`)
if (result.policyBytes < 3_000) fail(`address policy extraction is too small: ${result.policyBytes}`)
if (result.transportBytes > 20_000) fail(`page-fetch.ts remains above the default budget: ${result.transportBytes}`)
if (originalBytes - result.transportBytes < 4_000) {
  fail(`page-fetch.ts shrank by fewer than 4,000 bytes: ${originalBytes} -> ${result.transportBytes}`)
}
if (result.policyText.includes("from './page-fetch.js'")) fail('address policy would create a source cycle')
if (/https\.request|fetch\s*\(|TextDecoder|content-type|response\.body|location\s*:/i.test(result.policyText)) {
  fail('address policy contains HTTPS transport, redirect, or body-decoding behavior')
}

fs.writeFileSync(sourcePath, result.transportText)
fs.writeFileSync(policyPath, result.policyText)

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const engine = architecture.layers.find((layer) => layer.name === 'engine')
if (!engine) fail('architecture has no engine layer')
if (engine.files.includes('src/page-fetch-policy.ts')) fail('page-fetch policy is already classified')
engine.files.push('src/page-fetch-policy.ts')
engine.files.sort()
architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/page-fetch.ts')
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
docs = docs
  .split('\n')
  .filter((line) => !line.includes('`page-fetch.ts`'))
  .join('\n')
const itemStart = docs.indexOf('5. **Network policy and transport')
const itemEnd = docs.indexOf('\n6. **', itemStart)
if (itemStart < 0 || itemEnd < 0) {
  fail('could not locate the network policy and transport decomposition item')
}
const newItem = `5. **Network policy and transport — complete.** Literal and DNS-resolved address classification now live in the independently bounded \`page-fetch-policy.ts\` module. HTTPS requests, redirect state, response/media/charset limits, body decoding, and deadlines remain in \`page-fetch.ts\`. Both modules fit the default budget; offline evaluator parsing is the final staged architecture extraction.`
docs = docs.slice(0, itemStart) + newItem + docs.slice(itemEnd)
const marker = 'Public-address classification now lives in `page-fetch-policy.ts`'
if (!docs.includes(marker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find current architecture debt section')
  const paragraph = `\n${marker}. The policy module is ${result.policyBytes.toLocaleString('en-US')} bytes and the HTTPS transport wrapper is ${result.transportBytes.toLocaleString('en-US')} bytes. Both fit the default 20,000-byte budget, removing the page-fetch growth stop and leaving ${architecture.size_exceptions.length}. Existing tests continue to exercise literal and DNS-rebinding policy, redirects, media/charset limits, body bounds, and timeouts independently.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- Public-address and hostname-resolution policy now live in `page-fetch-policy.ts`'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker}; HTTPS requests, redirects, body/media/charset limits, decoding, and deadlines remain in \`page-fetch.ts\`.\n- The ${result.policyBytes.toLocaleString('en-US')}-byte policy module and ${result.transportBytes.toLocaleString('en-US')}-byte transport wrapper both fit the default budget, removing the temporary page-fetch architecture exception while preserving public-address and DNS-rebinding protections.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'EXTRACTED',
  page_fetch_before_bytes: originalBytes,
  transport_bytes: result.transportBytes,
  policy_bytes: result.policyBytes,
  moved_declarations: result.movedInfos.flatMap((info) => info.names),
  boundary_names: [...result.boundaryNames].sort(),
  remaining_size_exceptions: architecture.size_exceptions.length,
}, null, 2))
