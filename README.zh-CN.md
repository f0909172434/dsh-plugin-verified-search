# dsh-plugin-verified-search

[![CI](https://github.com/f0909172434/dsh-plugin-verified-search/actions/workflows/ci.yml/badge.svg)](https://github.com/f0909172434/dsh-plugin-verified-search/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/f0909172434/dsh-plugin-verified-search?display_name=tag)](https://github.com/f0909172434/dsh-plugin-verified-search/releases)
[![License](https://img.shields.io/github/license/f0909172434/dsh-plugin-verified-search)](LICENSE)

[English](README.md) · [繁體中文](README.zh.md) · [简体中文](README.zh-CN.md)

**为 DeepSeek Harness 提供可审计的当前来源检索。**

本插件会替换具备搜索能力的 agent 所继承的 `web_search`，改用有界工作流，让来源范围、保留证据、确定性的 JSON 选择和未解缺口都清晰可见。它是 [deepseek-harness Discussion #332](https://github.com/deepseek-ai/deepseek-harness/discussions/332) 的可安装配套，也会挂载 [Discussion #344](https://github.com/deepseek-ai/deepseek-harness/discussions/344) 讨论的时间上下文。

它验证的是工作流和 structured-source postcondition，**不会**认证 publisher 的内容一定正确，也不保证上游搜索索引永远最新。

![有界证据工作流架构](docs/assets/architecture.zh-CN.svg)

## 发布状态

| 产品线 | 安装 ref | Model-facing 工具 | 验证边界 |
| --- | --- | --- | --- |
| 稳定版 | `v0.1.1` | `verified_search` | 维护者验证的 release tag，包含软件包 artifact、checksums、跨平台 CI、干净 profile 安装和已记录的真实 provider conformance |
| 实验快照 | `c29b531a6c2e52200d454aa9ded42214ba8c0014` | 下列全部五个工具 | 2026-08-16 当时最后一个绿色 `main` 快照；250 tests 和 42-case frozen offline corpus 全部通过 |
| 移动中的 `main` | `main` | 未发布开发代码 | 不要在可复现测试中直接安装；不同 commit 之间的行为和 generated artifacts 可能变化 |

> **外部独立验证：暂无。** Repository 提供内部 deterministic tests、CI、package reproducibility checks 和维护者执行的 conformance evidence；这些信号不会被描述成第三方审查。

## 前置要求

- DeepSeek Harness `0.1.0-rc.6` 和 Cordis `4.0.1`。
- Node.js `22.19.x` 或 `24.x`。
- 通过 Harness credential service 或启动环境提供 `DEEPSEEK_API_KEY`。
- 使用原本就有搜索能力的 preset；本插件不会给内置 `minimal` preset 扩权。
- CI 覆盖 Ubuntu 和 Windows；macOS 目前不属于正式支持契约。

更换 Harness、Cordis、Node 或 package-manager 版本前，请先阅读[兼容性契约](docs/COMPATIBILITY.md)。

## 一分钟安装

### 稳定版 `verified_search`

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1
dsh --profile web --dump-config
dsh web
```

等价的单行 PowerShell 命令：

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#v0.1.1; dsh --profile web --dump-config; dsh web
```

Release 已提交 prebuilt `lib/`，并且没有 install-time build script；固定 Git ref 安装时，不会在用户机器上执行本 repository 的开发工具链。

### 五工具实验快照

```powershell
dsh plugin --profile web add github:f0909172434/dsh-plugin-verified-search#c29b531a6c2e52200d454aa9ded42214ba8c0014
dsh --profile web --dump-config
dsh web
```

该快照只适合开发和评估。需要可复现结果时，不要把明确 commit 替换为会移动的 `main`。

如果 deployment 已挂载 Discussion #344 的 `time-context` row，请在启动 Harness 前设置 `DSH_VERIFIED_SEARCH_DISABLE_TIME_CONTEXT=1`，避免重复的 clock injector。

### 回滚

```powershell
dsh plugin --profile web remove dsh-plugin-verified-search
dsh web
```

## 最小 quickstart

向具备搜索能力的 agent 提出有界、带绝对日期的问题，例如：

> 找出截至 2026-08-14 的 DeepSeek 当前旗舰 API model。只使用 `api-docs.deepseek.com`。如果保留来源没有包含答案的 excerpt，请报告 unresolved，不要用记忆补答案。

对应的 model-facing `verified_search` arguments：

```json
{
  "query": "DeepSeek current flagship API model as of 2026-08-14",
  "allowed_domains": ["api-docs.deepseek.com"]
}
```

预期行为：

- 将原生 provider allowlist 发送给上游；
- 在本地按照精确 hostname 或 subdomain 对返回的 structured sources 再做 postfilter；
- credential-bearing URL 和敏感／跟踪 URL 组件会在组成 session-visible 结果前被拒绝或移除；
- 只有标题或 URL、却没有保留 citation excerpt 的来源，不会升级为已验证证据；
- 证据缺口会保持可见，不会被旧答案或模型记忆替代。

需要独立比较来源时，另做一次不限制 domain 的查询。Allowlist 是“返回 structured-source hostname”的 postcondition，不是 network-egress 或 privacy boundary。

## 选择正确工具

| 工具 | 适合的任务 | 有界结果 |
| --- | --- | --- |
| `verified_search` | 单一、狭窄、会变化的事实查询 | Structured-source hostname postfilter，citation excerpt 缺口保持可见 |
| `verified_research` | 多实体或多 claim 研究 | 每个 claim 的保留 excerpt、retrieval metadata、content hash 和明确 unresolved claims |
| `verified_json_selection` | 从官方 JSON feed 做 latest／as-of 选择 | 严格 RFC 6901、日期 cutoff、最大日期和全部 final ties |
| `verified_json_numeric_extrema` | JSON 的精确数值最大／最小值 | 直接比较 source lexeme、不经过 IEEE-754，并保留全部 final ties |
| `verified_json_projection` | 按来源顺序取得全部严格匹配 JSON rows | 有界 parent／nested projection、可审计 pointer repair、不推测排序语义 |

只有 `verified_search` 属于稳定的 `v0.1.1`。其余四个工具都属于固定 `0.3.0-experiment.0` 快照中的实验功能。

### 复合研究示例

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

`evidence_must_include` 是规范化 substring postcondition，不是语义 entailment 裁判。不要把未知答案本身放进 required phrase，只为了确认模型自己的猜测。

## 失败行为

本插件会 fail closed，或者把状态保持为明确 unresolved。

- 无效 hostname allowlist、credential-bearing URL、不安全 redirect、非 public resolved address、不支持 media、错误 charset 声明、无效 UTF-8 和资源上限违规，都会产生可见失败。
- Structured JSON 操作会拒绝无效 JSON、duplicate key、过深 nesting、无效 pointer、缺少字段、不支持的 numeric projection、row／tie／output 超限，以及无法取得 exact number lexeme 的 runtime。
- Discovery 可以跳过已知 binary path；明确提供但不支持的 binary seed 会留下可见失败，不会被静默重新解释。
- Provider 或 fetch timeout 会中止有界工作，并保留证据缺口。
- `allClaimsCovered`、`complete: true` 或 `truncated: false` 只描述声明的有界操作；不证明来源新鲜度、语义 entailment、publisher authenticity、feed completeness 或 pagination 已耗尽。

## 信任与安全边界

本插件可以保证：本地过滤后返回的 structured sources 符合明确 hostname allowlist。实验版完整页面 reader 还会把抓取限制在有界 public HTTPS target，并执行 DNS/IP validation、pinned transport、redirect checks、text/JSON media 和 charset validation，以及 byte/time limits。

它**不能证明**：

- provider 的私有 candidate pool 或生成 prose 只使用 allowlist；
- provider 没有自行抓取其他页面或跟随 allowlist 以外的 redirect；
- 上游索引一定包含最新页面，或时间 ranking 正确；
- 保留的 phrase 已在语义上支持 claim，或者能正确处理否定；
- caller 指定的 seed URL 一定 canonical、first-party 或 authoritative；
- API response 真实、完整、没有 pagination、排序语义正确或事实正确；
- public page 的文字可以安全地当作指令执行。

Search query 会成为 durable Harness session data。不要把 secret、signed URL 或私人数据放入 query。私密报告和完整 threat boundary 请见 [SECURITY.md](SECURITY.md)。

## 验证快照

固定的实验快照记录：

- source commit：`c29b531a6c2e52200d454aa9ded42214ba8c0014`；
- push CI：Ubuntu 和 Windows、Node `22.19.x` 和 `24.x` 全部通过；
- HonestCI baseline：**250 tests**，0 failures、0 errors、0 skipped；
- frozen offline corpus：**42/42 cases**；
- registered offline result digest：`sha256:3002001da02d0b8501bcc97ee867109f1bfbf0e1a227d87845db81da658ea5c0`；
- committed `lib/` 和 package-content reproducibility checks；
- 外部独立验证：**暂无**。

Machine-readable 的 lifecycle、runtime、capability 和 architecture facts 位于 [`capabilities.json`](capabilities.json) 和 [`architecture.json`](architecture.json)。评估方法请见 [docs/OFFLINE_EVALUATION.md](docs/OFFLINE_EVALUATION.md)、[docs/PROPERTY_TESTING.md](docs/PROPERTY_TESTING.md) 和 [docs/HONEST_CI_DOGFOOD.md](docs/HONEST_CI_DOGFOOD.md)。

## 实测观察

![两个困难官方来源任务的完成率变化](docs/assets/benchmark.zh-CN.svg)

两个 frozen-ledger live tasks 在 600 秒外层上限下得到以下单次观察：

| 任务 | 修正前 | 实验工作流 | Terminal 时间 |
| --- | ---: | ---: | ---: |
| Go 支持 releases、security scope 和 Linux artifact provenance | 0/8 | **8/8** | 317 秒 |
| EU AI Act 修法时间线和 GPAI 过渡期限 | 0/8 | **6/8** | 307 秒 |
| **合计** | **0/16** | **14/16（87.5%）** | — |

已回答的 14 个 requested fields 都有保留的官方来源证据；另外两个字段保持 unresolved。这些只是单次观察，不是标准化 benchmark、统计估计、latency target 或 release guarantee。两次成功 terminal run 都超过 240 秒，因此 timeout 和 latency 仍是重要改进方向。

## 配置

Bundle 可以从 Harness credential service 或 launch environment 读取 `DEEPSEEK_API_KEY`。可选配置包括：

| 类别 | Fields |
| --- | --- |
| Provider | `apiKeyEnv`、`apiKey`、`baseURL`、`model`、`apiVersion` |
| Search limits | `maxTokens`、`maxUses`、`maxResults`、`searchTimeoutMs` |
| Experimental research | `researchTimeoutMs`、`researchMaxResults` |

`researchMaxResults` 默认为 24，范围 4–32，并且不得低于本次调用声明的 claim count。配置变更属于 compatibility 和 resource-boundary 变更，不只是性能调参。

## 开发和完整验证

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
pnpm run build
pnpm run evaluate:offline
npm pack --dry-run --ignore-scripts --json
git diff --check
git diff --exit-code -- lib
```

第二次 build 不得产生新的 `lib/` diff。Frozen offline digest 发生变化代表可能存在行为变更；不要只为让 CI 变绿就更新 expected digest。

## 文档

- [架构和 ownership boundaries](docs/ARCHITECTURE.md)
- [兼容性契约](docs/COMPATIBILITY.md)
- [Frozen offline evaluation](docs/OFFLINE_EVALUATION.md)
- [Property-testing contract](docs/PROPERTY_TESTING.md)
- [HonestCI dogfooding evidence](docs/HONEST_CI_DOGFOOD.md)
- [单人串行维护 roadmap](docs/ROADMAP.md)
- [维护规则](MAINTENANCE.md)
- [安全策略](SECURITY.md)
- [变更记录](CHANGELOG.md)

## 与上游核心修复的关系

本 repository 是可部署的 compatibility layer。Provider-neutral Harness core change 仍位于 [`ce4d0455c`](https://github.com/f0909172434/deepseek-harness/commit/ce4d0455c637e5ba91fbb7b3a88725e7ec097371)。如果官方项目发布等价的有界能力，本插件可以转为额外验证模式，或通过有文档的 migration path 退役。

## 安全报告

如果怀疑存在 credential leak、allowlist bypass 或 unsafe page-fetch path，请使用本 repository 的 GitHub private security-advisory interface。不要把 API key、signed URL、私人 query、私人 excerpt 或 raw session log 粘贴到 public issue。

## License

MIT
