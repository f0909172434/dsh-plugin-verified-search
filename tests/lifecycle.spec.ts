import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply, inject, type Config } from '../src/index.js'

const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0).toReversed()) await ctx.fiber.dispose()
})

function inertTool(name: string) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return name },
  })
}

async function bench() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  return ctx
}

async function mintScope(ctx: Context, key: ScopeKey, parent?: ScopeKey): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, key, parent === undefined ? {} : { parent })
  }, { inject: ['tools', 'systemPrompt'] }))
  return scope
}

async function stubAgent(ctx: Context, rawId: string, parent?: ScopeKey): Promise<{ agent: Agent; scope: Scope }> {
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
  const scope = await mintScope(ctx, agent, parent)
  Object.assign(agent, { ctx: scope.ctx.extend({ agent }) })
  return { agent, scope }
}

function visibleTools(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(agent).map(tool => tool.name).sort()
}

function mount(ctx: Context) {
  return ctx.plugin({ name: 'verified-search-lifecycle-fixture', inject, apply }, {} satisfies Config)
}

describe('apply lifecycle', () => {
  it('uses a request event the rc.6 persistence reader recognizes', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('web/deepseek-search-llm-request')).toBe(true)
  })

  it('replaces inherited web_search for existing and future agents without expanding no-web agents', async () => {
    const ctx = await bench()
    const webPresetKey = { preset: 'web-key' }
    const keyedWebPreset = await mintScope(ctx, webPresetKey)
    keyedWebPreset.ctx.tools.register(inertTool('web_search'))
    const existing = await stubAgent(ctx, 'existing-web-keyed', webPresetKey)
    const existingMinimal = await stubAgent(ctx, 'existing-minimal')
    existingMinimal.agent.ctx.tools.register(inertTool('bash'))
    existingMinimal.agent.ctx.tools.register(inertTool('str_replace_editor'))
    ctx.agents.register(existing.agent)
    ctx.agents.register(existingMinimal.agent)

    const plugin = mount(ctx)
    await plugin

    expect(visibleTools(ctx, existing.agent)).toEqual(['verified_research', 'verified_search'])
    expect(visibleTools(ctx, existingMinimal.agent)).toEqual(['bash', 'str_replace_editor'])

    const future = await stubAgent(ctx, 'future-web', webPresetKey)
    const futureMinimal = await stubAgent(ctx, 'future-minimal')
    futureMinimal.agent.ctx.tools.register(inertTool('bash'))
    futureMinimal.agent.ctx.tools.register(inertTool('str_replace_editor'))
    ctx.agents.register(future.agent)
    ctx.agents.register(futureMinimal.agent)

    expect(visibleTools(ctx, future.agent)).toEqual(['verified_research', 'verified_search'])
    expect(visibleTools(ctx, futureMinimal.agent)).toEqual(['bash', 'str_replace_editor'])
  })

  it('restores the inherited preset surface when the plugin fiber is disposed', async () => {
    const ctx = await bench()
    const presetKey = { preset: 'web' }
    const preset = await mintScope(ctx, presetKey)
    preset.ctx.tools.register(inertTool('web_search'))
    const { agent } = await stubAgent(ctx, 'reload-target', presetKey)
    ctx.agents.register(agent)

    const plugin = mount(ctx)
    await plugin
    expect(visibleTools(ctx, agent)).toEqual(['verified_research', 'verified_search'])

    await plugin.dispose()
    expect(visibleTools(ctx, agent)).toEqual(['web_search'])
  })

  it('removes agent-scoped replacements when the registry detaches an agent', async () => {
    const ctx = await bench()
    const presetKey = { preset: 'detached-web' }
    const preset = await mintScope(ctx, presetKey)
    preset.ctx.tools.register(inertTool('web_search'))
    const { agent } = await stubAgent(ctx, 'detached-agent', presetKey)
    const unregister = ctx.agents.register(agent)

    const plugin = mount(ctx)
    await plugin
    expect(visibleTools(ctx, agent)).toEqual(['verified_research', 'verified_search'])

    unregister()

    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(visibleTools(ctx, agent)).toEqual(['web_search'])
  })

  it('reconciles a blank live agent when its preset selection changes', async () => {
    const ctx = await bench()
    const webPresetKey = { preset: 'web' }
    const minimalPresetKey = { preset: 'minimal' }
    const webPreset = await mintScope(ctx, webPresetKey)
    await mintScope(ctx, minimalPresetKey)
    webPreset.ctx.tools.register(inertTool('web_search'))
    const candidate = await stubAgent(ctx, 'preset-switch')
    const binding = bindScopeParent(candidate.agent, minimalPresetKey)
    ctx.agents.register(candidate.agent)

    const plugin = mount(ctx)
    await plugin
    expect(visibleTools(ctx, candidate.agent)).toEqual([])

    binding.rebind(webPresetKey)
    ctx.emit('agent-preset/selected', candidate.agent.id, 'web')
    expect(visibleTools(ctx, candidate.agent)).toEqual(['verified_research', 'verified_search'])

    binding.rebind(minimalPresetKey)
    ctx.emit('agent-preset/selected', candidate.agent.id, 'minimal')
    expect(visibleTools(ctx, candidate.agent)).toEqual([])
  })

  it('rolls back earlier existing-agent installs when a later agent collides during apply', async () => {
    const ctx = await bench()
    const presetKey = { preset: 'web' }
    const preset = await mintScope(ctx, presetKey)
    preset.ctx.tools.register(inertTool('web_search'))
    const first = await stubAgent(ctx, 'first', presetKey)
    const colliding = await stubAgent(ctx, 'colliding', presetKey)
    colliding.agent.ctx.tools.register(inertTool('verified_search'))
    ctx.agents.register(first.agent)
    ctx.agents.register(colliding.agent)

    await expect(mount(ctx)).rejects.toThrow(/verified_search.*already registered/u)

    expect(visibleTools(ctx, first.agent)).toEqual(['web_search'])
    expect(visibleTools(ctx, colliding.agent)).toEqual(['verified_search', 'web_search'])
  })

  it('rolls back search and policy when verified_research collides', async () => {
    const ctx = await bench()
    const presetKey = { preset: 'web-research-collision' }
    const preset = await mintScope(ctx, presetKey)
    preset.ctx.tools.register(inertTool('web_search'))
    const first = await stubAgent(ctx, 'first-research-collision', presetKey)
    const colliding = await stubAgent(ctx, 'research-collision', presetKey)
    colliding.agent.ctx.tools.register(inertTool('verified_research'))
    ctx.agents.register(first.agent)
    ctx.agents.register(colliding.agent)

    await expect(mount(ctx)).rejects.toThrow(/verified_research.*already registered/u)

    expect(visibleTools(ctx, first.agent)).toEqual(['web_search'])
    expect(visibleTools(ctx, colliding.agent)).toEqual(['verified_research', 'web_search'])
  })
})
