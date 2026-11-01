/**
 * Dynamic Tool Lazy Folding and Progressive Disclosure Dispatcher.
 *
 * Keeps core high-frequency tools pinned in the model's top-level schema
 * while folding infrequent and heavy domain tools into a concise system prompt catalog.
 * Provides `get_tool_schema` for querying complete schemas on demand,
 * and `call_tool` as a universal proxy entry point to execute folded tools.
 *
 * @module @deepseek-ai/dsh-tool-lazy-dispatcher
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-settings'

export const name = 'tool-lazy-dispatcher'
export const inject = ['tools', 'systemPrompt']

/** Default core tools that remain permanently pinned in the wire schema. */
export const DEFAULT_PINNED_TOOLS: readonly string[] = [
  // File operations
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',

  // Search & workspace exploration
  'find_by_name',
  'grep_search',
  'file_search',
  'glob',
  'directory_list',
  'view_outline',

  // Terminal & execution
  'bash',
  'pwsh',
  'cmd',
  'exec_command',

  // Subagents
  'subagent',
  'subagent_list_agents',
  'subagent_send',
  'subagent_wait',
  'subagent_status',
  'subagent_cancel',

  // Web capabilities
  'web_search',
  'web_fetch',

  // Skills
  'skill',
  'activate_skill',
  'read_skill_ref',
  'list_skill_refs',

  // User communication
  'ask_user_question',
  'ask_question',
  'user_input',

  // Planning
  'todo_write',
  'todo_read',
  'todo',

  // Dispatcher meta-tools & presentation transport
  'list_tools',
  'get_tool_schema',
  'call_tool',
  'run_code',
]

export interface Config {
  /** Whether dynamic lazy tool folding is active (default true). */
  lazyToolFolding?: boolean
  /** List of additional tool names to keep pinned alongside the defaults. */
  pinnedTools?: string[]
}

export const Config: z<Config> = z.object({
  lazyToolFolding: z.boolean().default(true),
  pinnedTools: z.array(z.string()).default([]),
})

/** Check whether lazy tool folding is currently enabled in settings or config. */
function isFoldingEnabled(ctx: Context, config: Config): boolean {
  if (config.lazyToolFolding === false) return false
  const settings = ctx.get('settings')
  if (settings) {
    try {
      const entry = settings.describe().find(row => row.ns === 'ui-settings')
      if (entry && typeof entry.value === 'object' && entry.value !== null) {
        const val = (entry.value as Record<string, unknown>).lazyToolFolding
        if (typeof val === 'boolean') return val
      }
    } catch {
      // Fallback to config
    }
  }
  return true
}

/** The only three indispensable meta-tools provided by this dispatcher that must always remain pinned. */
export const MANDATORY_META_TOOLS: readonly string[] = [
  'list_tools',
  'get_tool_schema',
  'call_tool',
]

/** Resolve the effective set of pinned tool names from defaults, config, and settings. */
function resolvePinnedTools(ctx: Context, config: Config): Set<string> {
  const pinned = new Set<string>()
  let userConfigured = false

  const settings = ctx.get('settings')
  if (settings) {
    try {
      const entry = settings.describe().find(row => row.ns === 'ui-settings')
      if (entry && typeof entry.value === 'object' && entry.value !== null) {
        const raw = (entry.value as Record<string, unknown>).pinnedTools
        if (typeof raw === 'string' && raw.trim()) {
          userConfigured = true
          for (const item of raw.split(/[\s,]+/)) {
            if (item.trim()) pinned.add(item.trim())
          }
        }
      }
    } catch {
      // Fallback
    }
  }

  // If not customized by the user, populate from the recommended default list
  if (!userConfigured) {
    for (const item of DEFAULT_PINNED_TOOLS) {
      pinned.add(item)
    }
  }

  // Pinned tools from plugin configuration (e.g. cordis.patch.yml) are always merged
  if (Array.isArray(config.pinnedTools)) {
    for (const item of config.pinnedTools) {
      if (item.trim()) pinned.add(item.trim())
    }
  }

  // The dispatcher meta-tools are the only tools that must NEVER be folded
  for (const meta of MANDATORY_META_TOOLS) {
    pinned.add(meta)
  }

  return pinned
}

/** Global call count tracker for diagnostic and settings panel reporting. */
export const toolCallCounts = new Map<string, number>()

export function apply(ctx: Context, config: Config = {}): void {
  // Track tool executions to observe frequency
  ctx.on('tools/result', (exec) => {
    let toolName = exec.name
    if (toolName === 'call_tool' && typeof exec.arguments === 'object' && exec.arguments !== null) {
      const innerName = (exec.arguments as Record<string, unknown>).name
      if (typeof innerName === 'string') toolName = innerName
    }
    toolCallCounts.set(toolName, (toolCallCounts.get(toolName) ?? 0) + 1)
  })

  // 1. Register list_tools (with search action and query)
  ctx.tools.register(defineTool({
    name: 'list_tools',
    description: 'List or search available tools by keyword or intent. Use this to discover specialized tools when uncertain.',
    parameters: {
      action: {
        type: 'string',
        enum: ['search', 'list'],
        description: 'Action to perform: "search" to find tools by keyword/intent (default if query is provided), or "list" to view tool directory.',
      },
      query: {
        type: 'string',
        description: 'Keyword, capability, or domain to search for (e.g. "image", "screenshot", "git", "database", "sprite").',
      },
      category: {
        type: 'string',
        description: 'Optional category filter to narrow down results.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{
        type: 'text',
        text: value,
      }],
    },
    execute(args, exec) {
      const allTools = ctx.tools.schemas(exec.agent)
      const action = args.action ?? (args.query ? 'search' : 'list')
      const query = (args.query ?? '').toLowerCase().trim()
      const categoryFilter = (args.category ?? '').toLowerCase().trim()

      const matches = allTools.filter((t) => {
        if (t.name === 'list_tools' || t.name === 'get_tool_schema' || t.name === 'call_tool') {
          return false
        }
        if (categoryFilter && !t.name.toLowerCase().includes(categoryFilter) && !t.description.toLowerCase().includes(categoryFilter)) {
          return false
        }
        if (action === 'search' && query) {
          const qParts = query.split(/\s+/).filter(Boolean)
          const nameLower = t.name.toLowerCase()
          const descLower = t.description.toLowerCase()
          return qParts.some(part => nameLower.includes(part) || descLower.includes(part))
        }
        return true
      })

      if (matches.length === 0) {
        return Promise.resolve(`No tools found matching query "${query}". Try different keywords or check available tools.`)
      }

      // Truncate descriptions to 120 chars to keep token consumption minimal
      const lines = [
        `Found ${matches.length} tool(s):`,
        ...matches.map((t) => {
          const cleanDesc = t.description.replace(/[\r\n]+/g, ' ').trim()
          const truncated = cleanDesc.length > 120 ? `${cleanDesc.slice(0, 117)}...` : cleanDesc
          return `- \`${t.name}\`: ${truncated}`
        }),
        '',
        'Tip: Call `get_tool_schema({ name: "<tool_name>" })` to view parameters, or `call_tool({ name: "<tool_name>", arguments: { ... } })` to execute.',
      ]

      return Promise.resolve(lines.join('\n'))
    },
    presentCall: args => ({
      card: 'generic',
      title: args.query ? `Search tools: ${args.query}` : 'List available tools',
      kind: 'other',
      rawInput: args,
    }),
  }))

  // 2. Register get_tool_schema
  ctx.tools.register(defineTool({
    name: 'get_tool_schema',
    description: 'Inspect the full JSON schema, parameter specifications, and requirements for a specialized or folded tool before calling it.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The name of the tool to inspect (from list_tools or available tools directory).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{
        type: 'text',
        text: value,
      }],
    },
    execute(args, exec) {
      const def = ctx.tools.get(args.name, exec.agent)
      if (!def) {
        throw new Error(`Tool "${args.name}" is not registered or not visible in current scope. Call list_tools to discover available tools.`)
      }
      const schemaDoc = {
        name: def.name,
        description: def.description,
        parameters: def.parameters ?? {},
      }
      return Promise.resolve(JSON.stringify(schemaDoc, null, 2))
    },
    presentCall: args => ({ card: 'generic', title: `Inspect tool schema: ${args.name}`, kind: 'other', rawInput: args }),
  }))

  // 3. Register call_tool with 100% ContentBlock fidelity (preserving ImageBlocks, FileBlocks, etc.)
  let subCallCounter = 0
  ctx.tools.register(defineTool({
    name: 'call_tool',
    description: 'Universal dispatch proxy to execute any available folded or specialized tool by name with its arguments.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The target tool name to execute.',
      },
      arguments: {
        type: 'json',
        description: 'Arguments payload matching the target tool\'s parameter schema.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).content)) {
          return (value as Record<string, unknown>).content as ContentBlock[]
        }
        return [{
          type: 'text',
          text: typeof value === 'string' ? value : JSON.stringify(value),
        }]
      },
    },
    projectContent(_exec, result) {
      if (result.value && typeof result.value === 'object' && Array.isArray((result.value as Record<string, unknown>).content)) {
        return (result.value as Record<string, unknown>).content as ContentBlock[]
      }
      return result.content
    },
    async execute(args, exec: ToolRunContext) {
      const targetName = args.name
      let targetArgs: Record<string, unknown> = {}
      if (typeof args.arguments === 'string') {
        try {
          targetArgs = JSON.parse(args.arguments) as Record<string, unknown>
        } catch {
          targetArgs = { input: args.arguments }
        }
      } else if (typeof args.arguments === 'object' && args.arguments !== null) {
        targetArgs = args.arguments as Record<string, unknown>
      }
      const subCallId = ToolCallId(`${String(exec.callId)}:dispatch:${++subCallCounter}:${targetName}`)

      const result = await ctx.tools.execute({
        callId: subCallId,
        rootCallId: exec.rootCallId ?? exec.callId,
        name: targetName,
        arguments: targetArgs,
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        parent: exec.token,
        signal: exec.signal,
      })

      if (result.additionalContexts) {
        for (const extra of result.additionalContexts) {
          exec.deferContext(extra)
        }
      }

      if (result.concludesTurn) {
        exec.concludeTurn()
      }

      if (result.isError) {
        throw new Error(result.error.message)
      }

      // Preserve full ContentBlocks including ImageBlock, FileBlock, TextBlock, etc.
      const content = result.content.length > 0
        ? result.content
        : [{
            type: 'text' as const,
            text: result.value !== undefined
              ? (typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
              : `Tool "${targetName}" completed successfully with no output.`,
          }]

      return {
        name: targetName,
        content,
      } as any
    },
    presentCall: args => ({ card: 'generic', title: `Call tool: ${args.name}`, kind: 'other', rawInput: args }),
  }))

  // 4. Intercept system-prompt assembly to fold non-pinned tools and append concise progressive disclosure guide
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    if (!isFoldingEnabled(ctx, config)) return assembly

    // In PTC mode, only run_code is visible on wire anyway
    if (assembly.tools.length <= 1 && assembly.tools[0]?.name === 'run_code') {
      return assembly
    }

    const pinnedSet = resolvePinnedTools(ctx, config)
    const activeTools = assembly.tools.filter(t => pinnedSet.has(t.name) || t.name === 'list_tools' || t.name === 'get_tool_schema' || t.name === 'call_tool')
    const foldedTools = assembly.tools.filter(t => !pinnedSet.has(t.name) && t.name !== 'list_tools' && t.name !== 'get_tool_schema' && t.name !== 'call_tool')

    if (foldedTools.length === 0) return assembly

    assembly.tools = activeTools

    // Truncate descriptions to ~90 chars so the prompt stays compact and predictable
    const inventoryLines = [
      '## Specialized & Domain Tools (Progressive Disclosure)',
      'To optimize KV Cache and context tokens, full parameter schemas for specialized domain tools are folded.',
      '- To search/discover tools by capability or keyword: call `list_tools({ action: "search", query: "<keyword>" })`.',
      '- To view all tool categories or directory: call `list_tools({ action: "list" })`.',
      '- To inspect complete parameter specifications: call `get_tool_schema({ name: "<tool_name>" })`.',
      '- To execute any folded tool: call `call_tool({ name: "<tool_name>", arguments: { ... } })`.',
      '',
      '### Directory of Folded Tools:',
      ...foldedTools.map((t) => {
        const cleanDesc = t.description.replace(/[\r\n]+/g, ' ').trim()
        const truncated = cleanDesc.length > 90 ? `${cleanDesc.slice(0, 87)}...` : cleanDesc
        return `- \`${t.name}\`: ${truncated}`
      }),
    ]

    assembly.sections.push({
      name: 'tools:lazy-directory',
      text: inventoryLines.join('\n'),
    })

    return assembly
  })
}
