import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createVerifiedSearchTool, installVerifiedSearchPolicy } from '../src/tool.js'

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
  scope.ctx.tools.register(createVerifiedSearchTool(() => ({
    apiKey: 'key',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    baseURL: 'https://invalid.example/v1',
    model: 'm',
    apiVersion: '2023-06-01',
    maxTokens: 1,
    maxUses: 1,
    maxResults: 1,
    recordRequest: vi.fn(),
  })))
  installVerifiedSearchPolicy(scope.ctx)
  return { ctx, scope }
}

describe('agent-scoped policy', () => {
  it('removes old web_search from model schema and exposes verified_search', async () => {
    const { ctx, scope } = await fixture()
    const assembly = await ctx.systemPrompt.assemble({ scope: scopeOf(scope.ctx)! })
    expect(assembly.tools.map(tool => tool.name)).toContain('verified_search')
    expect(assembly.tools.map(tool => tool.name)).not.toContain('web_search')
    expect(assembly.sections.find(section => section.name === 'tool:verified_search')?.text)
      .toContain('absolute date')
    await ctx.fiber.dispose()
  })
})
