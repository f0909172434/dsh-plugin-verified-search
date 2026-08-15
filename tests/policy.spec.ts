import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createVerifiedSearchTool,
  formatResult,
  installVerifiedResearchFinalizationPolicy,
  installVerifiedSearchPolicy,
} from '../src/tool.js'
import { createVerifiedResearchTool } from '../src/research.js'

function emitTurnEnd(ctx: Context, id: string): void {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  const event = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('session/event', session, event)
}

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { fixture: 'agent' }) },
    { inject: ['tools', 'systemPrompt'] }))
  scope.ctx.tools.register(defineTool({
    name: 'web_search',
    description: 'old search',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'old' },
  }))
  const options = () => ({
    apiKey: 'key',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    baseURL: 'https://invalid.example/v1',
    model: 'm',
    apiVersion: '2023-06-01',
    maxTokens: 1,
    maxUses: 1,
    maxResults: 1,
    recordRequest: vi.fn(),
  })
  scope.ctx.tools.register(createVerifiedSearchTool(options))
  scope.ctx.tools.register(createVerifiedResearchTool(options))
  installVerifiedSearchPolicy(scope.ctx)
  return { ctx, scope }
}

describe('agent-scoped policy', () => {
  it('removes old web_search and exposes narrow and composite verified tools', async () => {
    const { ctx, scope } = await fixture()
    const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! })
    expect(assembly.tools.map(tool => tool.name)).toContain('verified_search')
    expect(assembly.tools.map(tool => tool.name)).toContain('verified_research')
    expect(assembly.tools.map(tool => tool.name)).not.toContain('web_search')
    expect(assembly.sections.find(section => section.name === 'tool:verified_search')?.text)
      .toContain('absolute date')
    const researchPolicy = assembly.sections.find(section => section.name === 'tool:verified_research')?.text ?? ''
    expect(researchPolicy).toContain('24 total')
    expect(researchPolicy).toContain('known first-party seed_urls')
    expect(researchPolicy.length).toBeLessThan(1_200)
    expect(assembly.sections.find(section => section.name === 'tool:verified_json_projection')?.text)
      .toContain('every strict matching row')
    await ctx.fiber.dispose()
  })
})

describe('model-visible result warnings', () => {
  it('reports out-of-scope removals without exposing a discarded URL', () => {
    const text = formatResult({ sources: [], truncated: false, filteredOut: 2 })
    expect(text).toContain('2 structured source(s)')
    expect(text).toContain('none matched allowed_domains')
    expect(text).toContain('unresolved')
    expect(text).not.toContain('http')
  })

  it('reports mixed-source filtering after retained evidence', () => {
    const text = formatResult({
      sources: [{ url: 'https://api.deepseek.com/current', title: 'Current' }],
      truncated: true,
      filteredOut: 1,
    })
    expect(text).toContain('https://api.deepseek.com/current')
    expect(text).toContain('removed 1 provider source(s)')
    expect(text).toContain('source list was capped')
  })
})

describe('bounded research finalization', () => {
  it('blocks intermediate narrow search after structured JSON evidence until turn end', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    let searchExecutions = 0
    let researchExecutions = 0
    let fallbackExecutions = 0
    ctx.tools.register(defineTool({
      name: 'verified_json_selection',
      description: 'structured selection fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'selected' },
    }))
    ctx.tools.register(defineTool({
      name: 'verified_search',
      description: 'narrow search fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        searchExecutions++
        return 'searched'
      },
    }))
    ctx.tools.register(defineTool({
      name: 'verified_research',
      description: 'bounded research fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        researchExecutions++
        return 'researched'
      },
    }))
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'fallback fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        fallbackExecutions++
        return 'fallback-ran'
      },
    }))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(ctx)
    try {
      const selected = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'structured-selection' as never,
        name: 'verified_json_selection',
        arguments: {},
      })
      expect(selected.isError).toBe(false)

      const blocked = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'blocked-intermediate-search' as never,
        name: 'verified_search',
        arguments: {},
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('call verified_research directly once')
      expect(searchExecutions).toBe(0)

      const blockedFallback = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'blocked-intermediate-fallback' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(blockedFallback.isError).toBe(true)
      expect(JSON.stringify(blockedFallback.content)).toContain('Do not call any other tool')
      expect(fallbackExecutions).toBe(0)

      const promptScope = createScope(ctx, { fixture: 'structured-ready-prompt' })
      const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(promptScope.ctx)! })
      expect(assembly.tools.map(tool => tool.name)).toEqual(['verified_research'])
      await promptScope.dispose()

      const researched = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-direct-research' as never,
        name: 'verified_research',
        arguments: {},
      })
      expect(researched.isError).toBe(false)
      expect(researchExecutions).toBe(1)

      emitTurnEnd(ctx, 'structured-followup-reset')
      const allowed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-next-turn-search' as never,
        name: 'verified_search',
        arguments: {},
      })
      expect(allowed.isError).toBe(false)
      expect(searchExecutions).toBe(1)
      const allowedFallback = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-next-turn-fallback' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(allowedFallback.isError).toBe(false)
      expect(fallbackExecutions).toBe(1)
    } finally {
      disposePolicy()
      await ctx.fiber.dispose()
    }
  })

  it('defers a strict terminal synthesis, concludes the turn, and blocks fallback tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'fallback fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'fallback-ran' },
    }))
    ctx.tools.register(createVerifiedResearchTool(() => ({
      apiKey: 'unused',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      baseURL: 'https://invalid.example/v1',
      model: 'm',
      apiVersion: '2023-06-01',
      maxTokens: 1,
      maxUses: 1,
      maxResults: 1,
      recordRequest: vi.fn(),
    }), 150_000, 16, async url => ({
      url,
      mediaType: 'text/plain',
      body: 'Model identifier model-v5-pro.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(ctx)
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'research-terminal' as never,
        name: 'verified_research',
        arguments: {
          query: 'official model',
          lanes: [{
            id: 'official',
            query: 'official model first pass',
            gap_query: 'official model fallback pass',
            allowed_domains: ['docs.example.com'],
            seed_urls: ['https://docs.example.com/models'],
            required_claims: [{
              id: 'model_id',
              query: 'model identifier',
              evidence_must_include: ['Model identifier'],
              value_kind: 'generic_text',
              scope: { kind: 'document', must_include: ['Model identifier'] },
            }],
          }],
        },
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected research success')
      expect(result.concludesTurn).toBe(true)
      expect(result.additionalContexts).toHaveLength(1)
      const deferredText = result.additionalContexts?.[0]?.content
        .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
      expect(deferredText).toContain('Produce the terminal answer now without calling any tool')
      expect(deferredText).toContain('Covered claim IDs: official/model_id')
      expect(deferredText).not.toContain('model-v5-pro')

      const blocked = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'blocked-fallback' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('terminal answer')

      emitTurnEnd(ctx, 'policy-root-success')
      const allowedAfterIdle = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-after-idle' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(allowedAfterIdle.isError).toBe(false)
    } finally {
      disposePolicy()
    }

    const allowed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'allowed-after-dispose' as never,
      name: 'pwsh',
      arguments: {},
    })
    expect(allowed.isError).toBe(false)
    await ctx.fiber.dispose()
  })

  it('waits for an enclosing transport and clears when that parent fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'fallback fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'fallback-ran' },
    }))
    ctx.tools.register(createVerifiedResearchTool(() => ({
      apiKey: 'unused',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      baseURL: 'https://invalid.example/v1',
      model: 'm',
      apiVersion: '2023-06-01',
      maxTokens: 1,
      maxUses: 1,
      maxResults: 1,
      recordRequest: vi.fn(),
    }), 150_000, 16, async url => ({
      url,
      mediaType: 'text/plain',
      body: 'Model identifier model-v5-pro.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })))
    ctx.tools.register(defineTool({
      name: 'outer_failure',
      description: 'nested transport fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        const nested = await ctx.tools.execute({
          signal: exec.signal,
          callId: 'nested-research-failure' as never,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: 'verified_research',
          arguments: {
            query: 'official model',
            lanes: [{
              id: 'official',
              query: 'official model first pass',
              gap_query: 'official model fallback pass',
              allowed_domains: ['docs.example.com'],
              seed_urls: ['https://docs.example.com/models'],
              required_claims: [{
                id: 'model_id',
                query: 'model identifier',
                evidence_must_include: ['Model identifier'],
                value_kind: 'generic_text',
                scope: { kind: 'document', must_include: ['Model identifier'] },
              }],
            }],
          },
        })
        if (nested.isError) throw new Error('nested research unexpectedly failed')
        throw new Error('outer failed after nested success')
      },
    }))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(ctx)
    try {
      const outer = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'outer-failure' as never,
        name: 'outer_failure',
        arguments: {},
      })
      expect(outer.isError).toBe(true)

      const allowed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-after-outer-failure' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(allowed.isError).toBe(false)
    } finally {
      disposePolicy()
      await ctx.fiber.dispose()
    }
  })

  it('commits a nested terminal result only after the parent forwards it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'fallback fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'fallback-ran' },
    }))
    ctx.tools.register(createVerifiedResearchTool(() => ({
      apiKey: 'unused',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      baseURL: 'https://invalid.example/v1',
      model: 'm',
      apiVersion: '2023-06-01',
      maxTokens: 1,
      maxUses: 1,
      maxResults: 1,
      recordRequest: vi.fn(),
    }), 150_000, 16, async url => ({
      url,
      mediaType: 'text/plain',
      body: 'Model identifier model-v5-pro.',
      retrievedAt: '2026-08-14T00:00:00.000Z',
    })))
    ctx.tools.register(defineTool({
      name: 'outer_forward',
      description: 'nested transport fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        const nested = await ctx.tools.execute({
          signal: exec.signal,
          callId: 'nested-research-forward' as never,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          name: 'verified_research',
          arguments: {
            query: 'official model',
            lanes: [{
              id: 'official',
              query: 'official model first pass',
              gap_query: 'official model fallback pass',
              allowed_domains: ['docs.example.com'],
              seed_urls: ['https://docs.example.com/models'],
              required_claims: [{
                id: 'model_id',
                query: 'model identifier',
                evidence_must_include: ['Model identifier'],
                value_kind: 'generic_text',
                scope: { kind: 'document', must_include: ['Model identifier'] },
              }],
            }],
          },
        })
        if (nested.isError) throw new Error('nested research unexpectedly failed')
        for (const context of nested.additionalContexts ?? []) exec.deferContext(context)
        if (nested.concludesTurn === true) exec.concludeTurn()
        return 'forwarded'
      },
    }))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(ctx)
    try {
      const outer = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'outer-forward' as never,
        name: 'outer_forward',
        arguments: {},
      })
      expect(outer.isError).toBe(false)
      expect(outer.concludesTurn).toBe(true)

      const blocked = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'blocked-after-outer-forward' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(blocked.isError).toBe(true)

      emitTurnEnd(ctx, 'policy-nested-forward')
      const allowed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-after-nested-turn-end' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(allowed.isError).toBe(false)
    } finally {
      disposePolicy()
      await ctx.fiber.dispose()
    }
  })

  it('does not lock later tools when research argument validation fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'fallback fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'fallback-ran' },
    }))
    ctx.tools.register(createVerifiedResearchTool(() => ({
      apiKey: 'unused',
      apiKeyRef: 'DEEPSEEK_API_KEY',
      baseURL: 'https://invalid.example/v1',
      model: 'm',
      apiVersion: '2023-06-01',
      maxTokens: 1,
      maxUses: 1,
      maxResults: 1,
      recordRequest: vi.fn(),
    })))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(ctx)
    try {
      const invalid = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'invalid-research' as never,
        name: 'verified_research',
        arguments: {
          query: 'missing gap query',
          lanes: [{ id: 'official', query: 'first pass' }],
        },
      })
      expect(invalid.isError).toBe(true)

      const allowed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'allowed-after-error' as never,
        name: 'pwsh',
        arguments: {},
      })
      expect(allowed.isError).toBe(false)
    } finally {
      disposePolicy()
      await ctx.fiber.dispose()
    }
  })

  it('requires every model-facing lane to predeclare a gap query', async () => {
    const { ctx, scope } = await fixture()
    const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! })
    const schema = assembly.tools.find(value => value.name === 'verified_research')
    expect(JSON.stringify(schema?.parameters))
      .toContain('"required":["id","query","required_claims","gap_query"]')
    expect(JSON.stringify(schema?.parameters)).toContain('cvss_base_score')
    await ctx.fiber.dispose()
  })
})
