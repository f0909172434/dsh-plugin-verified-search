from __future__ import annotations

import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEMP = Path(__file__).resolve().parent


def decode_chunks(prefix: str) -> bytes:
    chunks = sorted(TEMP.glob(f"{prefix}.*"))
    if not chunks:
        raise RuntimeError(f"missing {prefix} payload chunks")
    encoded = b"".join(path.read_bytes() for path in chunks)
    return base64.b64decode(encoded, validate=True)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one replacement target, found {count}")
    return text.replace(old, new, 1)


selector = decode_chunks("selector")
lossless = decode_chunks("lossless")
if len(selector) != 19_617:
    raise RuntimeError(f"unexpected numeric selector size: {len(selector)}")
if len(lossless) != 5_475:
    raise RuntimeError(f"unexpected lossless-number module size: {len(lossless)}")
(ROOT / "src/json-numeric-selection.ts").write_bytes(selector)
(ROOT / "src/json-lossless-number.ts").write_bytes(lossless)

architecture_path = ROOT / "architecture.json"
architecture = json.loads(architecture_path.read_text(encoding="utf-8"))
engine = next(layer for layer in architecture["layers"] if layer["name"] == "engine")
files = [path for path in engine["files"] if path != "src/json-lossless-number.ts"]
insert_at = files.index("src/json-numeric-selection.ts")
files.insert(insert_at, "src/json-lossless-number.ts")
engine["files"] = files
architecture["size_exceptions"] = [
    entry for entry in architecture["size_exceptions"]
    if entry["path"] != "src/json-numeric-selection.ts"
]
if len(architecture["size_exceptions"]) != 5:
    raise RuntimeError("numeric selector exception removal did not leave five growth stops")
architecture_path.write_text(
    json.dumps(architecture, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
    newline="\n",
)

capabilities_path = ROOT / "capabilities.json"
capabilities = json.loads(capabilities_path.read_text(encoding="utf-8"))
capabilities["architecture_contract"]["size_exception_count"] = len(architecture["size_exceptions"])
capabilities_path.write_text(
    json.dumps(capabilities, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
    newline="\n",
)

architecture_doc_path = ROOT / "docs/ARCHITECTURE.md"
architecture_doc = architecture_doc_path.read_text(encoding="utf-8")
if "src/json-lossless-number.ts" not in architecture_doc:
    architecture_doc = replace_once(
        architecture_doc,
        "src/json-primitives.ts\nsrc/json-selection.ts\nsrc/json-numeric-selection.ts\n",
        "src/json-primitives.ts\nsrc/json-lossless-number.ts\nsrc/json-selection.ts\nsrc/json-numeric-selection.ts\n",
        "engine source list",
    )
    architecture_doc = replace_once(
        architecture_doc,
        """`json-primitives.ts` owns the bounded strict-JSON scanner, UTF-8 and Unicode input checks,
RFC 6901 pointer parsing, and Gregorian/UTC date normalization. Callers provide the failure
adapter, so the shared implementation does not replace each public tool's stable error-code
vocabulary. `json-selection.ts` is the first migrated consumer; numeric selection and strict
projection remain separate follow-up extractions.
""",
        """`json-primitives.ts` owns the bounded strict-JSON scanner, UTF-8 and Unicode input checks,
RFC 6901 pointer parsing, and Gregorian/UTC date normalization. Callers provide the failure
adapter, so the shared implementation does not replace each public tool's stable error-code
vocabulary.

`json-lossless-number.ts` builds on that strict scanner and owns exact source-token number
representation, token and lexeme limits, normalization, and decimal comparison without
IEEE-754 conversion or decimal expansion. `json-selection.ts` and
`json-numeric-selection.ts` now consume the extracted engines while retaining their own
public result and error contracts. Strict projection remains the next JSON migration.
""",
        "engine ownership description",
    )
    architecture_doc = replace_once(
        architecture_doc,
        "| `json-numeric-selection.ts` | 29,228 | 30,000 | 20,000 | adopt shared parsing while retaining lossless numbers |\n",
        "",
        "numeric debt row",
    )
    architecture_doc = replace_once(
        architecture_doc,
        """The first extraction reduced `json-selection.ts` from its 24,306-byte baseline to 17,755
bytes and moved 9,468 bytes of reusable parsing policy into `json-primitives.ts`. Both files
now satisfy the default budget, so the date selector's temporary exception has been removed.
A feature PR may not increase any remaining ceiling. If necessary work would cross a ceiling,
the required extraction is part of that PR or precedes it in a separate PR.
""",
        """The first extraction reduced `json-selection.ts` from its 24,306-byte baseline to 17,755
bytes and moved 9,468 bytes of reusable parsing policy into `json-primitives.ts`.

The second extraction reduced `json-numeric-selection.ts` from its 29,228-byte baseline to
19,617 bytes and moved 5,475 bytes of lossless token parsing and comparison into
`json-lossless-number.ts`. All four JSON modules named in these two extractions are now below
the default budget, so the date and numeric selector exceptions have been removed. Five
growth stops remain.

A feature PR may not increase any remaining ceiling. If necessary work would cross a ceiling,
the required extraction is part of that PR or precedes it in a separate PR.
""",
        "extraction measurements",
    )
    architecture_doc = replace_once(
        architecture_doc,
        """1. **Shared strict JSON primitives — in progress.** The bounded scanner, input decoding,
   RFC 6901 parsing, and ISO-date normalization now live in `json-primitives.ts`, and the date
   selector uses them without changing its public errors. Migrate numeric selection next,
   then projection, while retaining exact-number and pointer-repair semantics.
""",
        """1. **Shared JSON parsing engines — in progress.** The bounded scanner, input decoding,
   RFC 6901 parsing, and ISO-date normalization live in `json-primitives.ts`. Exact source
   number tokens and decimal comparison live in `json-lossless-number.ts`. Date and numeric
   selectors use these engines without changing their public errors. Migrate projection next
   while retaining pointer-repair audit semantics.
""",
        "decomposition order",
    )
architecture_doc_path.write_text(architecture_doc, encoding="utf-8", newline="\n")

changelog_path = ROOT / "CHANGELOG.md"
changelog = changelog_path.read_text(encoding="utf-8")
if "A bounded lossless-number engine" not in changelog:
    changelog = replace_once(
        changelog,
        """- A revised 246-test HonestCI baseline derived from completed default-branch run
  `31938769457` after the strict-JSON primitive extraction added four durable behavior tests.
""",
        """- A revised 246-test HonestCI baseline derived from completed default-branch run
  `31938769457` after the strict-JSON primitive extraction added four durable behavior tests.
- A bounded lossless-number engine for exact JSON source tokens, token and lexeme limits,
  normalized decimal representation, and comparison without IEEE-754 conversion.
""",
        "lossless engine changelog entry",
    )
    changelog = replace_once(
        changelog,
        """- `json-selection.ts` now delegates shared parsing and date rules through a caller-specific
  error adapter. Its public result shape and `JSON_SELECTION_*` vocabulary remain unchanged.
- The date selector and its new primitive module both fit the 20,000-byte default budget, so
  the `json-selection.ts` architecture exception has been removed; six growth stops remain.
""",
        """- `json-selection.ts` now delegates shared parsing and date rules through a caller-specific
  error adapter. Its public result shape and `JSON_SELECTION_*` vocabulary remain unchanged.
- `json-numeric-selection.ts` now delegates shared input, pointer, date, strict-JSON, exact
  token, and decimal-comparison rules through caller-specific failure adapters. Its public
  result shape, lossless number lexemes, and `JSON_NUMERIC_SELECTION_*` vocabulary remain
  unchanged.
- The date selector, numeric selector, strict-JSON primitive module, and lossless-number
  module all fit the 20,000-byte default budget. Their temporary exceptions have been
  removed; five growth stops remain.
""",
        "numeric migration changelog entry",
    )
    changelog = replace_once(
        changelog,
        "- Six production modules remain above the default size budget and are tracked as temporary\n",
        "- Five production modules remain above the default size budget and are tracked as temporary\n",
        "known architecture debt count",
    )
changelog_path.write_text(changelog, encoding="utf-8", newline="\n")
