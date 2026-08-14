import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createVerifiedSearchTool, formatResult, installVerifiedSearchPolicy } from '../src/tool.js'
import { createVerifiedResearchTool } from '../src/research.js'

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
    expect(assembly.sections.find(section => section.name === 'tool:verified_research')?.text)
      .toContain('one lane per required company')
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
