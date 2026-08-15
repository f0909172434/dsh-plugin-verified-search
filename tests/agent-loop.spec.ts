import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { installVerifiedResearchFinalizationPolicy } from '../src/tool.js'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(rawCallId: string, name: string): StreamChunk[] {
  const id = CallId(rawCallId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('script exhausted')
    for (const chunk of response) yield chunk
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('rc.6 agent-loop finalization', () => {
  it('blocks same-turn fallback but resets at turn/end before a queued next turn', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('research-1', 'verified_research'),
      toolCallResponse('blocked-1', 'pwsh'),
      textResponse('turn-one-final'),
      toolCallResponse('allowed-2', 'pwsh'),
      textResponse('turn-two-final'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('verified-research-turn-reset'), {
      provider: 'mock',
      model: 'mock',
    })

    let pwshExecutions = 0
    agent.ctx.tools.register(defineTool({
      name: 'verified_research',
      description: 'terminal research fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        exec.deferContext(createUserMessage({
          source: {
            kind: 'plugin',
            plugin: 'dsh-plugin-verified-search',
            form: 'notice',
            summary: 'Bounded verified research completed; synthesize the terminal answer',
          },
          content: [{ type: 'text', text: 'Produce the terminal answer now without calling any tool.' }],
        }))
        exec.concludeTurn()
        return 'research-complete'
      },
    }))
    agent.ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'side-effect sentinel',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        pwshExecutions++
        return 'pwsh-ran'
      },
    }))
    const disposePolicy = installVerifiedResearchFinalizationPolicy(agent.ctx)
    let queued = false
    const disposeQueue = agent.ctx.on('tools/result', (exec, result) => {
      if (queued || exec.name !== 'verified_research' || result.isError) return
      queued = true
      agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'queued second turn' }],
      }))
    })
    try {
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'first turn' }],
      }))
      await idle

      expect(adapter.requests).toHaveLength(5)
      expect(pwshExecutions).toBe(1)
      const events = [...agent.session.events]
      expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)
      const results = events.filter(event => event.type === 'tool/result')
      expect(results.find(event => event.type === 'tool/result'
        && event.data.message.source.callId === CallId('blocked-1'))?.data.message.content[0]?.isError).toBe(true)
      expect(results.find(event => event.type === 'tool/result'
        && event.data.message.source.callId === CallId('allowed-2'))?.data.message.content[0]?.isError).toBe(false)
    } finally {
      disposeQueue()
      disposePolicy()
      await ctx.fiber.dispose()
    }
  })
})
