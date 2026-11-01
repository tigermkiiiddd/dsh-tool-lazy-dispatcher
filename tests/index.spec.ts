import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LazyDispatcher from '../src/index.ts'

/** Scripted adapter: one canned chunk array per model request. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    for (const chunk of entry) yield chunk
  }
}

/** One completed text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}


const testSignal = new AbortController().signal

async function setup(config: LazyDispatcher.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // `tools.execute()` dispatches through the selected executor, so the composition
  // needs one; every shipped profile mounts the native executor.
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LazyDispatcher, config)
  return ctx
}

/**
 * Composition with an Agent registry: folding is per agent, because
 * `tools.restrict()` requires an agent-scoped context.
 * @param config - plugin configuration.
 * @returns the context, one created agent, and `run`, which drives one turn and
 *   returns the assembly the request actually used.
 */
async function setupWithAgent(
  config: LazyDispatcher.Config = {},
): Promise<{ ctx: Context; agent: Agent; run: () => Promise<PromptAssembly> }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LazyDispatcher, config)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('ok')])
  ctx.llm.registerAdapter(['test'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('lazy-folding-test'), { provider: 'test', model: 'test' })
  const run = async (): Promise<PromptAssembly> => {
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
    await idle
    // Re-assemble inside the same running-less state so the fold the turn installed
    // is observable without driving a second request.
    return ctx.systemPrompt.assemble({ agent, scope: agent })
  }
  return { ctx, agent, run }
}

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function runSingleTool(ctx: Context, name: string, args: unknown, callId = 'test-call') {
  const batch = await ctx.tools.execute({
    calls: [{
      type: 'tool-call',
      id: ToolCallId(callId),
      name,
      arguments: JSON.stringify(args),
    }],
    signal: testSignal,
  })
  const outcome = batch.results[0]?.result
  if (!outcome) throw new Error('no result')
  return outcome
}

const mockHeavyTool = defineTool({
  name: 'heavy_domain_tool',
  description: 'A heavy specialized tool that should be folded by default to save tokens.',
  parameters: {
    dataset: { type: 'string', required: true, description: 'Dataset identifier' },
    iterations: { type: 'integer', description: 'Number of processing loops' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, val) => [{ type: 'text', text: val }],
  },
  async execute(args) {
    return `Processed dataset ${args.dataset} for ${args.iterations ?? 1} iterations.`
  },
})

describe('tool-lazy-dispatcher plugin', () => {
  it('registers get_tool_schema and call_tool meta-tools', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('get_tool_schema')).toBeDefined()
    expect(ctx.tools.get('call_tool')).toBeDefined()
  })

  it('inspects schemas of registered tools using get_tool_schema', async () => {
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    const result = await runSingleTool(ctx, 'get_tool_schema', { name: 'heavy_domain_tool' }, 'test-call-1')

    expect(result.isError).toBe(false)
    if (!result.isError) {
      const parsed = JSON.parse(result.value as string) as Record<string, unknown>
      expect(parsed.name).toBe('heavy_domain_tool')
      expect(parsed.description).toContain('heavy specialized tool')
      expect(parsed.parameters).toHaveProperty('properties')
    }
  })

  it('delegates execution to folded tools using call_tool', async () => {
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    const result = await runSingleTool(ctx, 'call_tool', {
      name: 'heavy_domain_tool',
      arguments: { dataset: 'sales_2026', iterations: 5 },
    }, 'test-call-2')

    expect(result.isError).toBe(false)
    if (!result.isError) {
      const block = result.content[0]
      expect(block?.type).toBe('text')
      if (block && block.type === 'text') {
        expect(block.text).toContain('Processed dataset sales_2026 for 5 iterations.')
      }
    }
  })

  it('folds non-pinned tools and injects text directory into system-prompt', async () => {
    const { ctx, agent, run } = await setupWithAgent()
    ctx.tools.register(mockHeavyTool)

    // Register a standard pinned tool (e.g., read)
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    // Folding installs on the running transition, so the assertion runs after a turn.
    const assembly = await run()

    // Active tools should keep read, get_tool_schema, and call_tool
    const toolNames = assembly.tools.map(t => t.name)
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('get_tool_schema')
    expect(toolNames).toContain('call_tool')
    // heavy_domain_tool should be folded away from this agent's tools!
    expect(toolNames).not.toContain('heavy_domain_tool')

    // System prompt sections should include the folded tool directory
    const lazySection = assembly.sections.find(s => s.name === 'tools:lazy-directory')
    expect(lazySection).toBeDefined()
    expect(lazySection?.text).toContain('heavy_domain_tool')
    expect(lazySection?.text).toContain('heavy_domain_tool(dataset, iterations?)')
    expect(lazySection?.text).toContain('A heavy specialized tool that should be folded')
  })

  it('does not fold tools when lazyToolFolding is false in config', async () => {
    const { ctx, agent, run } = await setupWithAgent({ lazyToolFolding: false })
    ctx.tools.register(mockHeavyTool)

    const assembly = await run()
    const toolNames = assembly.tools.map(t => t.name)
    // When disabled, heavy_domain_tool stays in the agent's tools
    expect(toolNames).toContain('heavy_domain_tool')
    const lazySection = assembly.sections.find(s => s.name === 'tools:lazy-directory')
    expect(lazySection).toBeUndefined()
  })

  it('allows folding default tools when user customizes pinned list, while always keeping mandatory meta-tools', async () => {
    // Register settings service mock with user-customized pinned list that excludes 'read'
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('settings', {
      describe: () => [
        {
          ns: 'ui-settings',
          value: {
            lazyToolFolding: true,
            // User only pins heavy_domain_tool, explicitly omitting 'read'
            pinnedTools: 'heavy_domain_tool',
          },
        },
      ],
    } as any)
    await ctx.plugin(LazyDispatcher)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    ctx.tools.register(mockHeavyTool)
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    const agent = await ctx.agentLoop.create(SessionId('lazy-pinned-test'), { provider: 'test', model: 'test' })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const toolNames = assembly.tools.map(t => t.name)

    // User explicitly pinned heavy_domain_tool, so it stays active
    expect(toolNames).toContain('heavy_domain_tool')
    // Mandatory meta-tools must ALWAYS remain pinned
    expect(toolNames).toContain('list_tools')
    expect(toolNames).toContain('get_tool_schema')
    expect(toolNames).toContain('call_tool')
    // 'read' was not in user's pinned list, so it was successfully folded!
    expect(toolNames).not.toContain('read')
  })

  it('discovers and searches tools with list_tools', async () => {
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    // 1. Search by keyword
    const searchResult = await runSingleTool(ctx, 'list_tools', { action: 'search', query: 'heavy' }, 'search-call-1')
    expect(searchResult.isError).toBe(false)
    if (!searchResult.isError) {
      const block = searchResult.content[0]
      expect(block?.type).toBe('text')
      if (block && block.type === 'text') {
        expect(block.text).toContain('heavy_domain_tool')
        expect(block.text).toContain('Found 1 tool(s)')
      }
    }

    // 2. Search non-matching query
    const missResult = await runSingleTool(ctx, 'list_tools', { action: 'search', query: 'non_existent_xyz' }, 'search-call-2')
    expect(missResult.isError).toBe(false)
    if (!missResult.isError) {
      const block = missResult.content[0]
      if (block && block.type === 'text') {
        expect(block.text).toContain('No tools found')
      }
    }
  })

  it('preserves ImageBlocks and multimodal content when proxying via call_tool', async () => {
    const ctx = await setup()

    const mockImageTool = defineTool({
      name: 'screenshot_tool',
      description: 'Takes a screenshot and returns text and image blocks',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: () => [
          { type: 'text', text: 'Captured page screenshot' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'att-shot-001' as any,
              mediaType: 'image/png' as const,
              bytes: 2048,
              width: 800,
              height: 600,
            },
          },
        ],
      },
      async execute() {
        return { success: true }
      },
    })
    ctx.tools.register(mockImageTool)

    const result = await runSingleTool(ctx, 'call_tool', { name: 'screenshot_tool' }, 'call-img-1')

    expect(result.isError).toBe(false)
    if (!result.isError) {
      // Must contain 2 content blocks: text and image
      expect(result.content.length).toBe(2)
      expect(result.content[0]?.type).toBe('text')
      expect(result.content[1]?.type).toBe('image')

      const imgBlock = result.content[1]
      if (imgBlock && imgBlock.type === 'image') {
        expect(imgBlock.attachment.attachmentId).toBe('att-shot-001')
        expect(imgBlock.attachment.width).toBe(800)
        expect(imgBlock.attachment.height).toBe(600)
        expect(imgBlock.attachment.mediaType).toBe('image/png')
      }
    }
  })

  it('has grep and only official DSH tools in DEFAULT_PINNED_TOOLS', () => {
    expect(LazyDispatcher.DEFAULT_PINNED_TOOLS).toContain('grep')
    expect(LazyDispatcher.DEFAULT_PINNED_TOOLS).toContain('glob')
    expect(LazyDispatcher.DEFAULT_PINNED_TOOLS).toContain('read')
    expect(LazyDispatcher.DEFAULT_PINNED_TOOLS).toContain('call_tool')
    // toolCallCounts should not be exported
    expect((LazyDispatcher as any).toolCallCounts).toBeUndefined()
  })

  describe('summarizeDescription helper', () => {
    it('returns empty string on empty input or non-positive max', () => {
      expect(LazyDispatcher.summarizeDescription('', 50)).toBe('')
      expect(LazyDispatcher.summarizeDescription('Hello', 0)).toBe('')
      expect(LazyDispatcher.summarizeDescription('Hello', -5)).toBe('')
    })

    it('returns original text when total length <= max and collapses whitespace', () => {
      const text = '  First sentence.    Second sentence.   '
      expect(LazyDispatcher.summarizeDescription(text, 100)).toBe('First sentence. Second sentence.')
    })

    it('accumulates whole sentences that fit within max without appending ellipsis', () => {
      const text = 'First sentence. Second sentence is longer. Third sentence.'
      expect(LazyDispatcher.summarizeDescription(text, 25)).toBe('First sentence.')
      expect(LazyDispatcher.summarizeDescription(text, 45)).toBe('First sentence. Second sentence is longer.')
    })

    it('splits on Chinese punctuation as well', () => {
      const text = '第一句话。第二句话！第三句话？'
      expect(LazyDispatcher.summarizeDescription(text, 10)).toBe('第一句话。第二句话！')
    })

    it('cuts at last whitespace before max-1 and appends ellipsis when first sentence exceeds max', () => {
      const text = 'This is an exceedingly long first sentence that exceeds max length.'
      const result = LazyDispatcher.summarizeDescription(text, 25)
      expect(result).toBe('This is an exceedingly…')
      expect(result.length).toBeLessThanOrEqual(25)
      expect(result.endsWith('…')).toBe(true)
    })

    it('hard cuts at max-1 and appends ellipsis when first sentence has no whitespace', () => {
      const text = 'Supercalifragilisticexpialidocious'
      const result = LazyDispatcher.summarizeDescription(text, 10)
      expect(result).toBe('Supercali…')
      expect(result.length).toBe(10)
    })
  })

  describe('formatSignature helper', () => {
    it('formats tool signature with <= 5 properties by naming optional params with ? suffix', () => {
      expect(LazyDispatcher.formatSignature({
        name: 'my_tool',
        parameters: {
          properties: {
            req1: { type: 'string' },
            req2: { type: 'number' },
            opt1: { type: 'boolean' },
            opt2: { type: 'string' },
          },
          required: ['req1', 'req2'],
        },
      })).toBe('my_tool(req1, req2, opt1?, opt2?)')

      expect(LazyDispatcher.formatSignature({
        name: 'call_tool',
        parameters: {
          properties: {
            name: { type: 'string' },
            args: { type: 'json' },
            calls: { type: 'array' },
          },
        },
      })).toBe('call_tool(name?, args?, calls?)')
    })

    it('formats tool signature with > 5 properties using +N opt for optional params', () => {
      expect(LazyDispatcher.formatSignature({
        name: 'big_tool',
        parameters: {
          properties: {
            req1: { type: 'string' },
            req2: { type: 'string' },
            opt1: { type: 'string' },
            opt2: { type: 'string' },
            opt3: { type: 'string' },
            opt4: { type: 'string' },
          },
          required: ['req1', 'req2'],
        },
      })).toBe('big_tool(req1, req2, +4 opt)')
    })

    it('omits +N opt when there are 0 optional parameters', () => {
      expect(LazyDispatcher.formatSignature({
        name: 'strictly_required',
        parameters: {
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      })).toBe('strictly_required(id)')

      expect(LazyDispatcher.formatSignature({
        name: 'six_required',
        parameters: {
          properties: {
            r1: { type: 'string' },
            r2: { type: 'string' },
            r3: { type: 'string' },
            r4: { type: 'string' },
            r5: { type: 'string' },
            r6: { type: 'string' },
          },
          required: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
        },
      })).toBe('six_required(r1, r2, r3, r4, r5, r6)')
    })

    it('returns name() when tool has no parameters', () => {
      expect(LazyDispatcher.formatSignature({ name: 'empty_tool' })).toBe('empty_tool()')
      expect(LazyDispatcher.formatSignature({ name: 'empty_params', parameters: {} })).toBe('empty_params()')
      expect(LazyDispatcher.formatSignature({ name: 'empty_props', parameters: { properties: {} } })).toBe('empty_props()')
    })

    it('handles tools with only optional parameters', () => {
      expect(LazyDispatcher.formatSignature({
        name: 'all_opt',
        parameters: {
          properties: {
            a: { type: 'string' },
            b: { type: 'string' },
          },
        },
      })).toBe('all_opt(a?, b?)')
    })
  })

  it('call_tool presentCall delegates to target presentCall and falls back to generic', async () => {
    const ctx = await setup()

    const customPresentTool = defineTool({
      name: 'tool_with_presenter',
      description: 'Tool with custom presenter',
      parameters: { query: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
      presentCall: args => ({
        card: 'generic',
        title: `Custom view for: ${args.query}`,
        kind: 'search',
        rawInput: args,
      }),
    })

    const noPresentTool = defineTool({
      name: 'tool_without_presenter',
      description: 'Tool without custom presenter',
      parameters: { count: { type: 'integer' } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    })

    const throwingPresentTool = defineTool({
      name: 'tool_throwing_presenter',
      description: 'Tool with throwing presenter',
      parameters: { x: { type: 'string' } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
      presentCall: () => { throw new Error('Presenter crashed') },
    })

    ctx.tools.register(customPresentTool)
    ctx.tools.register(noPresentTool)
    ctx.tools.register(throwingPresentTool)

    const callTool = ctx.tools.get('call_tool')
    expect(callTool?.presentCall).toBeDefined()

    // 1. Target with custom presentCall: delegates
    const view1 = callTool!.presentCall!({
      name: 'tool_with_presenter',
      arguments: { query: 'test-search' },
    })
    expect(view1).toEqual({
      card: 'generic',
      title: 'Custom view for: test-search',
      kind: 'search',
      rawInput: { query: 'test-search' },
    })

    // Also accepts JSON string for arguments
    const view1String = callTool!.presentCall!({
      name: 'tool_with_presenter',
      arguments: JSON.stringify({ query: 'json-string-search' }),
    })
    expect(view1String?.title).toBe('Custom view for: json-string-search')

    // 2. Target without presentCall: falls back to generic card with parsed rawInput
    const view2 = callTool!.presentCall!({
      name: 'tool_without_presenter',
      arguments: { count: 42 },
    })
    expect(view2).toEqual({
      card: 'generic',
      title: 'Call tool: tool_without_presenter',
      kind: 'other',
      rawInput: { count: 42 },
    })

    // 3. Target that throws: catches safely and falls back to generic card
    const view3 = callTool!.presentCall!({
      name: 'tool_throwing_presenter',
      arguments: { x: 'val' },
    })
    expect(view3).toEqual({
      card: 'generic',
      title: 'Call tool: tool_throwing_presenter',
      kind: 'other',
      rawInput: { x: 'val' },
    })
  })

  it('call_tool presentResult delegates to target presentResult and handles errors safely', async () => {
    const ctx = await setup()

    const customResultTool = defineTool({
      name: 'tool_with_result_presenter',
      description: 'Tool with result presenter',
      parameters: { file: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
      presentResult: (args, res) => ({
        card: 'generic',
        title: `Processed ${args.file} (meta: ${JSON.stringify(res.meta)})`,
      }),
    })

    const noResultTool = defineTool({
      name: 'tool_no_result_presenter',
      description: 'Tool without result presenter',
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    })

    const throwingResultTool = defineTool({
      name: 'tool_throwing_result_presenter',
      description: 'Tool with throwing result presenter',
      parameters: {},
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
      presentResult: () => { throw new Error('Result presenter exploded') },
    })

    ctx.tools.register(customResultTool)
    ctx.tools.register(noResultTool)
    ctx.tools.register(throwingResultTool)

    const callTool = ctx.tools.get('call_tool')
    expect(callTool?.presentResult).toBeDefined()

    // 1. Target with custom presentResult: delegates
    const resView1 = callTool!.presentResult!(
      { name: 'tool_with_result_presenter', arguments: { file: 'doc.txt' } },
      { content: [{ type: 'text', text: 'done' }], isError: false, meta: { status: 200 } },
    )
    expect(resView1).toEqual({
      card: 'generic',
      title: 'Processed doc.txt (meta: {"status":200})',
    })

    // 2. Target without presentResult: returns undefined
    const resView2 = callTool!.presentResult!(
      { name: 'tool_no_result_presenter', arguments: {} },
      { content: [{ type: 'text', text: 'done' }], isError: false },
    )
    expect(resView2).toBeUndefined()

    // 3. Target that throws: catches safely and returns undefined
    const resView3 = callTool!.presentResult!(
      { name: 'tool_throwing_result_presenter', arguments: {} },
      { content: [], isError: false },
    )
    expect(resView3).toBeUndefined()
  })

  it('forwards inner meta via call_tool presentationMeta and preserves execution return value', async () => {
    const ctx = await setup()

    const metaTool = defineTool({
      name: 'tool_with_meta',
      description: 'Tool returning meta',
      parameters: { key: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' },
        render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
        presentationMeta: args => ({ echoedKey: args.key }),
      },
      async execute(args) {
        return { success: true, key: args.key }
      },
    })
    ctx.tools.register(metaTool)

    const callTool = ctx.tools.get('call_tool')
    expect(callTool?.output.presentationMeta).toBeDefined()

    // Test presentationMeta directly
    const extractedMeta = callTool!.output.presentationMeta!(
      { name: 'tool_with_meta' },
      { name: 'tool_with_meta', content: [], meta: { score: 99 } },
    )
    expect(extractedMeta).toEqual({ score: 99 })

    // Test execution through tool runner forwards meta
    const execResult = await runSingleTool(ctx, 'call_tool', {
      name: 'tool_with_meta',
      arguments: { key: 'alpha' },
    }, 'meta-test-call')

    expect(execResult.isError).toBe(false)
    if (!execResult.isError) {
      expect(execResult.meta).toEqual({ echoedKey: 'alpha' })
      expect((execResult.value as any)?.meta).toEqual({ echoedKey: 'alpha' })
    }
  })

  it('list_tools search returns complete usage and respects maxFullResults overflow', async () => {
    const ctx = await setup({ maxFullResults: 2 })

    const longSentence1 = 'This is the first sentence of a very descriptive tool that provides comprehensive documentation.'
    const longSentence2 = 'Here is the second sentence providing more detailed instructions and edge case specifications.'
    const longSentence3 = 'Finally a third sentence with additional background context and operational constraints.'
    const fullDescription = `${longSentence1} ${longSentence2} ${longSentence3}`

    ctx.tools.register(defineTool({
      name: 'batch_match_1',
      description: fullDescription,
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    ctx.tools.register(defineTool({
      name: 'batch_match_2',
      description: 'Second match description',
      parameters: { count: { type: 'integer' } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    ctx.tools.register(defineTool({
      name: 'batch_match_3',
      description: 'Third match description',
      parameters: { flag: { type: 'boolean' } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    // Search query matches all 3 tools
    const searchResult = await runSingleTool(ctx, 'list_tools', { action: 'search', query: 'batch_match' }, 'search-full-usage-call')

    expect(searchResult.isError).toBe(false)
    if (!searchResult.isError) {
      const block = searchResult.content[0]
      expect(block?.type).toBe('text')
      if (block && block.type === 'text') {
        const text = block.text
        expect(text).toContain('Found 3 tool(s):')
        // First 2 matches returned with full usage (header, untruncated description, compact schema)
        expect(text).toContain('### `batch_match_1`')
        expect(text).toContain(fullDescription)
        expect(text).toContain('```json\n{"type":"object"')
        expect(text).toContain('### `batch_match_2`')
        expect(text).toContain('Second match description')

        // 3rd match exceeds maxFullResults=2, so listed under overflow
        expect(text).toContain('Also matched (refine your query to see their full usage): batch_match_3')
        // 3rd match should NOT have a ### header
        expect(text).not.toContain('### `batch_match_3`')
      }
    }
  })

  it('list_tools action: "list" without query returns one-line catalog with footer', async () => {
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    const listResult = await runSingleTool(ctx, 'list_tools', { action: 'list' }, 'list-catalog-call')

    expect(listResult.isError).toBe(false)
    if (!listResult.isError) {
      const block = listResult.content[0]
      expect(block?.type).toBe('text')
      if (block && block.type === 'text') {
        const text = block.text
        expect(text).toContain('- `heavy_domain_tool(dataset, iterations?)`:')
        expect(text).toContain('Tip: Call `list_tools({ query: "<keyword>" })` to return complete descriptions and parameter schemas for matching tools')
      }
    }
  })

  it('get_tool_schema supports batch inspection with names array and handles unknown tools gracefully', async () => {
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    const result = await runSingleTool(ctx, 'get_tool_schema', {
      names: ['heavy_domain_tool', 'non_existent_tool_123'],
    }, 'batch-schema-call')

    expect(result.isError).toBe(false)
    if (!result.isError) {
      const parsed = JSON.parse(result.value as string) as Array<Record<string, unknown>>
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(2)

      // Known tool
      expect(parsed[0]?.name).toBe('heavy_domain_tool')
      expect(parsed[0]?.description).toContain('heavy specialized tool')
      expect(parsed[0]?.parameters).toHaveProperty('properties')

      // Unknown tool has error field rather than throwing
      expect(parsed[1]?.name).toBe('non_existent_tool_123')
      expect(parsed[1]?.error).toContain('not registered or not visible')
    }
  })

  it('get_tool_schema throws error when neither name nor names is provided', async () => {
    const ctx = await setup()

    const result = await runSingleTool(ctx, 'get_tool_schema', {}, 'empty-schema-call')

    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toContain('Either "name" or "names" must be provided')
    }
  })

  it('hints unknown parameters when inner tool execution fails', async () => {
    const ctx = await setup()

    const mockTool = defineTool({
      name: 'mcp__mock_gateway',
      description: 'Mock tool expecting args property',
      parameters: {
        name: { type: 'string' },
        args: { type: 'json' },
      },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute(args) {
        if (!args.args) {
          throw new Error('nodeId missing: args parameter is required')
        }
        return 'success'
      },
    })
    ctx.tools.register(mockTool)

    // Call with unknown key 'arguments' instead of declared 'args'
    const errorResult = await runSingleTool(ctx, 'call_tool', {
      name: 'mcp__mock_gateway',
      arguments: { name: 'test_node', arguments: { foo: 'bar' } },
    }, 'unknown-keys-call')

    expect(errorResult.isError).toBe(true)
    if (errorResult.isError) {
      expect(errorResult.error.message).toContain('Hint: "mcp__mock_gateway" does not declare parameter(s) arguments. Declared parameters: name, args.')
      expect(errorResult.error.message).toContain('arguments')
      expect(errorResult.error.message).toContain('args')
    }

    // Call with valid declared keys succeeds and does not alter output
    const successResult = await runSingleTool(ctx, 'call_tool', {
      name: 'mcp__mock_gateway',
      arguments: { name: 'test_node', args: { foo: 'bar' } },
    }, 'success-keys-call')

    expect(successResult.isError).toBe(false)
    if (!successResult.isError) {
      expect(successResult.content[0]?.type).toBe('text')
      if (successResult.content[0]?.type === 'text') {
        expect(successResult.content[0].text).toContain('success')
      }
    }
  })
})
