import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LazyDispatcher from '../src/index.ts'

const testSignal = new AbortController().signal

async function setup(config: LazyDispatcher.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LazyDispatcher, config)
  return ctx
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

    const result = await ctx.tools.execute({
      callId: ToolCallId('test-call-1'),
      name: 'get_tool_schema',
      arguments: { name: 'heavy_domain_tool' },
      signal: testSignal,
    })

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

    const result = await ctx.tools.execute({
      callId: ToolCallId('test-call-2'),
      name: 'call_tool',
      arguments: {
        name: 'heavy_domain_tool',
        arguments: { dataset: 'sales_2026', iterations: 5 },
      },
      signal: testSignal,
    })

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
    const ctx = await setup()
    ctx.tools.register(mockHeavyTool)

    // Register a standard pinned tool (e.g., read)
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    const assembly = await ctx.systemPrompt.assemble()

    // Active tools should keep read, get_tool_schema, and call_tool
    const toolNames = assembly.tools.map(t => t.name)
    expect(toolNames).toContain('read')
    expect(toolNames).toContain('get_tool_schema')
    expect(toolNames).toContain('call_tool')
    // heavy_domain_tool should be folded away from assembly.tools!
    expect(toolNames).not.toContain('heavy_domain_tool')

    // System prompt sections should include the folded tool directory
    const lazySection = assembly.sections.find(s => s.name === 'tools:lazy-directory')
    expect(lazySection).toBeDefined()
    expect(lazySection?.text).toContain('heavy_domain_tool')
    expect(lazySection?.text).toContain('A heavy specialized tool that should be folded')
  })

  it('does not fold tools when lazyToolFolding is false in config', async () => {
    const ctx = await setup({ lazyToolFolding: false })
    ctx.tools.register(mockHeavyTool)

    const assembly = await ctx.systemPrompt.assemble()
    const toolNames = assembly.tools.map(t => t.name)
    // When disabled, heavy_domain_tool stays in assembly.tools
    expect(toolNames).toContain('heavy_domain_tool')
    const lazySection = assembly.sections.find(s => s.name === 'tools:lazy-directory')
    expect(lazySection).toBeUndefined()
  })

  it('allows folding default tools when user customizes pinned list, while always keeping mandatory meta-tools', async () => {
    // Register settings service mock with user-customized pinned list that excludes 'read'
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
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

    ctx.tools.register(mockHeavyTool)
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'ok' },
    }))

    const assembly = await ctx.systemPrompt.assemble()
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
    const searchResult = await ctx.tools.execute({
      callId: ToolCallId('search-call-1'),
      name: 'list_tools',
      arguments: { action: 'search', query: 'heavy' },
      signal: testSignal,
    })
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
    const missResult = await ctx.tools.execute({
      callId: ToolCallId('search-call-2'),
      name: 'list_tools',
      arguments: { action: 'search', query: 'non_existent_xyz' },
      signal: testSignal,
    })
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

    const result = await ctx.tools.execute({
      callId: ToolCallId('call-img-1'),
      name: 'call_tool',
      arguments: { name: 'screenshot_tool' },
      signal: testSignal,
    })

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
})
