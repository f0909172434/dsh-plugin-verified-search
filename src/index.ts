import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SearchOptions, VerifiedSearchWireRequest } from './types.js'
import { createVerifiedSearchTool, installVerifiedSearchPolicy } from './tool.js'
import { createVerifiedResearchTool } from './research.js'
import { createVerifiedJsonSelectionTool } from './json-tool.js'

export {
  normalizeAllowedDomains,
  filterAllowedSources,
  enforceAllowedSources,
  SearchFilterError,
  SearchFilterViolationError,
} from './domains.js'
export { mapResponse, search, searchInstruction, VerifiedSearchError } from './provider.js'
export { createVerifiedSearchTool, formatResult, installVerifiedSearchPolicy } from './tool.js'
export { createVerifiedResearchTool, formatResearchResult, research } from './research.js'
export {
  createVerifiedJsonSelectionTool,
  formatJsonSelectionResult,
  selectFetchedJson,
} from './json-tool.js'
export { JsonSelectionError, selectJsonMaxTies } from './json-selection.js'
export type { JsonSelectionRequest, JsonSelectionResult } from './json-selection.js'
export type { PageFetcher, SearchRunner } from './research.js'
export { extractPageEvidence, normalizeFetchedPage } from './evidence.js'
export type { NormalizedPage } from './evidence.js'
export { EvidenceFetchError, fetchEvidencePage, isPublicAddress } from './page-fetch.js'
export type { FetchedPage, FetchEvidenceOptions, ResolvedAddress } from './page-fetch.js'
export type {
  SearchOptions,
  VerifiedResearchLane,
  VerifiedResearchLaneResult,
  VerifiedResearchLaneStatus,
  VerifiedResearchRequest,
  VerifiedResearchResult,
  VerifiedResearchSource,
  VerifiedPageEvidence,
  VerifiedSearchRequest,
  VerifiedSearchResult,
  VerifiedSearchSource,
  VerifiedSearchWireRequest,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A blank live agent switched to a different standing preset. */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
  }
}

/** Append the rc.6 persistence-known DeepSeek native-search protocol event. */
function recordSearchRequest(session: Session, request: VerifiedSearchWireRequest): void {
  // The event is declared by the built-in search package rather than the core
  // session package. Avoid publishing a competing module augmentation from an
  // out-of-tree plugin; the release test pins the runtime known-event registry.
  const append = session.append.bind(session) as (type: string, data: unknown) => unknown
  append('web/deepseek-search-llm-request', request)
}

export const name = 'verified-search'
export const inject = ['agents', 'tools', 'systemPrompt']

export interface Config {
  /** Credential reference resolved per search. */
  apiKeyEnv?: string
  /** Optional literal key. Prefer the Harness Models page or launch environment. */
  apiKey?: string
  baseURL?: string
  model?: string
  apiVersion?: string
  maxTokens?: number
  maxUses?: number
  maxResults?: number
  searchTimeoutMs?: number
  researchTimeoutMs?: number
  researchMaxResults?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  apiKey: z.string().role('secret'),
  baseURL: z.string().default('https://api.deepseek.com/anthropic/v1'),
  model: z.string().default('deepseek-v4-flash'),
  apiVersion: z.string().default('2023-06-01'),
  maxTokens: z.number().step(1).min(1).default(4096),
  maxUses: z.number().step(1).min(1).default(5),
  maxResults: z.number().step(1).min(1).default(8),
  searchTimeoutMs: z.number().step(1).min(1).default(60_000),
  researchTimeoutMs: z.number().step(1).min(1).default(150_000),
  // At least one retained slot must remain available for each of four lanes.
  researchMaxResults: z.number().step(1).min(4).max(32).default(16),
})

type ResolvedConfig = Required<Omit<Config, 'apiKey'>> & Pick<Config, 'apiKey'>

/** Install the tool/policy into one live agent scope. Exported for tests. */
export function installForAgent(
  agentCtx: Context,
  options: () => SearchOptions,
  timeoutMs = 60_000,
  researchTimeoutMs = 150_000,
  researchMaxResults = 16,
): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(installVerifiedSearchPolicy(agentCtx))
    disposers.push(agentCtx.tools.register(createVerifiedSearchTool(options, timeoutMs)))
    disposers.push(agentCtx.tools.register(createVerifiedResearchTool(options, researchTimeoutMs, researchMaxResults)))
    disposers.push(agentCtx.tools.register(createVerifiedJsonSelectionTool(Math.min(researchTimeoutMs, 60_000))))
  } catch (error: unknown) {
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.toReversed()) dispose()
  }
}

export function apply(ctx: Context, input: Config): void {
  const config: ResolvedConfig = {
    apiKeyEnv: input.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    baseURL: input.baseURL ?? 'https://api.deepseek.com/anthropic/v1',
    model: input.model ?? 'deepseek-v4-flash',
    apiVersion: input.apiVersion ?? '2023-06-01',
    maxTokens: input.maxTokens ?? 4096,
    maxUses: input.maxUses ?? 5,
    maxResults: input.maxResults ?? 8,
    searchTimeoutMs: input.searchTimeoutMs ?? 60_000,
    researchTimeoutMs: input.researchTimeoutMs ?? 150_000,
    researchMaxResults: input.researchMaxResults ?? 16,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  }
  const optionsFor = (agentCtx: Context): SearchOptions => ({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    resolveApiKey: async () => {
      const ref = credentialRef(config.apiKeyEnv)
      const credentials = agentCtx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(ref))?.value
      return launchEnvironmentOf(agentCtx).get(config.apiKeyEnv)?.value
    },
    apiKeyRef: config.apiKeyEnv,
    baseURL: config.baseURL,
    model: config.model,
    apiVersion: config.apiVersion,
    maxTokens: config.maxTokens,
    maxUses: config.maxUses,
    maxResults: config.maxResults,
    recordRequest: request => {
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('verified-search: no agent session available for request logging')
      recordSearchRequest(agent.session, request)
    },
  })

  ctx.effect(() => {
    const installed = new Map<Agent, () => void>()
    const hostDisposers: Array<() => void> = []
    const uninstall = (agent: Agent): void => {
      installed.get(agent)?.()
      installed.delete(agent)
    }
    const install = (agent: Agent): void => {
      if (installed.has(agent)) return
      // This is a replacement, not a capability grant. Presets such as
      // `minimal` intentionally expose no search tool and remain unchanged.
      if (agent.ctx.tools.get('web_search', agent) === undefined) return
      const disposers: Array<() => void> = []
      try {
        // The preset is an ancestor scope, so this agent-level filter hides its
        // inherited legacy tool while preserving this agent's verified_search.
        disposers.push(agent.ctx.tools.restrict({ deny: ['web_search'] }))
        disposers.push(installForAgent(
          agent.ctx,
          () => optionsFor(agent.ctx),
          config.searchTimeoutMs,
          config.researchTimeoutMs,
          config.researchMaxResults,
        ))
      } catch (error: unknown) {
        for (const dispose of disposers.toReversed()) dispose()
        throw error
      }
      installed.set(agent, () => {
        for (const dispose of disposers.toReversed()) dispose()
      })
    }
    const cleanup = (): void => {
      for (const dispose of hostDisposers.toReversed()) dispose()
      for (const dispose of [...installed.values()].toReversed()) dispose()
      installed.clear()
    }

    try {
      hostDisposers.push(ctx.on('agent/created', ({ agent }) => install(agent)))
      hostDisposers.push(ctx.on('agent/disposed', ({ agent }) => {
        // Registry removal does not guarantee that a custom agent's scope has
        // unwound. Dispose our restriction, tool, and policy while the exact
        // agent identity is still available.
        uninstall(agent)
      }))
      hostDisposers.push(ctx.on('agent-preset/selected', (sessionId) => {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) return
        // An empty session may switch between a search-capable preset and a
        // deliberately search-free one. Reconcile against the new parent view.
        uninstall(agent)
        install(agent)
      }))
      // Support a profile hot-reload while agents are already live.
      for (const agent of ctx.agents.list()) install(agent)
    } catch (error: unknown) {
      cleanup()
      throw error
    }
    return cleanup
  }, 'verified-search.agents()')
}
