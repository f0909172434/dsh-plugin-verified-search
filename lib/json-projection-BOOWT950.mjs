import { createHash } from "node:crypto";
//#region src/domains.ts
const MAX_ALLOWED_DOMAINS = 20;
var SearchFilterError = class extends Error {
	code = "VERIFIED_SEARCH_INVALID_FILTER";
};
/** @deprecated Use filterAllowedSources for provider-compatible degradation. */
var SearchFilterViolationError = class extends Error {
	code = "VERIFIED_SEARCH_FILTER_VIOLATION";
};
/** Normalize the portable hostname-only allowlist. */
function normalizeAllowedDomains(values) {
	if (values === void 0) return void 0;
	if (values.length === 0) throw new SearchFilterError("allowed_domains must contain at least one domain");
	if (values.length > MAX_ALLOWED_DOMAINS) throw new SearchFilterError(`allowed_domains supports at most ${MAX_ALLOWED_DOMAINS} domains`);
	const normalized = values.map((value) => {
		if (value.length === 0 || value !== value.trim()) throw new SearchFilterError("allowed_domains entries must be non-empty and have no surrounding whitespace");
		if (!/^[\x21-\x7e]+$/u.test(value)) throw new SearchFilterError("allowed_domains entries must contain only printable ASCII");
		if (value.length > 253 || value.includes("://") || /[\\/?#@:*]/u.test(value)) throw new SearchFilterError("allowed_domains entries must be bare hostnames without scheme, path, port, wildcard, query, or credentials");
		const hostname = value.toLowerCase();
		let parsedHostname;
		try {
			parsedHostname = new URL(`http://${hostname}`).hostname.toLowerCase();
		} catch {
			throw new SearchFilterError("allowed_domains entries must be valid ASCII hostnames, not IP literals");
		}
		const labels = hostname.split(".");
		if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) || parsedHostname !== hostname || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new SearchFilterError("allowed_domains entries must be valid ASCII hostnames, not IP literals");
		return hostname;
	});
	return [...new Set(normalized)];
}
function sourceMatchesDomain(sourceUrl, domain) {
	let url;
	try {
		url = new URL(sourceUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.username.length > 0 || url.password.length > 0) return false;
	const sourceHost = url.hostname.toLowerCase();
	return sourceHost === domain || sourceHost.endsWith(`.${domain}`);
}
/** Keep only structured sources that satisfy the portable allowlist. */
function filterAllowedSources(sources, allowedDomains) {
	if (allowedDomains === void 0) return {
		sources,
		filteredOut: 0
	};
	const accepted = sources.filter((source) => allowedDomains.some((domain) => sourceMatchesDomain(source.url, domain)));
	return {
		sources: accepted,
		filteredOut: sources.length - accepted.length
	};
}
/** @deprecated Retained for v0.1.x API compatibility; new code should post-filter. */
function enforceAllowedSources(urls, allowedDomains) {
	if (allowedDomains === void 0) return;
	const index = urls.findIndex((url) => !allowedDomains.some((domain) => sourceMatchesDomain(url, domain)));
	if (index === -1) return;
	throw new SearchFilterViolationError(`search provider returned source ${index + 1} outside allowed_domains`);
}
//#endregion
//#region src/json-primitives.ts
function parseJsonPointer(pointer, label, policy) {
	if (typeof pointer !== "string") policy.fail("invalid_pointer", `${label} must be a string`);
	if (pointer.length > policy.maxLength) policy.fail("invalid_pointer", `${label} exceeds ${policy.maxLength} characters`);
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) policy.fail("invalid_pointer", `${label} must be an RFC 6901 JSON Pointer`);
	const rawSegments = pointer.slice(1).split("/");
	if (rawSegments.length > policy.maxSegments) policy.fail("invalid_pointer", `${label} exceeds ${policy.maxSegments} segments`);
	return rawSegments.map((segment) => {
		if (/~(?:[^01]|$)/u.test(segment)) policy.fail("invalid_pointer", `${label} contains an invalid RFC 6901 escape`);
		return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
	});
}
function isLeapYear(year) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function isIsoDate(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	return day <= [
		31,
		isLeapYear(year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	][month - 1];
}
function requireIsoDate$2(value, label, fail) {
	if (!isIsoDate(value)) fail("invalid_iso_date", `${label} must be a valid ISO calendar date (YYYY-MM-DD)`);
	return value;
}
function requireSourceDate$2(value, label, fail) {
	if (isIsoDate(value)) return value;
	const timestamp = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(value) : null;
	if (timestamp === null || !isIsoDate(timestamp[1]) || Number(timestamp[2]) > 23 || Number(timestamp[3]) > 59 || Number(timestamp[4]) > 59) fail("invalid_iso_date", `${label} must be an ISO calendar date or UTC RFC 3339 timestamp`);
	return timestamp[1];
}
function hasUnpairedSurrogate$1(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 55296 && code <= 56319) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 56320 && next <= 57343)) return true;
			index++;
		} else if (code >= 56320 && code <= 57343) return true;
	}
	return false;
}
var StrictJsonScanner$1 = class {
	input;
	policy;
	cursor = 0;
	constructor(input, policy) {
		this.input = input;
		this.policy = policy;
	}
	scan() {
		this.skipWhitespace();
		this.scanValue(0);
		this.skipWhitespace();
		if (this.cursor !== this.input.length) this.policy.fail("invalid_json", "JSON has trailing content");
	}
	scanValue(depth) {
		if (depth > this.policy.maxDepth) this.policy.fail("parse_limit_exceeded", `JSON nesting exceeds ${this.policy.maxDepth}`);
		const character = this.input[this.cursor];
		if (depth === this.policy.maxDepth && (character === "{" || character === "[")) this.policy.fail("parse_limit_exceeded", `JSON nesting exceeds ${this.policy.maxDepth}`);
		if (character === "{") this.scanObject(depth + 1);
		else if (character === "[") this.scanArray(depth + 1);
		else if (character === "\"") this.scanString();
		else this.scanPrimitive();
	}
	scanObject(depth) {
		this.cursor++;
		this.skipWhitespace();
		if (this.input[this.cursor] === "}") {
			this.cursor++;
			return;
		}
		const keys = /* @__PURE__ */ new Set();
		while (this.cursor < this.input.length) {
			if (this.input[this.cursor] !== "\"") this.policy.fail("invalid_json", "invalid JSON object key");
			const key = this.scanString();
			if (keys.has(key)) this.policy.fail("duplicate_key", "JSON object contains a duplicate key");
			keys.add(key);
			this.skipWhitespace();
			if (this.input[this.cursor] !== ":") this.policy.fail("invalid_json", "invalid JSON object separator");
			this.cursor++;
			this.skipWhitespace();
			this.scanValue(depth);
			this.skipWhitespace();
			const separator = this.input[this.cursor];
			if (separator === "}") {
				this.cursor++;
				return;
			}
			if (separator !== ",") this.policy.fail("invalid_json", "invalid JSON object separator");
			this.cursor++;
			this.skipWhitespace();
		}
		this.policy.fail("invalid_json", "unterminated JSON object");
	}
	scanArray(depth) {
		this.cursor++;
		this.skipWhitespace();
		if (this.input[this.cursor] === "]") {
			this.cursor++;
			return;
		}
		while (this.cursor < this.input.length) {
			this.scanValue(depth);
			this.skipWhitespace();
			const separator = this.input[this.cursor];
			if (separator === "]") {
				this.cursor++;
				return;
			}
			if (separator !== ",") this.policy.fail("invalid_json", "invalid JSON array separator");
			this.cursor++;
			this.skipWhitespace();
		}
		this.policy.fail("invalid_json", "unterminated JSON array");
	}
	scanString() {
		const start = this.cursor;
		this.cursor++;
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character === "\"") {
				this.cursor++;
				let decoded;
				try {
					decoded = JSON.parse(this.input.slice(start, this.cursor));
				} catch (error) {
					this.policy.fail("invalid_json", "invalid JSON string", { cause: error });
				}
				if (typeof decoded !== "string") this.policy.fail("invalid_json", "invalid JSON string");
				if (hasUnpairedSurrogate$1(decoded)) this.policy.fail("invalid_unicode", "JSON strings must not contain unpaired UTF-16 surrogates");
				return decoded;
			}
			if (character === "\\") this.cursor += this.input[this.cursor + 1] === "u" ? 6 : 2;
			else this.cursor++;
		}
		this.policy.fail("invalid_json", "unterminated JSON string");
	}
	scanPrimitive() {
		const start = this.cursor;
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character === "," || character === "]" || character === "}" || /\s/u.test(character)) break;
			this.cursor++;
		}
		if (this.cursor === start) this.policy.fail("invalid_json", "invalid JSON value");
	}
	skipWhitespace() {
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character !== " " && character !== "	" && character !== "\r" && character !== "\n") break;
			this.cursor++;
		}
	}
};
function decodeJsonInput(input, policy) {
	if (typeof input === "string") {
		if (hasUnpairedSurrogate$1(input)) policy.fail("invalid_unicode", "JSON input must not contain unpaired UTF-16 surrogates");
		const bytes = Buffer.from(input, "utf8");
		if (bytes.byteLength > policy.maxBytes) policy.fail("input_too_large", `JSON input exceeds the ${policy.maxBytesLabel} limit`);
		return {
			text: input,
			bytes
		};
	}
	if (!(input instanceof Uint8Array)) policy.fail("invalid_request", "JSON input must be a string or Uint8Array");
	if (input.byteLength > policy.maxBytes) policy.fail("input_too_large", `JSON input exceeds the ${policy.maxBytesLabel} limit`);
	try {
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(input),
			bytes: input
		};
	} catch (error) {
		policy.fail("invalid_utf8", "JSON input is not valid UTF-8", { cause: error });
	}
}
function scanStrictJson(text, policy) {
	new StrictJsonScanner$1(text, policy).scan();
}
function parseStrictJson$3(text, policy) {
	scanStrictJson(text, policy);
	try {
		return JSON.parse(text);
	} catch (error) {
		policy.fail("invalid_json", "JSON input is invalid", { cause: error });
	}
}
//#endregion
//#region src/json-selection.ts
const JSON_SELECTION_MAX_INPUT_BYTES = 8388608;
const JSON_SELECTION_MAX_ROWS = 25e3;
const MAX_JSON_DEPTH$2 = 64;
const MAX_POINTER_LENGTH$2 = 1024;
const MAX_POINTER_SEGMENTS$2 = 32;
const MAX_PROJECTIONS$2 = 32;
const MAX_EQUALITY_FILTERS$2 = 4;
const MAX_OUTPUT_BYTES$2 = 8388608;
const MAX_PROJECTED_OUTPUT_BYTES$2 = 4194304;
var JsonSelectionError = class extends Error {
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "JsonSelectionError";
	}
};
function fail$2(message, code, options) {
	throw new JsonSelectionError(message, code, options);
}
const JSON_PRIMITIVE_ERROR_CODES = {
	invalid_request: "JSON_SELECTION_INVALID_REQUEST",
	input_too_large: "JSON_SELECTION_INPUT_TOO_LARGE",
	invalid_utf8: "JSON_SELECTION_INVALID_UTF8",
	invalid_unicode: "JSON_SELECTION_INVALID_UNICODE",
	invalid_json: "JSON_SELECTION_INVALID_JSON",
	duplicate_key: "JSON_SELECTION_DUPLICATE_KEY",
	parse_limit_exceeded: "JSON_SELECTION_PARSE_LIMIT_EXCEEDED",
	invalid_pointer: "JSON_SELECTION_INVALID_POINTER",
	invalid_iso_date: "JSON_SELECTION_INVALID_ISO_DATE"
};
function failJsonPrimitive(kind, message, options) {
	fail$2(message, JSON_PRIMITIVE_ERROR_CODES[kind], options);
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertExactObject$2(value, allowedKeys, requiredKeys, label) {
	if (!isRecord$2(value)) fail$2(`${label} must be an object`, "JSON_SELECTION_INVALID_REQUEST");
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail$2(`${label} contains unsupported property "${key}"`, "JSON_SELECTION_INVALID_REQUEST");
	for (const key of requiredKeys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail$2(`${label} is missing required property "${key}"`, "JSON_SELECTION_INVALID_REQUEST");
	return value;
}
function parsePointer$2(pointer, label) {
	return parseJsonPointer(pointer, label, {
		maxLength: MAX_POINTER_LENGTH$2,
		maxSegments: MAX_POINTER_SEGMENTS$2,
		fail: failJsonPrimitive
	});
}
function requireIsoDate$1(value, label) {
	return requireIsoDate$2(value, label, failJsonPrimitive);
}
function requireSourceDate$1(value, label) {
	return requireSourceDate$2(value, label, failJsonPrimitive);
}
function compileRequest$2(input) {
	const request = assertExactObject$2(input, [
		"arrayPointer",
		"filter",
		"where",
		"max",
		"project"
	], [
		"arrayPointer",
		"filter",
		"max",
		"project"
	], "request");
	const arrayPointer = request.arrayPointer;
	if (typeof arrayPointer !== "string") fail$2("request.arrayPointer must be a string", "JSON_SELECTION_INVALID_REQUEST");
	const filter = assertExactObject$2(request.filter, ["pointer", "lte"], ["pointer", "lte"], "request.filter");
	if (typeof filter.pointer !== "string") fail$2("request.filter.pointer must be a string", "JSON_SELECTION_INVALID_REQUEST");
	const cutoff = requireIsoDate$1(filter.lte, "request.filter.lte");
	const where = request.where === void 0 ? [] : (() => {
		if (!Array.isArray(request.where) || request.where.length === 0 || request.where.length > MAX_EQUALITY_FILTERS$2) fail$2(`request.where must contain 1-${MAX_EQUALITY_FILTERS$2} entries`, "JSON_SELECTION_INVALID_REQUEST");
		return request.where.map((raw, index) => {
			const entry = assertExactObject$2(raw, ["pointer", "equals"], ["pointer", "equals"], `request.where[${index}]`);
			if (typeof entry.pointer !== "string") fail$2(`request.where[${index}].pointer must be a string`, "JSON_SELECTION_INVALID_REQUEST");
			if (entry.equals !== null && typeof entry.equals !== "string" && typeof entry.equals !== "boolean") fail$2(`request.where[${index}].equals must be a string, boolean, or null`, "JSON_SELECTION_INVALID_REQUEST");
			return {
				pointer: entry.pointer,
				segments: parsePointer$2(entry.pointer, `request.where[${index}].pointer`),
				equals: entry.equals
			};
		});
	})();
	const maximum = assertExactObject$2(request.max, ["pointer"], ["pointer"], "request.max");
	if (typeof maximum.pointer !== "string") fail$2("request.max.pointer must be a string", "JSON_SELECTION_INVALID_REQUEST");
	if (!Array.isArray(request.project) || request.project.length === 0 || request.project.length > MAX_PROJECTIONS$2) fail$2(`request.project must contain 1-${MAX_PROJECTIONS$2} entries`, "JSON_SELECTION_INVALID_REQUEST");
	const names = /* @__PURE__ */ new Set();
	const pointers = /* @__PURE__ */ new Set();
	const projections = request.project.map((raw, index) => {
		const projection = assertExactObject$2(raw, ["name", "pointer"], ["name", "pointer"], `request.project[${index}]`);
		if (typeof projection.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) fail$2(`request.project[${index}].name must be a 1-64 character identifier`, "JSON_SELECTION_INVALID_REQUEST");
		if (names.has(projection.name)) fail$2(`request.project contains duplicate name "${projection.name}"`, "JSON_SELECTION_INVALID_REQUEST");
		names.add(projection.name);
		if (typeof projection.pointer !== "string") fail$2(`request.project[${index}].pointer must be a string`, "JSON_SELECTION_INVALID_REQUEST");
		const segments = parsePointer$2(projection.pointer, `request.project[${index}].pointer`);
		const canonicalPointer = JSON.stringify(segments);
		if (pointers.has(canonicalPointer)) fail$2("request.project contains a duplicate pointer", "JSON_SELECTION_INVALID_REQUEST");
		pointers.add(canonicalPointer);
		return {
			name: projection.name,
			pointer: projection.pointer,
			segments
		};
	});
	return {
		arrayPointer,
		arraySegments: parsePointer$2(arrayPointer, "request.arrayPointer"),
		filterPointer: filter.pointer,
		filterSegments: parsePointer$2(filter.pointer, "request.filter.pointer"),
		cutoff,
		where,
		maxPointer: maximum.pointer,
		maxSegments: parsePointer$2(maximum.pointer, "request.max.pointer"),
		projections
	};
}
function decodeInput$2(input) {
	return decodeJsonInput(input, {
		maxBytes: JSON_SELECTION_MAX_INPUT_BYTES,
		maxBytesLabel: "8 MiB",
		fail: failJsonPrimitive
	});
}
function parseStrictJson$2(text) {
	return parseStrictJson$3(text, {
		maxDepth: MAX_JSON_DEPTH$2,
		fail: failJsonPrimitive
	});
}
function resolvePointer$2(root, segments, pointer, label) {
	let value = root;
	for (const segment of segments) {
		if (Array.isArray(value)) {
			if (!/^(?:0|[1-9]\d*)$/u.test(segment)) fail$2(`${label} "${pointer}" contains a non-canonical array index`, "JSON_SELECTION_INVALID_POINTER");
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index >= value.length) fail$2(`${label} "${pointer}" was not found`, "JSON_SELECTION_POINTER_NOT_FOUND");
			value = value[index];
			continue;
		}
		if (!isRecord$2(value)) fail$2(`${label} "${pointer}" traverses a non-container value`, "JSON_SELECTION_POINTER_TYPE_MISMATCH");
		if (!Object.prototype.hasOwnProperty.call(value, segment)) fail$2(`${label} "${pointer}" was not found`, "JSON_SELECTION_POINTER_NOT_FOUND");
		value = value[segment];
	}
	return value;
}
function jsonScalarSerializedBytes(value) {
	if (value === null) return 4;
	if (typeof value === "boolean") return value ? 4 : 5;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail$2("projected JSON number was outside the finite JavaScript range", "JSON_SELECTION_NON_SCALAR_PROJECTION");
		return Buffer.byteLength(String(value), "utf8");
	}
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
		else if (code < 32) bytes += 6;
		else if (code <= 127) bytes++;
		else if (code <= 2047) bytes += 2;
		else if (code >= 55296 && code <= 56319) {
			bytes += 4;
			index++;
		} else bytes += 3;
		if (bytes > 65536) return bytes;
	}
	return bytes;
}
function consumeProjectionBudget$2(budget, bytes) {
	if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES$2) fail$2("JSON selection projected output exceeds the 4 MiB construction limit", "JSON_SELECTION_OUTPUT_TOO_LARGE");
	budget.usedBytes += bytes;
}
function projectRow$1(row, sourceIndex, request, budget) {
	const values = {};
	consumeProjectionBudget$2(budget, 48 + String(sourceIndex).length);
	for (const projection of request.projections) {
		const value = resolvePointer$2(row, projection.segments, projection.pointer, `row ${sourceIndex} projection`);
		if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail$2(`row ${sourceIndex} projection "${projection.pointer}" is not a JSON scalar`, "JSON_SELECTION_NON_SCALAR_PROJECTION");
		const scalarBytes = jsonScalarSerializedBytes(value);
		if (scalarBytes > 65536) fail$2(`row ${sourceIndex} projected scalar exceeds the 64 KiB limit`, "JSON_SELECTION_OUTPUT_TOO_LARGE");
		consumeProjectionBudget$2(budget, projection.name.length + scalarBytes + 4);
		values[projection.name] = value;
	}
	return {
		sourceIndex,
		values
	};
}
/**
* Deterministically select every maximum-date tie from a bounded JSON object-array.
* This proves selection from the exact input hash; it does not independently verify
* the factual truth of the input document.
*/
function selectJsonMaxTies(input, rawRequest) {
	const request = compileRequest$2(rawRequest);
	const decoded = decodeInput$2(input);
	const evidenceSha256 = createHash("sha256").update(decoded.bytes).digest("hex");
	const root = parseStrictJson$2(decoded.text);
	if (!isRecord$2(root) && !(Array.isArray(root) && request.arraySegments.length === 0)) fail$2("JSON root must be an object, or an array when arrayPointer is empty", "JSON_SELECTION_ROOT_TYPE_MISMATCH");
	const selectedArray = resolvePointer$2(root, request.arraySegments, request.arrayPointer, "array pointer");
	if (!Array.isArray(selectedArray)) fail$2(`array pointer "${request.arrayPointer}" must resolve to an array`, "JSON_SELECTION_ARRAY_TYPE_MISMATCH");
	if (selectedArray.length > 25e3) fail$2(`selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`, "JSON_SELECTION_ROW_LIMIT_EXCEEDED");
	let rowsEligible = 0;
	let bestDate;
	let tieCount = 0;
	let tieOverflow = false;
	let tieIndexes = [];
	for (let sourceIndex = 0; sourceIndex < selectedArray.length; sourceIndex++) {
		const row = selectedArray[sourceIndex];
		if (!isRecord$2(row)) fail$2(`selected array row ${sourceIndex} must be an object`, "JSON_SELECTION_ROW_TYPE_MISMATCH");
		if (!request.where.every((entry) => Object.is(resolvePointer$2(row, entry.segments, entry.pointer, `row ${sourceIndex} equality filter`), entry.equals))) continue;
		if (requireSourceDate$1(resolvePointer$2(row, request.filterSegments, request.filterPointer, `row ${sourceIndex} filter`), `row ${sourceIndex} filter "${request.filterPointer}"`) > request.cutoff) continue;
		rowsEligible++;
		const candidateDate = requireSourceDate$1(resolvePointer$2(row, request.maxSegments, request.maxPointer, `row ${sourceIndex} max`), `row ${sourceIndex} max "${request.maxPointer}"`);
		if (bestDate === void 0 || candidateDate > bestDate) {
			bestDate = candidateDate;
			tieCount = 1;
			tieOverflow = false;
			tieIndexes = [sourceIndex];
		} else if (candidateDate === bestDate) {
			tieCount++;
			if (tieIndexes.length < 256) tieIndexes.push(sourceIndex);
			else tieOverflow = true;
		}
	}
	if (bestDate === void 0) fail$2("no row satisfied the ISO-date cutoff", "JSON_SELECTION_NO_MATCH");
	if (tieOverflow) fail$2(`maximum-date ties exceed the 256 row limit`, "JSON_SELECTION_TIE_LIMIT_EXCEEDED");
	const projectionBudget = { usedBytes: 0 };
	const rows = tieIndexes.map((sourceIndex) => projectRow$1(selectedArray[sourceIndex], sourceIndex, request, projectionBudget));
	const result = {
		complete: true,
		truncated: false,
		evidenceSha256,
		arrayPointer: request.arrayPointer,
		filter: {
			pointer: request.filterPointer,
			lte: request.cutoff
		},
		...request.where.length === 0 ? {} : { where: request.where.map((entry) => ({
			pointer: entry.pointer,
			equals: entry.equals
		})) },
		max: {
			pointer: request.maxPointer,
			value: bestDate,
			ties: "all"
		},
		rowsScanned: selectedArray.length,
		rowsEligible,
		tieCount,
		rows
	};
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES$2) fail$2("JSON selection output exceeds the 8 MiB limit", "JSON_SELECTION_OUTPUT_TOO_LARGE");
	return result;
}
//#endregion
//#region src/json-lossless-number.ts
const JSON_NUMBER = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/u;
const losslessJsonNumberBrand = Symbol("lossless-json-number");
function parseExponent(sign, digits) {
	if (digits === void 0) return 0n;
	const value = BigInt(digits);
	return sign === "-" ? -value : value;
}
function normalizeNumber(lexeme, fail) {
	const match = JSON_NUMBER.exec(lexeme);
	if (match === null) fail("invalid_json", "lossless parser returned an invalid JSON number token");
	const fraction = match[3] ?? "";
	const withoutLeading = `${match[2]}${fraction}`.replace(/^0+/u, "");
	if (withoutLeading === "") return {
		sign: 0,
		digits: "0",
		scale: 0n
	};
	let trailingZeroes = 0;
	for (let index = withoutLeading.length - 1; index >= 0 && withoutLeading[index] === "0"; index--) trailingZeroes++;
	const digits = trailingZeroes === 0 ? withoutLeading : withoutLeading.slice(0, -trailingZeroes);
	const scale = parseExponent(match[4], match[5]) - BigInt(fraction.length) + BigInt(trailingZeroes);
	return {
		sign: match[1] === "-" ? -1 : 1,
		digits,
		scale
	};
}
function createLosslessNumber(lexeme, policy) {
	if (Buffer.byteLength(lexeme, "utf8") > policy.maxLexemeBytes) policy.fail("number_lexeme_limit_exceeded", `JSON number token exceeds the ${policy.maxLexemeBytes}-byte limit`);
	return Object.freeze({
		[losslessJsonNumberBrand]: true,
		lexeme,
		normalized: normalizeNumber(lexeme, policy.fail)
	});
}
function isLosslessJsonNumber(value) {
	return typeof value === "object" && value !== null && value[losslessJsonNumberBrand] === true;
}
function parseLosslessStrictJson(text, policy) {
	scanStrictJson(text, {
		maxDepth: policy.maxDepth,
		fail: policy.fail
	});
	let numberTokens = 0;
	try {
		return JSON.parse(text, (_key, value, context) => {
			if (typeof value !== "number") return value;
			numberTokens++;
			if (numberTokens > policy.maxNumberTokens) policy.fail("number_token_limit_exceeded", `JSON contains more than ${policy.maxNumberTokens} number tokens`);
			if (typeof context?.source !== "string") policy.fail("lossless_parse_unavailable", "runtime did not expose the exact JSON number token");
			return createLosslessNumber(context.source, policy);
		});
	} catch (error) {
		if (policy.isFailure(error)) throw error;
		policy.fail("invalid_json", "JSON input is invalid", { cause: error });
	}
}
function compareMagnitude(left, right) {
	const leftOrder = left.scale + BigInt(left.digits.length);
	const rightOrder = right.scale + BigInt(right.digits.length);
	if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
	const length = Math.max(left.digits.length, right.digits.length);
	for (let index = 0; index < length; index++) {
		const leftDigit = index < left.digits.length ? left.digits.charCodeAt(index) : 48;
		const rightDigit = index < right.digits.length ? right.digits.charCodeAt(index) : 48;
		if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
	}
	return 0;
}
function compareLosslessJsonNumbers(left, right) {
	if (left.normalized.sign !== right.normalized.sign) return left.normalized.sign < right.normalized.sign ? -1 : 1;
	if (left.normalized.sign === 0) return 0;
	const magnitude = compareMagnitude(left.normalized, right.normalized);
	return left.normalized.sign === -1 ? magnitude === 0 ? 0 : magnitude === 1 ? -1 : 1 : magnitude;
}
//#endregion
//#region src/json-numeric-selection.ts
const JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS = 1e5;
const JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES = 1024;
const MAX_JSON_DEPTH$1 = 64;
const MAX_POINTER_LENGTH$1 = 1024;
const MAX_POINTER_SEGMENTS$1 = 32;
const MAX_PROJECTIONS$1 = 32;
const MAX_EQUALITY_FILTERS$1 = 4;
const MAX_OUTPUT_BYTES$1 = 8388608;
const MAX_PROJECTED_OUTPUT_BYTES$1 = 4194304;
var JsonNumericSelectionError = class extends Error {
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "JsonNumericSelectionError";
	}
};
function fail$1(message, code, options) {
	throw new JsonNumericSelectionError(message, code, options);
}
const JSON_FAILURE_ERROR_CODES = {
	invalid_request: "JSON_NUMERIC_SELECTION_INVALID_REQUEST",
	input_too_large: "JSON_NUMERIC_SELECTION_INPUT_TOO_LARGE",
	invalid_utf8: "JSON_NUMERIC_SELECTION_INVALID_UTF8",
	invalid_unicode: "JSON_NUMERIC_SELECTION_INVALID_UNICODE",
	invalid_json: "JSON_NUMERIC_SELECTION_INVALID_JSON",
	duplicate_key: "JSON_NUMERIC_SELECTION_DUPLICATE_KEY",
	parse_limit_exceeded: "JSON_NUMERIC_SELECTION_PARSE_LIMIT_EXCEEDED",
	invalid_pointer: "JSON_NUMERIC_SELECTION_INVALID_POINTER",
	invalid_iso_date: "JSON_NUMERIC_SELECTION_INVALID_ISO_DATE",
	number_token_limit_exceeded: "JSON_NUMERIC_SELECTION_NUMBER_TOKEN_LIMIT_EXCEEDED",
	number_lexeme_limit_exceeded: "JSON_NUMERIC_SELECTION_NUMBER_LEXEME_LIMIT_EXCEEDED",
	lossless_parse_unavailable: "JSON_NUMERIC_SELECTION_LOSSLESS_PARSE_UNAVAILABLE"
};
function failJsonFailure(kind, message, options) {
	fail$1(message, JSON_FAILURE_ERROR_CODES[kind], options);
}
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !isLosslessJsonNumber(value);
}
function assertExactObject$1(value, allowedKeys, requiredKeys, label) {
	if (!isRecord$1(value)) fail$1(`${label} must be an object`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail$1(`${label} contains an unsupported property`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	for (const key of requiredKeys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail$1(`${label} is missing a required property`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	return value;
}
function parsePointer$1(pointer, label) {
	return parseJsonPointer(pointer, label, {
		maxLength: MAX_POINTER_LENGTH$1,
		maxSegments: MAX_POINTER_SEGMENTS$1,
		fail: failJsonFailure
	});
}
function requireIsoDate(value, label) {
	return requireIsoDate$2(value, label, failJsonFailure);
}
function requireSourceDate(value, label) {
	return requireSourceDate$2(value, label, failJsonFailure);
}
function compileRequest$1(input) {
	const request = assertExactObject$1(input, [
		"arrayPointer",
		"filter",
		"where",
		"extreme",
		"project"
	], [
		"arrayPointer",
		"extreme",
		"project"
	], "request");
	if (typeof request.arrayPointer !== "string") fail$1("request.arrayPointer must be a string", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	const arrayPointer = request.arrayPointer;
	const filter = request.filter === void 0 ? void 0 : (() => {
		const value = assertExactObject$1(request.filter, ["pointer", "lte"], ["pointer", "lte"], "request.filter");
		if (typeof value.pointer !== "string") fail$1("request.filter.pointer must be a string", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		return {
			pointer: value.pointer,
			segments: parsePointer$1(value.pointer, "request.filter.pointer"),
			lte: requireIsoDate(value.lte, "request.filter.lte")
		};
	})();
	const where = request.where === void 0 ? [] : (() => {
		if (!Array.isArray(request.where) || request.where.length === 0 || request.where.length > MAX_EQUALITY_FILTERS$1) fail$1(`request.where must contain 1-${MAX_EQUALITY_FILTERS$1} entries`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		return request.where.map((raw, index) => {
			const entry = assertExactObject$1(raw, ["pointer", "equals"], ["pointer", "equals"], `request.where[${index}]`);
			if (typeof entry.pointer !== "string") fail$1(`request.where[${index}].pointer must be a string`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
			if (entry.equals !== null && typeof entry.equals !== "string" && typeof entry.equals !== "boolean") fail$1(`request.where[${index}].equals must be a string, boolean, or null`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
			return {
				pointer: entry.pointer,
				segments: parsePointer$1(entry.pointer, `request.where[${index}].pointer`),
				equals: entry.equals
			};
		});
	})();
	const extreme = assertExactObject$1(request.extreme, [
		"pointer",
		"direction",
		"ties"
	], [
		"pointer",
		"direction",
		"ties"
	], "request.extreme");
	if (typeof extreme.pointer !== "string") fail$1("request.extreme.pointer must be a string", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	if (extreme.direction !== "max" && extreme.direction !== "min") fail$1("request.extreme.direction must be max or min", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	if (extreme.ties !== "all") fail$1("request.extreme.ties must be all", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	if (!Array.isArray(request.project) || request.project.length === 0 || request.project.length > MAX_PROJECTIONS$1) fail$1(`request.project must contain 1-${MAX_PROJECTIONS$1} entries`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
	const names = /* @__PURE__ */ new Set();
	const pointers = /* @__PURE__ */ new Set();
	const projections = request.project.map((raw, index) => {
		const projection = assertExactObject$1(raw, ["name", "pointer"], ["name", "pointer"], `request.project[${index}]`);
		if (typeof projection.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) fail$1(`request.project[${index}].name must be a 1-64 character identifier`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		if (names.has(projection.name)) fail$1("request.project contains a duplicate name", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		names.add(projection.name);
		if (typeof projection.pointer !== "string") fail$1(`request.project[${index}].pointer must be a string`, "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		const segments = parsePointer$1(projection.pointer, `request.project[${index}].pointer`);
		const canonicalPointer = JSON.stringify(segments);
		if (pointers.has(canonicalPointer)) fail$1("request.project contains a duplicate pointer", "JSON_NUMERIC_SELECTION_INVALID_REQUEST");
		pointers.add(canonicalPointer);
		return {
			name: projection.name,
			pointer: projection.pointer,
			segments
		};
	});
	return {
		arrayPointer,
		arraySegments: parsePointer$1(arrayPointer, "request.arrayPointer"),
		...filter === void 0 ? {} : { filter },
		where,
		extremePointer: extreme.pointer,
		extremeSegments: parsePointer$1(extreme.pointer, "request.extreme.pointer"),
		direction: extreme.direction,
		projections
	};
}
function parseStrictJson$1(text) {
	return parseLosslessStrictJson(text, {
		maxDepth: MAX_JSON_DEPTH$1,
		maxNumberTokens: JSON_NUMERIC_SELECTION_MAX_NUMBER_TOKENS,
		maxLexemeBytes: JSON_NUMERIC_SELECTION_MAX_LEXEME_BYTES,
		fail: failJsonFailure,
		isFailure: (error) => error instanceof JsonNumericSelectionError
	});
}
function decodeInput$1(input) {
	return decodeJsonInput(input, {
		maxBytes: JSON_SELECTION_MAX_INPUT_BYTES,
		maxBytesLabel: "8 MiB",
		fail: failJsonFailure
	});
}
function resolvePointer$1(root, segments, pointer, label) {
	let value = root;
	for (const segment of segments) {
		if (Array.isArray(value)) {
			if (!/^(?:0|[1-9]\d*)$/u.test(segment)) fail$1(`${label} contains a non-canonical array index`, "JSON_NUMERIC_SELECTION_INVALID_POINTER");
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index >= value.length) fail$1(`${label} was not found`, "JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND");
			value = value[index];
			continue;
		}
		if (!isRecord$1(value)) fail$1(`${label} traverses a non-container value`, "JSON_NUMERIC_SELECTION_POINTER_TYPE_MISMATCH");
		if (!Object.prototype.hasOwnProperty.call(value, segment)) fail$1(`${label} was not found`, "JSON_NUMERIC_SELECTION_POINTER_NOT_FOUND");
		value = value[segment];
	}
	return value;
}
function consumeProjectionBudget$1(budget, bytes) {
	if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES$1) fail$1("JSON numeric selection projected output exceeds the 4 MiB construction limit", "JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE");
	budget.usedBytes += bytes;
}
function projectRow(row, sourceIndex, request, budget) {
	const values = {};
	consumeProjectionBudget$1(budget, 48 + String(sourceIndex).length);
	for (const projection of request.projections) {
		const source = resolvePointer$1(row, projection.segments, projection.pointer, `row ${sourceIndex} projection`);
		let value;
		if (isLosslessJsonNumber(source)) value = { jsonNumber: source.lexeme };
		else if (source === null || typeof source === "string" || typeof source === "boolean") value = source;
		else fail$1(`row ${sourceIndex} projection is not a JSON scalar`, "JSON_NUMERIC_SELECTION_NON_SCALAR_PROJECTION");
		const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (serializedBytes > 65536) fail$1(`row ${sourceIndex} projected scalar exceeds the 64 KiB limit`, "JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE");
		consumeProjectionBudget$1(budget, projection.name.length + serializedBytes + 4);
		values[projection.name] = value;
	}
	return {
		sourceIndex,
		values
	};
}
/**
* Select every exact numeric maximum/minimum tie from one bounded JSON object-array.
* JSON number comparison and projection use the source lexeme rather than IEEE-754.
*/
function selectJsonNumericTies(input, rawRequest) {
	const request = compileRequest$1(rawRequest);
	const decoded = decodeInput$1(input);
	const evidenceSha256 = createHash("sha256").update(decoded.bytes).digest("hex");
	const root = parseStrictJson$1(decoded.text);
	if (!isRecord$1(root) && !(Array.isArray(root) && request.arraySegments.length === 0)) fail$1("JSON root must be an object, or an array when arrayPointer is empty", "JSON_NUMERIC_SELECTION_ROOT_TYPE_MISMATCH");
	const selectedArray = resolvePointer$1(root, request.arraySegments, request.arrayPointer, "array pointer");
	if (!Array.isArray(selectedArray)) fail$1("array pointer must resolve to an array", "JSON_NUMERIC_SELECTION_ARRAY_TYPE_MISMATCH");
	if (selectedArray.length > 25e3) fail$1(`selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`, "JSON_NUMERIC_SELECTION_ROW_LIMIT_EXCEEDED");
	let rowsEligible = 0;
	let best;
	let tieCount = 0;
	let tieOverflow = false;
	let tieIndexes = [];
	for (let sourceIndex = 0; sourceIndex < selectedArray.length; sourceIndex++) {
		const row = selectedArray[sourceIndex];
		if (!isRecord$1(row)) fail$1(`selected array row ${sourceIndex} must be an object`, "JSON_NUMERIC_SELECTION_ROW_TYPE_MISMATCH");
		if (!request.where.every((entry) => Object.is(resolvePointer$1(row, entry.segments, entry.pointer, `row ${sourceIndex} equality filter`), entry.equals))) continue;
		if (request.filter !== void 0) {
			if (requireSourceDate(resolvePointer$1(row, request.filter.segments, request.filter.pointer, `row ${sourceIndex} filter`), `row ${sourceIndex} filter`) > request.filter.lte) continue;
		}
		rowsEligible++;
		const candidate = resolvePointer$1(row, request.extremeSegments, request.extremePointer, `row ${sourceIndex} numeric extreme`);
		if (!isLosslessJsonNumber(candidate)) fail$1(`row ${sourceIndex} numeric extreme must be a JSON number`, "JSON_NUMERIC_SELECTION_EXTREME_TYPE_MISMATCH");
		const comparison = best === void 0 ? 1 : compareLosslessJsonNumbers(candidate, best);
		if (best === void 0 || (request.direction === "max" ? comparison > 0 : comparison < 0)) {
			best = candidate;
			tieCount = 1;
			tieOverflow = false;
			tieIndexes = [sourceIndex];
		} else if (comparison === 0) {
			tieCount++;
			if (tieIndexes.length < 256) tieIndexes.push(sourceIndex);
			else tieOverflow = true;
		}
	}
	if (best === void 0) fail$1("no row satisfied the selection filters", "JSON_NUMERIC_SELECTION_NO_MATCH");
	if (tieOverflow) fail$1(`final numeric ties exceed the 256 row limit`, "JSON_NUMERIC_SELECTION_TIE_LIMIT_EXCEEDED");
	const projectionBudget = { usedBytes: 0 };
	const rows = tieIndexes.map((sourceIndex) => projectRow(selectedArray[sourceIndex], sourceIndex, request, projectionBudget));
	const result = {
		complete: true,
		truncated: false,
		evidenceSha256,
		arrayPointer: request.arrayPointer,
		...request.filter === void 0 ? {} : { filter: {
			pointer: request.filter.pointer,
			lte: request.filter.lte
		} },
		...request.where.length === 0 ? {} : { where: request.where.map((entry) => ({
			pointer: entry.pointer,
			equals: entry.equals
		})) },
		extreme: {
			pointer: request.extremePointer,
			direction: request.direction,
			value: { jsonNumber: best.lexeme },
			ties: "all"
		},
		rowsScanned: selectedArray.length,
		rowsEligible,
		tieCount,
		rows
	};
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES$1) fail$1("JSON numeric selection output exceeds the 8 MiB limit", "JSON_NUMERIC_SELECTION_OUTPUT_TOO_LARGE");
	return result;
}
//#endregion
//#region src/json-projection.ts
const MAX_JSON_DEPTH = 64;
const MAX_POINTER_LENGTH = 1024;
const MAX_POINTER_SEGMENTS = 32;
const MAX_PROJECTIONS = 32;
const MAX_EQUALITY_FILTERS = 4;
const MAX_OUTPUT_BYTES = 8388608;
const MAX_PROJECTED_OUTPUT_BYTES = 4194304;
/** One global bound prevents many parent rows from multiplying nested traversal. */
const JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS = JSON_SELECTION_MAX_ROWS;
var JsonProjectionError = class extends Error {
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "JsonProjectionError";
	}
};
function fail(message, code, options) {
	throw new JsonProjectionError(message, code, options);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertExactObject(value, allowedKeys, requiredKeys, label) {
	if (!isRecord(value)) fail(`${label} must be an object`, "JSON_PROJECTION_INVALID_REQUEST");
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} contains unsupported property "${key}"`, "JSON_PROJECTION_INVALID_REQUEST");
	for (const key of requiredKeys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing required property "${key}"`, "JSON_PROJECTION_INVALID_REQUEST");
	return value;
}
function parsePointer(pointer, label) {
	if (typeof pointer !== "string") fail(`${label} must be a string`, "JSON_PROJECTION_INVALID_POINTER");
	if (pointer.length > MAX_POINTER_LENGTH) fail(`${label} exceeds ${MAX_POINTER_LENGTH} characters`, "JSON_PROJECTION_INVALID_POINTER");
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) fail(`${label} must be an RFC 6901 JSON Pointer`, "JSON_PROJECTION_INVALID_POINTER");
	const rawSegments = pointer.slice(1).split("/");
	if (rawSegments.length > MAX_POINTER_SEGMENTS) fail(`${label} exceeds ${MAX_POINTER_SEGMENTS} segments`, "JSON_PROJECTION_INVALID_POINTER");
	return rawSegments.map((segment) => {
		if (/~(?:[^01]|$)/u.test(segment)) fail(`${label} contains an invalid RFC 6901 escape`, "JSON_PROJECTION_INVALID_POINTER");
		return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
	});
}
function pointerTracker(requestedPointer) {
	return { requestedPointer };
}
function compileWhere(value, label) {
	if (value === void 0) return [];
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EQUALITY_FILTERS) fail(`${label} must contain 1-${MAX_EQUALITY_FILTERS} entries`, "JSON_PROJECTION_INVALID_REQUEST");
	return value.map((raw, index) => {
		const entry = assertExactObject(raw, ["pointer", "equals"], ["pointer", "equals"], `${label}[${index}]`);
		if (typeof entry.pointer !== "string") fail(`${label}[${index}].pointer must be a string`, "JSON_PROJECTION_INVALID_REQUEST");
		if (entry.equals !== null && typeof entry.equals !== "string" && typeof entry.equals !== "boolean") fail(`${label}[${index}].equals must be a string, boolean, or null; numeric equality is unsupported`, "JSON_PROJECTION_INVALID_REQUEST");
		return {
			pointer: entry.pointer,
			segments: parsePointer(entry.pointer, `${label}[${index}].pointer`),
			tracker: pointerTracker(entry.pointer),
			equals: entry.equals
		};
	});
}
function compileProjections(value, label) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROJECTIONS) fail(`${label} must contain 1-${MAX_PROJECTIONS} entries`, "JSON_PROJECTION_INVALID_REQUEST");
	const names = /* @__PURE__ */ new Set();
	const pointers = /* @__PURE__ */ new Set();
	return value.map((raw, index) => {
		const projection = assertExactObject(raw, ["name", "pointer"], ["name", "pointer"], `${label}[${index}]`);
		if (typeof projection.name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(projection.name)) fail(`${label}[${index}].name must be a 1-64 character identifier`, "JSON_PROJECTION_INVALID_REQUEST");
		if (names.has(projection.name)) fail(`${label} contains duplicate name "${projection.name}"`, "JSON_PROJECTION_INVALID_REQUEST");
		names.add(projection.name);
		if (typeof projection.pointer !== "string") fail(`${label}[${index}].pointer must be a string`, "JSON_PROJECTION_INVALID_REQUEST");
		const segments = parsePointer(projection.pointer, `${label}[${index}].pointer`);
		const canonicalPointer = JSON.stringify(segments);
		if (pointers.has(canonicalPointer)) fail(`${label} contains a duplicate pointer`, "JSON_PROJECTION_INVALID_REQUEST");
		pointers.add(canonicalPointer);
		return {
			name: projection.name,
			pointer: projection.pointer,
			segments,
			tracker: pointerTracker(projection.pointer)
		};
	});
}
function compileRequest(input) {
	const request = assertExactObject(input, [
		"arrayPointer",
		"where",
		"project",
		"nested"
	], ["arrayPointer", "project"], "request");
	if (typeof request.arrayPointer !== "string") fail("request.arrayPointer must be a string", "JSON_PROJECTION_INVALID_REQUEST");
	let nested;
	if (request.nested !== void 0) {
		const value = assertExactObject(request.nested, [
			"arrayPointer",
			"where",
			"project"
		], ["arrayPointer", "project"], "request.nested");
		if (typeof value.arrayPointer !== "string") fail("request.nested.arrayPointer must be a string", "JSON_PROJECTION_INVALID_REQUEST");
		nested = {
			arrayPointer: value.arrayPointer,
			arraySegments: parsePointer(value.arrayPointer, "request.nested.arrayPointer"),
			arrayTracker: pointerTracker(value.arrayPointer),
			where: compileWhere(value.where, "request.nested.where"),
			projections: compileProjections(value.project, "request.nested.project")
		};
	}
	const arraySegments = parsePointer(request.arrayPointer, "request.arrayPointer");
	return {
		arrayPointer: request.arrayPointer,
		arraySegments,
		arrayTracker: pointerTracker(request.arrayPointer),
		where: compileWhere(request.where, "request.where"),
		projections: compileProjections(request.project, "request.project"),
		...nested === void 0 ? {} : { nested }
	};
}
function hasUnpairedSurrogate(value) {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 55296 && code <= 56319) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 56320 && next <= 57343)) return true;
			index++;
		} else if (code >= 56320 && code <= 57343) return true;
	}
	return false;
}
/** Valid-JSON scanner that adds duplicate-key, Unicode, and depth checks. */
var StrictJsonScanner = class {
	input;
	cursor = 0;
	constructor(input) {
		this.input = input;
	}
	scan() {
		this.skipWhitespace();
		this.scanValue(0);
		this.skipWhitespace();
		if (this.cursor !== this.input.length) fail("JSON has trailing content", "JSON_PROJECTION_INVALID_JSON");
	}
	scanValue(depth) {
		if (depth > MAX_JSON_DEPTH) fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`, "JSON_PROJECTION_PARSE_LIMIT_EXCEEDED");
		const character = this.input[this.cursor];
		if (depth === MAX_JSON_DEPTH && (character === "{" || character === "[")) fail(`JSON nesting exceeds ${MAX_JSON_DEPTH}`, "JSON_PROJECTION_PARSE_LIMIT_EXCEEDED");
		if (character === "{") this.scanObject(depth + 1);
		else if (character === "[") this.scanArray(depth + 1);
		else if (character === "\"") this.scanString();
		else this.scanPrimitive();
	}
	scanObject(depth) {
		this.cursor++;
		this.skipWhitespace();
		if (this.input[this.cursor] === "}") {
			this.cursor++;
			return;
		}
		const keys = /* @__PURE__ */ new Set();
		while (this.cursor < this.input.length) {
			if (this.input[this.cursor] !== "\"") fail("invalid JSON object key", "JSON_PROJECTION_INVALID_JSON");
			const key = this.scanString();
			if (keys.has(key)) fail("JSON object contains a duplicate key", "JSON_PROJECTION_DUPLICATE_KEY");
			keys.add(key);
			this.skipWhitespace();
			if (this.input[this.cursor] !== ":") fail("invalid JSON object separator", "JSON_PROJECTION_INVALID_JSON");
			this.cursor++;
			this.skipWhitespace();
			this.scanValue(depth);
			this.skipWhitespace();
			const separator = this.input[this.cursor];
			if (separator === "}") {
				this.cursor++;
				return;
			}
			if (separator !== ",") fail("invalid JSON object separator", "JSON_PROJECTION_INVALID_JSON");
			this.cursor++;
			this.skipWhitespace();
		}
		fail("unterminated JSON object", "JSON_PROJECTION_INVALID_JSON");
	}
	scanArray(depth) {
		this.cursor++;
		this.skipWhitespace();
		if (this.input[this.cursor] === "]") {
			this.cursor++;
			return;
		}
		while (this.cursor < this.input.length) {
			this.scanValue(depth);
			this.skipWhitespace();
			const separator = this.input[this.cursor];
			if (separator === "]") {
				this.cursor++;
				return;
			}
			if (separator !== ",") fail("invalid JSON array separator", "JSON_PROJECTION_INVALID_JSON");
			this.cursor++;
			this.skipWhitespace();
		}
		fail("unterminated JSON array", "JSON_PROJECTION_INVALID_JSON");
	}
	scanString() {
		const start = this.cursor;
		this.cursor++;
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character === "\"") {
				this.cursor++;
				let decoded;
				try {
					decoded = JSON.parse(this.input.slice(start, this.cursor));
				} catch (error) {
					fail("invalid JSON string", "JSON_PROJECTION_INVALID_JSON", { cause: error });
				}
				if (typeof decoded !== "string") fail("invalid JSON string", "JSON_PROJECTION_INVALID_JSON");
				if (hasUnpairedSurrogate(decoded)) fail("JSON strings must not contain unpaired UTF-16 surrogates", "JSON_PROJECTION_INVALID_UNICODE");
				return decoded;
			}
			if (character === "\\") this.cursor += this.input[this.cursor + 1] === "u" ? 6 : 2;
			else this.cursor++;
		}
		fail("unterminated JSON string", "JSON_PROJECTION_INVALID_JSON");
	}
	scanPrimitive() {
		const start = this.cursor;
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character === "," || character === "]" || character === "}" || /\s/u.test(character)) break;
			this.cursor++;
		}
		if (this.cursor === start) fail("invalid JSON value", "JSON_PROJECTION_INVALID_JSON");
	}
	skipWhitespace() {
		while (this.cursor < this.input.length) {
			const character = this.input[this.cursor];
			if (character !== " " && character !== "	" && character !== "\r" && character !== "\n") break;
			this.cursor++;
		}
	}
};
function decodeInput(input) {
	if (typeof input === "string") {
		if (hasUnpairedSurrogate(input)) fail("JSON input must not contain unpaired UTF-16 surrogates", "JSON_PROJECTION_INVALID_UNICODE");
		const bytes = Buffer.from(input, "utf8");
		if (bytes.byteLength > 8388608) fail("JSON input exceeds the 8 MiB limit", "JSON_PROJECTION_INPUT_TOO_LARGE");
		return {
			text: input,
			bytes
		};
	}
	if (!(input instanceof Uint8Array)) fail("JSON input must be a string or Uint8Array", "JSON_PROJECTION_INVALID_REQUEST");
	if (input.byteLength > 8388608) fail("JSON input exceeds the 8 MiB limit", "JSON_PROJECTION_INPUT_TOO_LARGE");
	try {
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(input),
			bytes: input
		};
	} catch (error) {
		fail("JSON input is not valid UTF-8", "JSON_PROJECTION_INVALID_UTF8", { cause: error });
	}
}
function parseStrictJson(text) {
	new StrictJsonScanner(text).scan();
	try {
		return JSON.parse(text);
	} catch (error) {
		fail("JSON input is invalid", "JSON_PROJECTION_INVALID_JSON", { cause: error });
	}
}
function asciiCaseFold(value) {
	let folded = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code > 127) return void 0;
		folded += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
	}
	return folded;
}
const asciiKeyIndexes = /* @__PURE__ */ new WeakMap();
function asciiKeyIndex(value) {
	const cached = asciiKeyIndexes.get(value);
	if (cached !== void 0) return cached;
	const index = /* @__PURE__ */ new Map();
	for (const key of Object.keys(value)) {
		const folded = asciiCaseFold(key);
		if (folded === void 0) continue;
		if (index.has(folded)) index.set(folded, null);
		else index.set(folded, key);
	}
	asciiKeyIndexes.set(value, index);
	return index;
}
function encodedPointer(segments) {
	return segments.length === 0 ? "" : `/${segments.map((segment) => segment.replace(/~/gu, "~0").replace(/\//gu, "~1")).join("/")}`;
}
function sameRepairs(left, right) {
	if (left.length !== right.length) return false;
	return left.every((repair, index) => {
		const other = right[index];
		if (other === void 0 || repair.kind !== other.kind) return false;
		return repair.kind === "root_array_fallback" || other.kind === "ascii_case" && repair.segmentIndex === other.segmentIndex && repair.requestedSegment === other.requestedSegment && repair.effectiveSegment === other.effectiveSegment;
	});
}
function recordPointerResolution(tracker, effectiveSegments, repairs, label) {
	const effectivePointer = encodedPointer(effectiveSegments);
	const previous = tracker.resolution;
	if (previous === void 0) {
		tracker.resolution = {
			effectivePointer,
			repairs: repairs.map((repair) => ({ ...repair }))
		};
		return;
	}
	if (previous.effectivePointer !== effectivePointer || !sameRepairs(previous.repairs, repairs)) fail(`${label} resolved inconsistently across inspected rows`, "JSON_PROJECTION_INCONSISTENT_POINTER_REPAIR");
}
function pointerAudit(tracker) {
	return {
		requestedPointer: tracker.requestedPointer,
		effectivePointer: tracker.resolution?.effectivePointer ?? tracker.requestedPointer,
		repairs: (tracker.resolution?.repairs ?? []).map((repair) => ({ ...repair }))
	};
}
function resolvePointer(root, segments, pointer, tracker, label) {
	let value = root;
	const effectiveSegments = [];
	const repairs = [];
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const segment = segments[segmentIndex];
		if (Array.isArray(value)) {
			if (!/^(?:0|[1-9]\d*)$/u.test(segment)) fail(`${label} "${pointer}" contains a non-canonical array index`, "JSON_PROJECTION_INVALID_POINTER");
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index >= value.length) fail(`${label} "${pointer}" was not found`, "JSON_PROJECTION_POINTER_NOT_FOUND");
			effectiveSegments.push(segment);
			value = value[index];
			continue;
		}
		if (!isRecord(value)) fail(`${label} "${pointer}" traverses a non-container value`, "JSON_PROJECTION_POINTER_TYPE_MISMATCH");
		let effectiveSegment = segment;
		if (!Object.prototype.hasOwnProperty.call(value, segment)) {
			const folded = asciiCaseFold(segment);
			if (folded === void 0) fail(`${label} "${pointer}" was not found`, "JSON_PROJECTION_POINTER_NOT_FOUND");
			const index = asciiKeyIndex(value);
			if (!index.has(folded)) fail(`${label} "${pointer}" was not found`, "JSON_PROJECTION_POINTER_NOT_FOUND");
			const candidate = index.get(folded);
			if (candidate === null || candidate === void 0) fail(`${label} "${pointer}" has an ambiguous ASCII case-insensitive key at segment ${segmentIndex}`, "JSON_PROJECTION_AMBIGUOUS_POINTER_REPAIR");
			effectiveSegment = candidate;
			repairs.push({
				kind: "ascii_case",
				segmentIndex,
				requestedSegment: segment,
				effectiveSegment
			});
		}
		effectiveSegments.push(effectiveSegment);
		value = value[effectiveSegment];
	}
	recordPointerResolution(tracker, effectiveSegments, repairs, label);
	return value;
}
function permitsRootArrayFallback(error) {
	return error instanceof JsonProjectionError && [
		"JSON_PROJECTION_INVALID_POINTER",
		"JSON_PROJECTION_POINTER_NOT_FOUND",
		"JSON_PROJECTION_POINTER_TYPE_MISMATCH"
	].includes(error.code);
}
function scalarSerializedBytes(value) {
	const serialized = JSON.stringify(value);
	if (serialized === void 0) fail("projected value is not a JSON scalar", "JSON_PROJECTION_NON_SCALAR_PROJECTION");
	return Buffer.byteLength(serialized, "utf8");
}
function consumeProjectionBudget(budget, bytes) {
	if (budget.usedBytes + bytes > MAX_PROJECTED_OUTPUT_BYTES) fail("JSON projection output exceeds the 4 MiB construction limit", "JSON_PROJECTION_OUTPUT_TOO_LARGE");
	budget.usedBytes += bytes;
}
function matchesWhere(row, sourceIndex, where, label) {
	return where.every((entry) => Object.is(resolvePointer(row, entry.segments, entry.pointer, entry.tracker, `${label} ${sourceIndex} equality filter`), entry.equals));
}
function projectValues(row, sourceIndex, projections, budget, label) {
	const values = {};
	for (const projection of projections) {
		const value = resolvePointer(row, projection.segments, projection.pointer, projection.tracker, `${label} ${sourceIndex} projection`);
		if (typeof value === "number") fail(`${label} ${sourceIndex} projection "${projection.pointer}" is numeric; use an exact-number tool`, "JSON_PROJECTION_NUMERIC_PROJECTION_UNSUPPORTED");
		if (value !== null && typeof value !== "string" && typeof value !== "boolean") fail(`${label} ${sourceIndex} projection "${projection.pointer}" is not a JSON scalar`, "JSON_PROJECTION_NON_SCALAR_PROJECTION");
		const bytes = scalarSerializedBytes(value);
		if (bytes > 65536) fail(`${label} ${sourceIndex} projected scalar exceeds the 64 KiB limit`, "JSON_PROJECTION_OUTPUT_TOO_LARGE");
		consumeProjectionBudget(budget, projection.name.length + bytes + 4);
		values[projection.name] = value;
	}
	return values;
}
function requireObjectRows(value, label) {
	return value.map((row, sourceIndex) => {
		if (!isRecord(row)) fail(`${label} row ${sourceIndex} must be an object`, "JSON_PROJECTION_ROW_TYPE_MISMATCH");
		return row;
	});
}
function pointerAudits(request) {
	return {
		array: pointerAudit(request.arrayTracker),
		where: request.where.map((entry) => pointerAudit(entry.tracker)),
		project: request.projections.map((entry) => ({
			name: entry.name,
			...pointerAudit(entry.tracker)
		})),
		...request.nested === void 0 ? {} : { nested: {
			array: pointerAudit(request.nested.arrayTracker),
			where: request.nested.where.map((entry) => pointerAudit(entry.tracker)),
			project: request.nested.projections.map((entry) => ({
				name: entry.name,
				...pointerAudit(entry.tracker)
			}))
		} }
	};
}
/**
* Project every strict match from a bounded JSON object-array in source order.
* No ranking, maximum, or inferred ordering semantics are applied.
*/
function projectJsonRows(input, rawRequest) {
	const request = compileRequest(rawRequest);
	const decoded = decodeInput(input);
	const evidenceSha256 = createHash("sha256").update(decoded.bytes).digest("hex");
	const root = parseStrictJson(decoded.text);
	if (!isRecord(root) && !Array.isArray(root)) fail("JSON root must be an object or array", "JSON_PROJECTION_ROOT_TYPE_MISMATCH");
	let selected;
	try {
		selected = resolvePointer(root, request.arraySegments, request.arrayPointer, request.arrayTracker, "array pointer");
	} catch (error) {
		if (!Array.isArray(root) || request.arraySegments.length === 0 || !permitsRootArrayFallback(error)) throw error;
		recordPointerResolution(request.arrayTracker, [], [{ kind: "root_array_fallback" }], "array pointer");
		selected = root;
	}
	if (!Array.isArray(selected)) fail(`array pointer "${request.arrayPointer}" must resolve to an array`, "JSON_PROJECTION_ARRAY_TYPE_MISMATCH");
	if (selected.length > 25e3) fail(`selected array exceeds the ${JSON_SELECTION_MAX_ROWS} row limit`, "JSON_PROJECTION_ROW_LIMIT_EXCEEDED");
	const sourceRows = requireObjectRows(selected, "selected array");
	const budget = { usedBytes: 0 };
	const rows = [];
	let totalNestedRows = 0;
	for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex++) {
		const row = sourceRows[sourceIndex];
		if (!matchesWhere(row, sourceIndex, request.where, "row")) continue;
		consumeProjectionBudget(budget, 48 + String(sourceIndex).length);
		const values = projectValues(row, sourceIndex, request.projections, budget, "row");
		let nestedResult;
		if (request.nested !== void 0) {
			const nestedArray = resolvePointer(row, request.nested.arraySegments, request.nested.arrayPointer, request.nested.arrayTracker, `row ${sourceIndex} nested array pointer`);
			if (!Array.isArray(nestedArray)) fail(`row ${sourceIndex} nested array pointer "${request.nested.arrayPointer}" must resolve to an array`, "JSON_PROJECTION_ARRAY_TYPE_MISMATCH");
			totalNestedRows += nestedArray.length;
			if (nestedArray.length > 25e3 || totalNestedRows > JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS) fail(`nested arrays exceed the ${JSON_PROJECTION_MAX_TOTAL_NESTED_ROWS} total row limit`, "JSON_PROJECTION_ROW_LIMIT_EXCEEDED");
			const nestedSourceRows = requireObjectRows(nestedArray, `row ${sourceIndex} nested array`);
			const nestedRows = [];
			for (let nestedSourceIndex = 0; nestedSourceIndex < nestedSourceRows.length; nestedSourceIndex++) {
				const nestedRow = nestedSourceRows[nestedSourceIndex];
				if (!matchesWhere(nestedRow, nestedSourceIndex, request.nested.where, `row ${sourceIndex} nested row`)) continue;
				consumeProjectionBudget(budget, 48 + String(nestedSourceIndex).length);
				nestedRows.push({
					sourceIndex: nestedSourceIndex,
					values: projectValues(nestedRow, nestedSourceIndex, request.nested.projections, budget, `row ${sourceIndex} nested row`)
				});
			}
			nestedResult = {
				arrayPointer: request.nested.arrayPointer,
				...request.nested.where.length === 0 ? {} : { where: request.nested.where.map((entry) => ({
					pointer: entry.pointer,
					equals: entry.equals
				})) },
				rowCount: nestedSourceRows.length,
				matchCount: nestedRows.length,
				rows: nestedRows
			};
		}
		rows.push({
			sourceIndex,
			values,
			...nestedResult === void 0 ? {} : { nested: nestedResult }
		});
	}
	const result = {
		complete: true,
		truncated: false,
		evidenceSha256,
		arrayPointer: request.arrayPointer,
		...request.where.length === 0 ? {} : { where: request.where.map((entry) => ({
			pointer: entry.pointer,
			equals: entry.equals
		})) },
		pointerAudits: pointerAudits(request),
		rowCount: sourceRows.length,
		matchCount: rows.length,
		rows
	};
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_OUTPUT_BYTES) fail("JSON projection output exceeds the 8 MiB limit", "JSON_PROJECTION_OUTPUT_TOO_LARGE");
	return result;
}
//#endregion
export { JsonSelectionError as a, SearchFilterViolationError as c, normalizeAllowedDomains as d, sourceMatchesDomain as f, selectJsonNumericTies as i, enforceAllowedSources as l, projectJsonRows as n, selectJsonMaxTies as o, JsonNumericSelectionError as r, SearchFilterError as s, JsonProjectionError as t, filterAllowedSources as u };

//# sourceMappingURL=json-projection-DYx4Yk_W.mjs.map