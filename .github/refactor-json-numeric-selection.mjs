import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const sourcePath = path.join(root, 'src', 'json-numeric-selection.ts')
const architecturePath = path.join(root, 'architecture.json')
const capabilitiesPath = path.join(root, 'capabilities.json')
const architectureDocsPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const changelogPath = path.join(root, 'CHANGELOG.md')
const source = fs.readFileSync(sourcePath, 'utf8')
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

const errorAlias = typeAliases.find((node) => node.name.text.includes('Numeric') && node.name.text.endsWith('ErrorCode'))
  ?? typeAliases.find((node) => node.name.text.endsWith('ErrorCode'))
if (!errorAlias) fail('could not find the numeric selector error-code type alias')

const errorCodes = []
const collectStringLiterals = (node) => {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    errorCodes.push(node.literal.text)
  }
  ts.forEachChild(node, collectStringLiterals)
}
collectStringLiterals(errorAlias.type)

const errorCode = (suffix) => {
  const matches = errorCodes.filter((value) => value.endsWith(suffix))
  if (matches.length !== 1) {
    fail(`expected one numeric error code ending with ${suffix}, found ${JSON.stringify(matches)}`)
  }
  return matches[0]
}

const invalidRequestCode = errorCode('_INVALID_REQUEST')
const errorMap = {
  invalid_request: invalidRequestCode,
  input_too_large: errorCode('_INPUT_TOO_LARGE'),
  invalid_utf8: errorCode('_INVALID_UTF8'),
  invalid_unicode: errorCode('_INVALID_UNICODE'),
  invalid_json: errorCode('_INVALID_JSON'),
  duplicate_key: errorCode('_DUPLICATE_KEY'),
  parse_limit_exceeded: errorCode('_PARSE_LIMIT_EXCEEDED'),
  invalid_pointer: errorCode('_INVALID_POINTER'),
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

const pointerFunction = findFunction(
  'parseJsonPointer',
  (text) => (text.includes('RFC 6901') || text.includes('~1')) && text.includes('~0'),
)
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
      fail(`expected one strict JSON scanner, found ${matches.map((node) => node.name?.text).join(', ')}`)
    }
    return matches[0]
  })()
const scannerName = strictScanner.name?.text
if (!scannerName) fail('strict JSON scanner has no name')

const scanFunction = findFunction(
  'scanStrictJson',
  (text) => text.includes(scannerName) && text.includes('.scan('),
)
const scanFunctionName = scanFunction.name?.text
if (!scanFunctionName) fail('strict scan helper has no name')
const parseFunction = findFunction(
  'parseStrictJson',
  (text) => text.includes('JSON.parse') && text.includes(scanFunctionName),
)

const failFunction = functions.find((node) => node.name?.text === 'fail')
  ?? functions.find((node) => bodyText(node).includes('throw new') && bodyText(node).includes('Error'))
if (!failFunction?.name) fail('could not locate the numeric selector fail helper')
const failName = failFunction.name.text

const variableNames = []
for (const statement of statements.filter(ts.isVariableStatement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) variableNames.push(declaration.name.text)
  }
}
const inputLimitName = variableNames.find((name) => name.includes('NUMERIC') && name.endsWith('MAX_INPUT_BYTES'))
  ?? variableNames.find((name) => name.endsWith('MAX_INPUT_BYTES'))
if (!inputLimitName) fail('could not locate the numeric JSON input byte limit')

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

const pointerName = pointerFunction.name?.text
const unicodeName = unicodeFunction.name?.text
const decodeName = decodeFunction.name?.text
const scanName = scanFunction.name?.text
const parseName = parseFunction.name?.text
if (!pointerName || !unicodeName || !decodeName || !scanName || !parseName) {
  fail('one or more strict JSON helper functions are unnamed')
}

const pointerValue = parameterName(pointerFunction, 0)
const pointerLabel = parameterName(pointerFunction, 1)
const unicodeValue = parameterName(unicodeFunction, 0)
const decodeValue = parameterName(decodeFunction, 0)
const scanValue = parameterName(scanFunction, 0)
const parseValue = parameterName(parseFunction, 0)

const wrapperReplacements = new Map([
  [
    pointerFunction,
    `${signature(pointerFunction)}{\n  return parseSharedJsonPointer(${pointerValue}, ${pointerLabel}, {\n    maxLength: 1_024,\n    maxSegments: 32,\n    fail: failJsonPrimitive,\n  })\n}`,
  ],
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

const importBlock = `import {\n  decodeJsonInput as decodeSharedJsonInput,\n  hasUnpairedSurrogate as hasSharedUnpairedSurrogate,\n  parseJsonPointer as parseSharedJsonPointer,\n  parseStrictJson as parseSharedStrictJson,\n  scanStrictJson as scanSharedStrictJson,\n  type JsonPrimitiveFailureKind,\n} from './json-primitives.js'\n`
if (source.includes("from './json-primitives.js'")) {
  fail('numeric selector already imports shared JSON primitives')
}

const mapEntries = Object.entries(errorMap)
  .map(([kind, code]) => `  ${kind}: '${code}',`)
  .join('\n')
const adapterBlock = `\nconst JSON_NUMERIC_PRIMITIVE_ERROR_CODES = {\n${mapEntries}\n} as const satisfies Record<JsonPrimitiveFailureKind, ${errorAlias.name.text}>\n\nfunction failJsonPrimitive(\n  kind: JsonPrimitiveFailureKind,\n  message: string,\n  options?: ErrorOptions,\n): never {\n  return ${failName}(message, JSON_NUMERIC_PRIMITIVE_ERROR_CODES[kind], options)\n}\n`

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
if (size > 20_000) {
  fail(`numeric selector remains above the default 20,000-byte budget: ${size}`)
}

const architecture = JSON.parse(fs.readFileSync(architecturePath, 'utf8'))
const beforeExceptions = architecture.size_exceptions
if (!Array.isArray(beforeExceptions)) fail('architecture size_exceptions is not an array')
const matchingExceptions = beforeExceptions.filter((entry) => entry.path === 'src/json-numeric-selection.ts')
if (matchingExceptions.length !== 1) {
  fail(`expected one numeric selector size exception, found ${matchingExceptions.length}`)
}
architecture.size_exceptions = beforeExceptions.filter((entry) => entry.path !== 'src/json-numeric-selection.ts')
fs.writeFileSync(architecturePath, `${JSON.stringify(architecture, null, 2)}\n`)

const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'))
capabilities.architecture_contract.size_exception_count = architecture.size_exceptions.length
fs.writeFileSync(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`)

let docs = fs.readFileSync(architectureDocsPath, 'utf8')
docs = docs
  .split('\n')
  .filter((line) => !line.includes('`json-numeric-selection.ts`'))
  .join('\n')
docs = docs.replace(/\bSix production modules\b/g, 'Five production modules')
docs = docs.replace(/\bsix production modules\b/g, 'five production modules')
docs = docs.replace(/\bsix growth stops remain\b/g, 'five growth stops remain')
docs = docs.replace(/\bSix growth stops remain\b/g, 'Five growth stops remain')
const decompositionStart = docs.indexOf('1. **Shared strict JSON primitives')
const decompositionEnd = docs.indexOf('\n2. **', decompositionStart)
if (decompositionStart < 0 || decompositionEnd < 0) {
  fail('could not locate the first staged decomposition item in docs/ARCHITECTURE.md')
}
const newDecomposition = `1. **Shared strict JSON primitives — date and exact-number migrations complete.** The bounded scanner, input decoding, RFC 6901 parsing, and caller-owned failure adaptation now serve both selectors. Strict projection remains the next consumer because its repair-aware pointer semantics require a separate compatibility boundary.`
docs = docs.slice(0, decompositionStart) + newDecomposition + docs.slice(decompositionEnd)
const measurementMarker = 'The exact-number selector now delegates shared strict-JSON validation'
if (!docs.includes(measurementMarker)) {
  const debtHeading = '## Current architecture debt\n'
  const position = docs.indexOf(debtHeading)
  if (position < 0) fail('could not find the current architecture debt section')
  const paragraph = `\n${measurementMarker} through a caller-specific error adapter while retaining its lossless number-token scanner and exact decimal comparison. The production module is ${size.toLocaleString('en-US')} bytes and therefore no longer needs a size exception; ${architecture.size_exceptions.length} growth stops remain.\n`
  docs = docs.slice(0, position + debtHeading.length) + paragraph + docs.slice(position + debtHeading.length)
}
fs.writeFileSync(architectureDocsPath, docs)

let changelog = fs.readFileSync(changelogPath, 'utf8')
const changelogMarker = '- `json-numeric-selection.ts` now delegates shared strict-JSON validation'
if (!changelog.includes(changelogMarker)) {
  const heading = '### Changed\n\n'
  if (!changelog.includes(heading)) fail('CHANGELOG.md has no Changed section')
  const entry = `${changelogMarker} and RFC 6901 parsing through its stable numeric error adapter while preserving lossless number tokens and exact decimal extrema.\n- The exact-number selector is ${size.toLocaleString('en-US')} bytes, fits the default 20,000-byte module budget, and removes one temporary architecture exception; ${architecture.size_exceptions.length} growth stops remain.\n`
  changelog = changelog.replace(heading, heading + entry, 1)
}
fs.writeFileSync(changelogPath, changelog)

console.log(JSON.stringify({
  status: 'REFRACTORED',
  module: 'src/json-numeric-selection.ts',
  bytes: size,
  remaining_size_exceptions: architecture.size_exceptions.length,
  helpers: {
    pointer: pointerName,
    unicode: unicodeName,
    decode: decodeName,
    scan: scanName,
    parse: parseName,
    scanner: scannerName,
  },
}, null, 2))
