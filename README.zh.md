# dsh-plugin-verified-search

[English](README.md) · [繁體中文](README.zh.md) · [简体中文](README.zh-CN.md)

這是一個可直接安裝到 DeepSeek Harness 的社群外掛，專門處理「目前、最新、截至某日」等需要明確來源範圍與誠實揭露證據缺口的搜尋。

本專案是 [deepseek-harness Discussion #332](https://github.com/deepseek-ai/deepseek-harness/discussions/332) 的可部署配套。它不宣稱搜尋索引永遠最新，也不把模型生成的摘要當成證據；它讓搜尋流程、來源邊界、擷取內容與未解欄位都可以被稽核。

![有界證據工作流程架構](docs/assets/architecture.zh.svg)

> **尚未發布的實驗版本：** `main` 目前包含 `0.3.0-experiment.0` 的複合研究與結構化 JSON 工具。這些功能不屬於已審查的 `v0.1.1` 穩定標籤。測試未發布程式碼時，請固定到明確 commit，不要依賴會移動的分支。

## 它解決什麼

DeepSeek Harness rc.6 原本的 `web_search` 只有一個 `query`，另一個獨立的 Flash 模型再決定是否搜尋與如何產生子查詢。預設組合也沒有完整頁面讀取，因此主 agent 常只能看到標題與 URL；「最新模型比較」可能因此混入舊版本，卻沒有足夠內容可驗證。

此外，Harness 已經提供 `dsh-time-context`，但 rc.6 的預設 composition 沒有掛載它；這正是 [Discussion #344](https://github.com/deepseek-ai/deepseek-harness/discussions/344) 指出的時間上下文缺口。

本外掛做了以下事情：

- 每 60 秒掛載 Harness 內建的 `dsh-time-context`；
- 對有搜尋能力的 agent 隱藏並阻擋舊 `web_search`，但不替 `minimal` preset 擴權；
- 提供 `verified_search`、`verified_research` 與三個有界 JSON 工具；
- 將 1–20 個裸 ASCII hostname 正規化，拒絕 scheme、path、port、wildcard、Unicode hostname 與 IP literal；
- 將 `allowed_domains` 傳給 provider，同時在本機對回傳的結構化來源做 hostname postfilter；
- 在來源進入工具結果或 session 前移除 URL credential、敏感／追蹤 query 參數與 fragment；
- 將搜尋 query 與 credential-free request envelope 先寫入 Harness 已知的 durable event，再送出 provider request；
- 將所有遠端標題、URL、excerpt、JSON scalar 明確標成不可信資料；
- 在有界研究完成後阻擋同一 turn 的 shell、Python、另一個搜尋或 MCP fallback，要求 agent 直接回答並列出 unresolved claims。

## 工具一覽

| 工具 | 適合的任務 | 可驗證的邊界 |
| --- | --- | --- |
| `verified_search` | 單一、狹窄、可變動的查詢 | 回傳的結構化來源 URL 符合 allowlist；缺 excerpt 時降低信心 |
| `verified_research` | 多來源、多實體、多欄位比較 | 每個 covered claim 都保留一段完整、連續、可見的擷取文字與 hash |
| `verified_json_selection` | 官方 JSON feed 的截至日期最大值與同日 ties | 嚴格 RFC 6901、日期 cutoff、最大日期、所有 final ties |
| `verified_json_numeric_extrema` | JSON 數值最大／最小與全部 ties | 使用來源中的精確 number lexeme，比較不經 IEEE-754 |
| `verified_json_projection` | 依來源順序投影全部嚴格相符列與一層 nested array | 不排序、不猜 latest；pointer repair 必須唯一且完整記錄 |

## `verified_research` 的證據契約

一次呼叫可包含 1–4 個 lane，每個 lane 1–6 個 claim，整體最多 24 個 claim。每個 lane 應提供：

- 明確的 `allowed_domains`；
- 最多兩個已知的一手 `seed_urls`；
- 一條與首次 query 不同、且不包含待驗證答案候選值的 `gap_query`；
- 每個 claim 的 `query`、`evidence_must_include`、`value_kind` 與 typed `scope`。

`evidence_must_include` 不是 regex，也不是語意裁判。它會將大小寫、Unicode 空白、常見彎引號與 dash 變體正規化後，要求每個指定片語都出現在最終保留的 excerpt。不要把未知答案本身塞進片語，否則只是讓模型確認自己的猜測。

`scope` 有兩種：

- `document`：用 page-global 的候選中立標記確認文件身分，可再綁定 `YYYY-MM` 文件月份；
- `event_row`：要求 row-local 標記，並以指定月份或 `after + select:first` 選取事件列。含 `Released`、`Last Update` 等 metadata label 的列不能冒充事件日期。

每個 covered claim 最多保留一段完整、連續且不超過 2,000 字元的 excerpt，並附上：

- `excerptStart` / `excerptEnd`；
- `retrievedAt`；
- normalized page text 的 SHA-256；
- claim status：`covered`、`blocked` 或 `missing`。

Provider snippet 只用於 discovery，不能升格為已驗證證據。

### 安全的完整頁面讀取

頁面讀取器刻意維持狹窄邊界：

- 僅接受 HTTPS 443、DNS hostname、無 URL credential；
- DNS 回傳的每個 IP 都必須是 public address，並把已驗證 IP 綁定到實際 TLS connection；
- 每個 redirect hop 都重新檢查 URL、allowlist、DNS 與 IP，普通 redirect 不得跨 origin；
- 限制 redirect 次數、總時間、body idle、bytes、media type 與 content encoding；
- UTF-8 採 fatal decode；明確宣告的 `ISO-8859-1`／`windows-1252` 依 WHATWG 對映，其餘 charset fail closed；
- 不執行 script、不帶 cookie、不接受任意 binary 文件；
- discovery 會略過 `/printable/pdf`、PDF、Office 與 ZIP 路徑，明確指定的 binary seed 則會留下可見失敗。

唯一跨 origin 例外是精確的 EUR-Lex `uri=CELEX:...` 英文 legal-content request：必須同時 allowlist `eur-lex.europa.eu` 與 `publications.europa.eu`，才能沿官方 Publications Office resolver 取得固定格式的 Cellar XHTML 表示。這個例外由顯式狀態機約束，不適用於其他 202 或 redirect。

## 結構化 JSON 工具

所有 JSON 工具都先以有界 scanner 檢查 depth、duplicate key、UTF-8／Unicode，再讓 `JSON.parse` 建立物件。網路 feed 上限為 2 MiB；pure selector API 另有 8 MiB input、25,000 rows、256 ties、64 KiB scalar、4 MiB construction 與 8 MiB output 等限制。

`verified_json_projection` 只投影 string、boolean 或 null。普通 `JSON.parse` 無法保留大型 JSON number 的精確 lexeme，因此 numeric filter／projection 會被拒絕；需要數值比較時改用 `verified_json_numeric_extrema`。

若 JSON root 本來就是 array，但 model 誤填非空 `array_pointer`，projection 可以回到 root array，並在 `pointerAudits` 記錄 `root_array_fallback`。物件 key 只有在「唯一 ASCII case-insensitive match」時才可修復；歧義、非 ASCII 猜測或不同 row 產生不一致 repair 都會 fail closed。工具不會猜 value、filter、排序或 field alias。

## 實測結果

![兩個困難官方來源任務的完成率變化](docs/assets/benchmark.zh.svg)

這輪以兩個不同領域、預先凍結 requested-field ledger 的困難搜尋測試目前版本：

| 任務 | 修正前 | 目前實驗版 | Terminal 時間 |
| --- | ---: | ---: | ---: |
| Go 支援線、security fixes 與 Linux artifact provenance | 0/8 | **8/8** | 317 秒 |
| EU AI Act 修法時序與 GPAI 過渡期限 | 0/8 | **6/8** | 307 秒 |
| **合計** | **0/16** | **14/16（87.5%）** | — |

已回答的 14 個 requested field 全部有保留的一手來源證據，grounded precision 為 14/14；沒有輸出無證據的 requested assertion。EU 剩餘兩欄明確標為 unresolved。這只是 600 秒外層上限下的單次觀測，不是標準化 benchmark、統計估計或 production SLO。延遲仍然偏高，而且兩題都超過 240 秒。

## 安裝

安裝已審查的穩定標籤：

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1
dsh --profile web --dump-config
dsh web
```

測試尚未發布的 v0.3 workflow 時，請固定到已驗證的實驗 commit：

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#67d337ebb754b51b703df3f690310482c0f2d14d
dsh --profile web --dump-config
dsh web
```

如果 deployment 已經掛載 Discussion #344 的 `time-context` row，啟動 Harness 前設定 `DSH_VERIFIED_SEARCH_DISABLE_TIME_CONTEXT=1`，避免兩個 clock injector。

回滾：

```powershell
dsh plugin --profile web remove dsh-plugin-verified-search
dsh web
```

## 使用範例

單一 first-party 查詢：

```json
{
  "query": "DeepSeek current flagship model as of 2026-08-14",
  "allowed_domains": ["deepseek.com"]
}
```

複合研究 lane：

```json
{
  "query": "Identify current flagship API model IDs as of 2026-08-14",
  "lanes": [
    {
      "id": "deepseek",
      "query": "DeepSeek current flagship API model ID as of 2026-08-14",
      "required_claims": [
        {
          "id": "model_id",
          "query": "latest DeepSeek flagship API model identifier",
          "evidence_must_include": ["Model ID"],
          "value_kind": "generic_text",
          "scope": {"kind": "document", "must_include": ["DeepSeek"]}
        }
      ],
      "allowed_domains": ["api-docs.deepseek.com"],
      "seed_urls": ["https://api-docs.deepseek.com/api/list-models/"],
      "gap_query": "site:api-docs.deepseek.com/api/list-models model IDs 2026-08-14"
    }
  ]
}
```

## 保證與限制

當 `allowed_domains` 存在時，外掛回傳的每個結構化來源都必須匹配 allowlist；越界來源會在本機被移除，只回報數量，不暴露其 URL、標題或 excerpt。

但外掛**不能證明**：

- provider 的內部 candidate pool 只使用 allowlist；
- 上游索引包含最新頁面或 ranking 的時間順序正確；
- `page_age` 是 ISO publication date；
- URL 或 caller-supplied seed 必然是 canonical／first-party；
- phrase、typed value gate 或 `allClaimsCovered` 已證明語意 entailment；
- fetched API 沒有 pagination，或已回傳完整 corpus；
- publisher 的資料真實、單位正確、版本仍有效；
- public allowlisted 頁面中的文字可以被當成指令執行。

所以本專案只把自己描述為「可驗證的 workflow 與 structured-source postcondition」，不保證每個答案永遠正確或最新。

## 開發與驗證

```powershell
pnpm install
pnpm run check
pnpm test
pnpm run build
npm pack --dry-run --ignore-scripts --json
```

目前測試涵蓋 hostname／legacy IP、credential-safe failure、request-before-dispatch、provider wire、allowlist postfilter、seed-first claim coverage、search barrier、abort quiescence、SSRF／redirect、charset、EUR-Lex Cellar、bounded HTML／JSON、完整 model-visible excerpt、typed claim scopes、exact numeric lexeme、all-tie retention、pointer repair、turn-scoped finalization 與 agent lifecycle。

## 與 Harness 核心修復的關係

這個外掛是可部署的相容層。對 Harness provider-neutral `ctx.web` contract 與內建 providers 的核心修復仍在 [`ce4d0455c`](https://github.com/f0909172434/deepseek-harness/commit/ce4d0455c637e5ba91fbb7b3a88725e7ec097371)。若官方專案合併相同能力，本外掛可以改為額外驗證模式或退役。

## 安全回報

請透過本 repository 已啟用的 GitHub private security-advisory interface 回報 credential leak、allowlist bypass 或 unsafe page-fetch path。不要把 API key、signed URL、含私人資料的 search query、私人 excerpt 或原始 session log 貼到 public issue。

## License

MIT
