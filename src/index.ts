import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SearchOptions, VerifiedSearchWireRequest } from './types.js'
import { createVerifiedSearchTool, installVerifiedSearchPolicy } from './tool.js'

export { normalizeAllowedDomains, enforceAllowedSources, SearchFilterError, SearchFilterViolationError } from './domains.js'
export { mapResponse, search, searchInstruction, VerifiedSearchError } from './provider.js'
export { createVerifiedSearchTool, formatResult, installVerifiedSearchPolicy } from './tool.js'
export type { SearchOptions, VerifiedSearchRequest, VerifiedSearchResult, VerifiedSearchSource, VerifiedSearchWireRequest } from './types.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact secret-free request recorded before the auxiliary model dispatch. */
    'verified-search/request': VerifiedSearchWireRequest
  }
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
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  apiKey: z.string().role('secret'),
  baseURL: z.string().default('https://api.deepseek.com/anthropic/v1'),
  model: z.string().default('deepseek-v4-flash'),
  apiVersion: z.string().default('2023-06-01'),
  maxTokens: z.number().step(1).min(1).default(4096),
  maxUses: z.number().step(1).min(1).default(5),
  maxResults: z.number().step(1).min(1).default(8),
  searchTimeoutMs: z.number().step(1).min(1).default(60_000),
})

type ResolvedConfig = Required<Omit<Config, 'apiKey'>> & Pick<Config, 'apiKey'>

/** Install the tool/policy into one live agent scope. Exported for tests. */
export function installForAgent(
  agentCtx: Context,
  options: () => SearchOptions,
  timeoutMs = 60_000,
): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(installVerifiedSearchPolicy(agentCtx))
    disposers.push(agentCtx.tools.register(createVerifiedSearchTool(options, timeoutMs)))
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
      agent.session.append('verified-search/request', request)
    },
  })

  const installed = new Map<object, () => void>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const disposers: Array<() => void> = []
    try {
      if (agent.ctx.tools.get('web_search', agent) !== undefined) {
        disposers.push(agent.ctx.tools.restrict({ deny: ['web_search'] }))
      }
      disposers.push(installForAgent(agent.ctx, () => optionsFor(agent.ctx), config.searchTimeoutMs))
    } catch (error: unknown) {
      for (const dispose of disposers.toReversed()) dispose()
      throw error
    }
    installed.set(agent, () => {
      for (const dispose of disposers.toReversed()) dispose()
    })
  }

  ctx.on('agent/created', ({ agent }) => {
    // The preset is an ancestor scope, so this agent-level filter hides its
    // inherited legacy tool while preserving this agent's verified_search.
    install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // The agent scope already unwound its registrations before this event.
    installed.delete(agent)
  })

  // Support a profile hot-reload while agents are already live.
  for (const agent of ctx.agents.list()) install(agent)
  ctx.effect(() => () => {
    for (const dispose of [...installed.values()].toReversed()) dispose()
    installed.clear()
  }, 'verified-search.agents()')
}
