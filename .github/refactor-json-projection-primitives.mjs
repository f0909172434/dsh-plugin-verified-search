import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'json-projection.ts')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
const originalBytes = Buffer.byteLength(source)
const file = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

const fail = (message) => {
  throw new Error(message)
}

const statements = [...file.statements]
const functions = statements.filter(ts.isFunctionDeclaration)
const classes = statements.filter(ts.isClassDeclaration)
const imports = statements.filter(ts.isImportDeclaration)
const typeAliases = statements.filter(ts.isTypeAliasDeclaration)

const errorAlias = typeAliases.find((node) => node.name.text.includes('Projection') && node.name.text.endsWith('ErrorCode'))
  ?? typeAliases.find((node) => node.name.text.endsWith('ErrorCode'))
if (!errorAlias) fail('could not find the projection error-code type alias')

const errorCodes = []
const collectStringLiterals = (node) => {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    errorCodes.push(node.literal.text)
  }
  ts.forEachChild(node, collectStringLiterals)
}
collectStringLiterals(errorAlias.type)

const errorCode = (suffix, fallback = undefined) => {
  const matches = errorCodes.filter((value) => value.endsWith(suffix))
  if (matches.length === 1) return matches[0]
  if (fallback !== undefined && matches.length === 0) return fallback
  fail(`expected one projection error code ending with ${suffix}, found ${JSON.stringify(matches)}`)
}
const invalidRequestCode = errorCode('_INVALID_REQUEST')
const invalidPointerCode = errorCode('_INVALID_POINTER', invalidRequestCode)
const errorMap = {
  invalid_request: invalidRequestCode,
  input_too_large: errorCode('_INPUT_TOO_LARGE'),
  invalid_utf8: errorCode('_INVALID_UTF8'),
  invalid_unicode: errorCode('_INVALID_UNICODE'),
  invalid_json: errorCode('_INVALID_JSON'),
  duplicate_key: errorCode('_DUPLICATE_KEY'),
  parse_limit_exceeded: errorCode('_PARSE_LIMIT_EXCEEDED'),
  invalid_pointer: invalidPointerCode,
  invalid_iso_date: invalidRequestCode,
}

const bodyText = (node) => node.body ? source.slice(node.body.getStart(file), node.body.end) : ''
const findFunction = (preferredName, predicate) => {
  const preferred = functions.find((node) => node.name?.text === preferredName)
  if (preferred && predicate(bodyText(preferred))) return preferred
  const matches = functions.filter((node) => predicate(bodyText(node)))
  if (matches.length !== 1) {
    fail(`expected one ${preferredName} helper, found ${matches.map((node) => node.name?.text).join(', ')}`)
  }
  return matches[0]
}

const unicodeFunction = findFunction(
  'hasUnpairedSurrogate',
  (text) => text.includes('0xd800') && text.includes('0xdbff') && text.includes('0xdc00') && text.includes('0xdfff'),
)
const decodeFunction = findFunction(
  'decodeInput',
  (text) => text.includes('TextDecoder') && text.includes('Uint8Array') && text.includes('utf-8'),
)
const strictScanner = classes.find((node) => node.name?.text === 'StrictJsonScanner')
  ?? (() => {
    const matches = classes.filter((node) => {
      const text = source.slice(node.getStart(file), node.end)
      return text.includes('scanObject') && text.includes('duplicate key') && text.includes('maxDepth')
    })
    if (matches.length !== 1) {
      fail(`expected one private strict JSON scanner, found ${matches.map((node) => node.name?.text).join(', ')}`)
    }
    return matches[0]
  })()
const scannerName = strictScanner.name?.text
if (!scannerName) fail('projection strict JSON scanner has no name')
const scanFunction = findFunction(
  'scanStrictJson',
  (text) => text.includes(scannerName) && text.includes('.scan('),
)
const scanFunctionName = scanFunction.name?.text
if (!scanFunctionName) fail('projection strict scan helper has no name')
const parseFunction = findFunction(
  'parseStrictJson',
  (text) => text.includes('JSON.parse') && text.includes(scanFunctionName),
)
const failFunction = functions.find((node) => node.name?.text === 'fail')
  ?? functions.find((node) => bodyText(node).includes('throw new') && bodyText(node).includes('Error'))
if (!failFunction?.name) fail('could not locate the projection fail helper')
const failName = failFunction.name.text

const variableNames = []
for (const statement of statements.filter(ts.isVariableStatement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) variableNames.push(declaration.name.text)
  }
}
const inputLimitName = variableNames.find((name) => name.includes('PROJECTION') && name.endsWith('MAX_INPUT_BYTES'))
  ?? variableNames.find((name) => name.endsWith('MAX_INPUT_BYTES'))
if (!inputLimitName) fail('could not locate the projection input byte limit')

const parameterName = (node, index) => {
  const parameter = node.parameters[index]
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    fail(`helper ${node.name?.text} parameter ${index} is not a simple identifier`)
  }
  return parameter.name.text
}
const signature = (node) => source.slice(node.getStart(file), node.body.getStart(file))
const withLeadingTrivia = (node, replacement) => {
  const leading = source.slice(node.getFullStart(), node.getStart(file))
  return leading + replacement
}

const unicodeName = unicodeFunction.name?.text
const decodeName = decodeFunction.name?.text
const scanName = scanFunction.name?.text
const parseName = parseFunction.name?.text
if (!unicodeName || !decodeName || !scanName || !parseName) {
  fail('one or more projection strict JSON helper functions are unnamed')
}
const unicodeValue = parameterName(unicodeFunction, 0)
const decodeValue = parameterName(decodeFunction, 0)
const scanValue = parameterName(scanFunction, 0)
const parseValue = parameterName(parseFunction, 0)

const wrapperReplacements = new Map([
  [
    unicodeFunction,
    `${signature(unicodeFunction)}{\n  return hasSharedUnpairedSurrogate(${unicodeValue})\n}`,
  ],
  [
    decodeFunction,
    `${signature(decodeFunction)}{\n  return decodeSharedJsonInput(${decodeValue}, {\n    maxBytes: ${inputLimitName},\n    maxBytesLabel: '8 MiB',\n    fail: failJsonPrimitive,\n  })\n}`,
  ],
  [
    scanFunction,
    `${signature(scanFunction)}{\n  scanSharedStrictJson(${scanValue}, {\n    maxDepth: 64,\n    fail: failJsonPrimitive,\n  })\n}`,
  ],
  [
    parseFunction,
    `${signature(parseFunction)}{\n  return parseSharedStrictJson(${parseValue}, {\n    maxDepth: 64,\n    fail: failJsonPrimitive,\n  })\n}`,
  ],
])

if (source.includes("from './json-primitives.js'")) {
  fail('projection module already imports shared JSON primitives')
}
const importBlock = `import {\n  decodeJsonInput as decodeSharedJsonInput,\n  hasUnpairedSurrogate as hasSharedUnpairedSurrogate,\n  parseStrictJson as parseSharedStrictJson,\n  scanStrictJson as scanSharedStrictJson,\n  type JsonPrimitiveFailureKind,\n} from './json-primitives.js'\n`
const mapEntries = Object.entries(errorMap)
  .map(([kind, code]) => `  ${kind}: '${code}',`)
  .join('\n')
const adapterBlock = `\nconst JSON_PROJECTION_PRIMITIVE_ERROR_CODES = {\n${mapEntries}\n} as const satisfies Record<JsonPrimitiveFailureKind, ${errorAlias.name.text}>\n\nfunction failJsonPrimitive(\n  kind: JsonPrimitiveFailureKind,\n  message: string,\n  options?: ErrorOptions,\n): never {\n  return ${failName}(message, JSON_PROJECTION_PRIMITIVE_ERROR_CODES[kind], options)\n}\n`

const edits = []
const importEnd = imports.length === 0 ? 0 : imports[imports.length - 1].end
edits.push({ start: importEnd, end: importEnd, text: `\n${importBlock}${adapterBlock}` })
for (const [node, replacement] of wrapperReplacements) {
  edits.push({
    start: node.getFullStart(),
    end: node.end,
    text: withLeadingTrivia(node, replacement),
  })
}
edits.push({
  start: strictScanner.getFullStart(),
  end: strictScanner.end,
  text: source.slice(strictScanner.getFullStart(), strictScanner.getStart(file)),
})
edits.sort((left, right) => right.start - left.start)
let rewritten = source
for (const edit of edits) {
  rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end)
}
rewritten = rewritten.replace(/\n{4,}/g, '\n\n\n')
fs.writeFileSync(sourcePath, rewritten)

const size = fs.statSync(sourcePath).size
if (size >= originalBytes - 7_000) {
  fail(`projection strict-parser migration saved fewer than 7,000 bytes: ${originalBytes} -> ${size}`)
}
if (size > 25_000) {
  fail(`projection module remains unexpectedly large after parser extraction: ${size}`)
}

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
if (!Array.isArray(architecture.size_exceptions)) fail('architecture size_exceptions is not an array')
const projectionExceptions = architecture.size_exceptions.filter((entry) => entry.path === 'src/json-projection.ts')
if (projectionExceptions.length !== 1) {
  fail(`expected one projection size exception, found ${projectionExceptions.length}`)
}
if (size <= architecture.default_module_max_bytes) {
  architecture.size_exceptions = architecture.size_exceptions.filter((entry) => entry.path !== 'src/json-projection.ts')
}
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
if (size <= architecture.default_module_max_bytes) {
  docs = docs
    .split('\n')
    .filter((line) => !line.includes('`json-projection.ts`'))
    .join('\n')
}
docs = docs.replace(/\bFive production modules\b/g, `${architecture.size_exceptions.length} production modules`)
docs = docs.replace(/\bfive production modules\b/g, `${architecture.size_exceptions.length} production modules`)
docs = docs.replace(/\bfive growth stops remain\b/g, `${architecture.size_exceptions.length} growth stops remain`)
docs = docs.replace(/\bFive growth stops remain\b/g, `${architecture.size_exceptions.length} growth stops remain`)
const decompositionStart = docs.indexOf('1. **Shared strict JSON primitives')
const decompositionEnd = docs.indexOf('\n2. **', decompositionStart)
if (decompositionStart < 0 || decompositionEnd < 0) {
  fail('could not locate the first staged decomposition item in docs/ARCHITECTURE.md')
}
const newDecomposition = `1. **Shared strict JSON primitives — selector and projection parser migrations complete.** Date selection, exact-number selection, and strict projection parsing now share bounded decoding, Unicode validation, duplicate-key/depth scanning, and caller-owned failures. The next projection step is to isolate repair-aware pointer resolution and nested projection without weakening its audit semantics.`
docs = docs.slice(0, decompositionStart) + newDecomposition + docs.slice(decompositionEnd)
const measurementMarker = 'The projection engine now delegates bounded input decoding and strict JSON scanning'
if (!docs.includes(measurementMarker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find the current architecture debt section')
  const exceptionState = size <= architecture.default_module_max_bytes
    ? `and no longer needs a size exception; ${architecture.size_exceptions.length} growth stops remain`
    : `while its repair-aware pointer and nested projection logic remain in the ${size.toLocaleString('en-US')}-byte module; the existing growth stop remains until that boundary is extracted`
  const paragraph = `\n${measurementMarker} to the shared engine through a stable projection error adapter. The migration preserves repair-aware pointer audit behavior ${exceptionState}.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- `json-projection.ts` now delegates bounded decoding and strict JSON scanning'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const exceptionText = size <= architecture.default_module_max_bytes
    ? `The ${size.toLocaleString('en-US')}-byte projection module now fits the default budget and removes its temporary architecture exception.`
    : `The projection module shrinks from ${originalBytes.toLocaleString('en-US')} to ${size.toLocaleString('en-US')} bytes; repair-aware pointer resolution remains the next extraction before its exception can be removed.`
  const entry = `${changelogMarker} through its stable error adapter while preserving repair-aware pointer audits, source order, and nested scalar projection.\n- ${exceptionText}\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'REFACTORED',
  module: 'src/json-projection.ts',
  before_bytes: originalBytes,
  after_bytes: size,
  remaining_size_exceptions: architecture.size_exceptions.length,
  projection_exception_retained: architecture.size_exceptions.some((entry) => entry.path === 'src/json-projection.ts'),
  helpers: {
    unicode: unicodeName,
    decode: decodeName,
    scan: scanName,
    parse: parseName,
    scanner: scannerName,
  },
}, null, 2))
