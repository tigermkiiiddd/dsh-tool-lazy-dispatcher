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
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'tool-lazy-dispatcher';
export const inject = ['tools', 'systemPrompt'];
/**
 * Default core tools that remain permanently pinned in the wire schema.
 * Defaults are official DSH tools only; non-existent names are harmless
 * (intersection with the live registry) but extra local tools should be added via `pinnedTools`.
 */
export const DEFAULT_PINNED_TOOLS = [
    // File
    'read',
    'read_image',
    'write',
    'edit',
    'str_replace_editor',
    // Search
    'glob',
    'grep',
    // Shell
    'bash',
    'pwsh',
    // Subagents
    'subagent',
    // Web
    'web_search',
    'web_fetch',
    // Skills
    'skill',
    // User interaction
    'ask_user_question',
    // Planning
    'todo_write',
    // Deliverables
    'present',
    // Dispatcher meta-tools & PTC transport
    'list_tools',
    'get_tool_schema',
    'call_tool',
    'run_code',
];
export const Config = z.object({
    lazyToolFolding: z.boolean().default(true),
    pinnedTools: z.array(z.string()).default([]),
    maxFullResults: z.natural().default(10),
});
/** Check whether lazy tool folding is currently enabled in settings or config. */
function isFoldingEnabled(ctx, config) {
    if (config.lazyToolFolding === false)
        return false;
    const settings = ctx.get('settings');
    if (settings) {
        try {
            const entry = settings.describe().find(row => row.ns === 'ui-settings');
            if (entry && typeof entry.value === 'object' && entry.value !== null) {
                const val = entry.value.lazyToolFolding;
                if (typeof val === 'boolean')
                    return val;
            }
        }
        catch {
            // Fallback to config
        }
    }
    return true;
}
/** The only three indispensable meta-tools provided by this dispatcher that must always remain pinned. */
export const MANDATORY_META_TOOLS = [
    'list_tools',
    'get_tool_schema',
    'call_tool',
];
/** Resolve the effective set of pinned tool names from defaults, config, and settings. */
function resolvePinnedTools(ctx, config) {
    const pinned = new Set();
    let userConfigured = false;
    const settings = ctx.get('settings');
    if (settings) {
        try {
            const entry = settings.describe().find(row => row.ns === 'ui-settings');
            if (entry && typeof entry.value === 'object' && entry.value !== null) {
                const raw = entry.value.pinnedTools;
                if (typeof raw === 'string' && raw.trim()) {
                    userConfigured = true;
                    for (const item of raw.split(/[\s,]+/)) {
                        if (item.trim())
                            pinned.add(item.trim());
                    }
                }
            }
        }
        catch {
            // Fallback
        }
    }
    // If not customized by the user, populate from the recommended default list
    if (!userConfigured) {
        for (const item of DEFAULT_PINNED_TOOLS) {
            pinned.add(item);
        }
    }
    // Pinned tools from plugin configuration (e.g. cordis.patch.yml) are always merged
    if (Array.isArray(config.pinnedTools)) {
        for (const item of config.pinnedTools) {
            if (item.trim())
                pinned.add(item.trim());
        }
    }
    // The dispatcher meta-tools are the only tools that must NEVER be folded
    for (const meta of MANDATORY_META_TOOLS) {
        pinned.add(meta);
    }
    return pinned;
}
/**
 * Collapse whitespace and accumulate whole sentences up to `max` characters.
 * If the first sentence alone exceeds `max`, cut at the last whitespace before `max - 1`
 * (or hard cut if none) and append '…'.
 */
export function summarizeDescription(desc, max) {
    const clean = desc.replace(/\s+/g, ' ').trim();
    if (!clean || max <= 0)
        return '';
    if (clean.length <= max)
        return clean;
    // Split after . ! ? 。 ！ ？ followed by whitespace or end, or after fullwidth Chinese punctuation
    const sentences = clean.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/).filter(Boolean);
    if (sentences.length === 0)
        return '';
    const first = sentences[0];
    if (first.length > max) {
        const limit = max - 1;
        if (limit <= 0)
            return '…';
        const sub = first.slice(0, limit);
        const lastSpace = sub.lastIndexOf(' ');
        if (lastSpace > 0) {
            return `${sub.slice(0, lastSpace)}…`;
        }
        return `${sub}…`;
    }
    let currentEnd = first.length;
    for (let i = 1; i < sentences.length; i++) {
        const nextStart = clean.indexOf(sentences[i], currentEnd);
        if (nextStart === -1)
            break;
        const nextEnd = nextStart + sentences[i].length;
        if (nextEnd <= max) {
            currentEnd = nextEnd;
        }
        else {
            break;
        }
    }
    return clean.slice(0, currentEnd);
}
/**
 * Format a tool's parameter signature from its JSON-schema properties and required fields.
 * If total properties <= 5, optional parameters are listed by name with a `?` suffix (e.g. `call_tool(name?, args?, calls?)`).
 * When total properties > 5, outputs `name(req1, req2, +N opt)`, omitting `+N opt` when N=0, or `name()` when no params.
 */
export function formatSignature(t) {
    const paramsObj = (typeof t.parameters === 'object' && t.parameters !== null)
        ? t.parameters
        : undefined;
    const properties = (paramsObj && typeof paramsObj.properties === 'object' && paramsObj.properties !== null)
        ? paramsObj.properties
        : undefined;
    const propKeys = properties ? Object.keys(properties) : [];
    const rawRequired = (paramsObj && Array.isArray(paramsObj.required))
        ? paramsObj.required.filter((r) => typeof r === 'string')
        : [];
    const requiredList = propKeys.length > 0
        ? propKeys.filter(k => rawRequired.includes(k))
        : rawRequired;
    const reqSet = new Set(requiredList);
    const optKeys = propKeys.filter(k => !reqSet.has(k));
    const totalCount = Math.max(propKeys.length, requiredList.length);
    const parts = [...requiredList];
    if (totalCount <= 5) {
        for (const opt of optKeys) {
            parts.push(`${opt}?`);
        }
    }
    else if (optKeys.length > 0) {
        parts.push(`+${optKeys.length} opt`);
    }
    if (parts.length === 0) {
        return `${t.name}()`;
    }
    return `${t.name}(${parts.join(', ')})`;
}
/**
 * Defensively parse raw arguments into a record object.
 */
export function parseInnerArgs(raw) {
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed;
            }
            return { input: raw };
        }
        catch {
            return { input: raw };
        }
    }
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        return raw;
    }
    return {};
}
export function apply(ctx, config = {}) {
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
            const allTools = ctx.tools.schemas(exec.agent);
            const action = args.action ?? (args.query ? 'search' : 'list');
            const query = (args.query ?? '').toLowerCase().trim();
            const categoryFilter = (args.category ?? '').toLowerCase().trim();
            const matches = allTools.filter((t) => {
                if (t.name === 'list_tools' || t.name === 'get_tool_schema' || t.name === 'call_tool') {
                    return false;
                }
                if (categoryFilter && !t.name.toLowerCase().includes(categoryFilter) && !t.description.toLowerCase().includes(categoryFilter)) {
                    return false;
                }
                if (action === 'search' && query) {
                    const qParts = query.split(/\s+/).filter(Boolean);
                    const nameLower = t.name.toLowerCase();
                    const descLower = t.description.toLowerCase();
                    return qParts.some(part => nameLower.includes(part) || descLower.includes(part));
                }
                return true;
            });
            if (matches.length === 0) {
                return Promise.resolve(`No tools found matching query "${query}". Try different keywords or check available tools.`);
            }
            // If browsing without a search query, return the one-line catalog to avoid token explosion
            if (action === 'list' && !query) {
                const lines = [
                    `Found ${matches.length} tool(s):`,
                    ...matches.map(t => `- \`${formatSignature(t)}\`: ${summarizeDescription(t.description, 200)}`),
                    '',
                    'Tip: Call `list_tools({ query: "<keyword>" })` to return complete descriptions and parameter schemas for matching tools, or `call_tool({ name: "<tool_name>", arguments: { ... } })` to execute.',
                ];
                return Promise.resolve(lines.join('\n'));
            }
            // Search action with query: return COMPLETE usage for each match (up to maxFullResults)
            const maxFull = config.maxFullResults ?? 10;
            const fullMatches = matches.slice(0, maxFull);
            const overflowMatches = matches.slice(maxFull);
            const lines = [
                `Found ${matches.length} tool(s):`,
                '',
            ];
            for (const t of fullMatches) {
                const cleanDesc = t.description.replace(/\s+/g, ' ').trim();
                lines.push(`### \`${t.name}\``);
                lines.push(cleanDesc);
                lines.push('```json');
                lines.push(JSON.stringify(t.parameters ?? {}));
                lines.push('```');
                lines.push('');
            }
            if (overflowMatches.length > 0) {
                lines.push(`Also matched (refine your query to see their full usage): ${overflowMatches.map(t => t.name).join(', ')}`);
                lines.push('');
            }
            lines.push('Tip: Call `call_tool({ name: "<tool_name>", arguments: { ... } })` to execute.');
            return Promise.resolve(lines.join('\n'));
        },
        presentCall: args => ({
            card: 'generic',
            title: args.query ? `Search tools: ${args.query}` : 'List available tools',
            kind: 'other',
            rawInput: args,
        }),
    }));
    // 2. Register get_tool_schema
    ctx.tools.register(defineTool({
        name: 'get_tool_schema',
        description: 'Inspect the full JSON schema, parameter specifications, and requirements for a specialized or folded tool before calling it.',
        parameters: {
            name: {
                type: 'string',
                description: 'The name of a single tool to inspect.',
            },
            names: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of tool names for batch schema inspection.',
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
            if (!args.name && (!Array.isArray(args.names) || args.names.length === 0)) {
                throw new Error('Either "name" or "names" must be provided to inspect tool schema(s).');
            }
            if (Array.isArray(args.names) && args.names.length > 0) {
                const results = args.names.map((toolName) => {
                    const def = ctx.tools.get(toolName, exec.agent);
                    if (!def) {
                        return {
                            name: toolName,
                            error: `Tool "${toolName}" is not registered or not visible in current scope.`,
                        };
                    }
                    return {
                        name: def.name,
                        description: def.description,
                        parameters: def.parameters ?? {},
                    };
                });
                return Promise.resolve(JSON.stringify(results, null, 2));
            }
            const targetName = args.name;
            const def = ctx.tools.get(targetName, exec.agent);
            if (!def) {
                throw new Error(`Tool "${targetName}" is not registered or not visible in current scope. Call list_tools to discover available tools.`);
            }
            const schemaDoc = {
                name: def.name,
                description: def.description,
                parameters: def.parameters ?? {},
            };
            return Promise.resolve(JSON.stringify(schemaDoc, null, 2));
        },
        presentCall: (args) => {
            const title = args.names && args.names.length > 0
                ? `Inspect tool schemas: ${args.names.join(', ')}`
                : `Inspect tool schema: ${args.name ?? 'unknown'}`;
            return { card: 'generic', title, kind: 'other', rawInput: args };
        },
    }));
    // 3. Register call_tool with 100% ContentBlock fidelity (preserving ImageBlocks, FileBlocks, etc.)
    let subCallCounter = 0;
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
                if (value && typeof value === 'object' && Array.isArray(value.content)) {
                    return value.content;
                }
                return [{
                        type: 'text',
                        text: typeof value === 'string' ? value : JSON.stringify(value),
                    }];
            },
            presentationMeta: (_args, value) => {
                if (value && typeof value === 'object' && 'meta' in value) {
                    const meta = value.meta;
                    return (meta !== undefined ? meta : null);
                }
                return null;
            },
        },
        async execute(args, exec) {
            const targetName = args.name;
            const targetArgs = parseInnerArgs(args.arguments);
            const subCallId = ToolCallId(`${String(exec.callId)}:dispatch:${++subCallCounter}:${targetName}`);
            const result = await ctx.tools.execute({
                callId: subCallId,
                rootCallId: exec.rootCallId ?? exec.callId,
                name: targetName,
                arguments: targetArgs,
                ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
                parent: exec.token,
                signal: exec.signal,
            });
            if (result.additionalContexts) {
                for (const extra of result.additionalContexts) {
                    exec.deferContext(extra);
                }
            }
            if (result.concludesTurn) {
                exec.concludeTurn();
            }
            if (result.isError) {
                let hint = '';
                const targetDef = ctx.tools.get(targetName, exec.agent);
                const params = targetDef?.parameters;
                const props = (params && typeof params.properties === 'object' && params.properties !== null)
                    ? params.properties
                    : undefined;
                const declared = props ? Object.keys(props) : [];
                if (declared.length > 0) {
                    const unknownKeys = Object.keys(targetArgs).filter(k => !declared.includes(k));
                    if (unknownKeys.length > 0) {
                        hint = `\nHint: "${targetName}" does not declare parameter(s) ${unknownKeys.join(', ')}. Declared parameters: ${declared.join(', ')}.`;
                    }
                }
                throw new Error(`${result.error.message}${hint}`);
            }
            // Preserve full ContentBlocks including ImageBlock, FileBlock, TextBlock, etc.
            const content = result.content.length > 0
                ? result.content
                : [{
                        type: 'text',
                        text: result.value !== undefined
                            ? (typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2))
                            : `Tool "${targetName}" completed successfully with no output.`,
                    }];
            const returnValue = {
                name: targetName,
                content,
                ...(result.meta !== undefined ? { meta: result.meta } : {}),
            };
            // Return canonical value matching output.schema (narrow cast)
            return returnValue;
        },
        presentCall(args) {
            const innerArgs = parseInnerArgs(args?.arguments);
            if (args?.name) {
                try {
                    const target = ctx.tools.get(args.name);
                    if (typeof target?.presentCall === 'function') {
                        const view = target.presentCall(innerArgs);
                        if (view)
                            return view;
                    }
                }
                catch {
                    // Presenters must never throw; fall through to generic card
                }
            }
            return {
                card: 'generic',
                title: `Call tool: ${args?.name ?? 'unknown'}`,
                kind: 'other',
                rawInput: innerArgs,
            };
        },
        presentResult(args, result) {
            if (!args?.name)
                return undefined;
            try {
                const target = ctx.tools.get(args.name);
                if (typeof target?.presentResult === 'function') {
                    const innerArgs = parseInnerArgs(args.arguments);
                    const innerResult = {
                        content: result.content,
                        isError: result.isError,
                        ...(result.meta != null ? { meta: result.meta } : {}),
                    };
                    return target.presentResult(innerArgs, innerResult);
                }
            }
            catch {
                // Presenters must never throw
                return undefined;
            }
            return undefined;
        },
    }));
    // 4. Intercept system-prompt assembly to fold non-pinned tools and append concise progressive disclosure guide
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        if (!isFoldingEnabled(ctx, config))
            return assembly;
        // In PTC mode, only run_code is visible on wire anyway
        if (assembly.tools.length <= 1 && assembly.tools[0]?.name === 'run_code') {
            return assembly;
        }
        const pinnedSet = resolvePinnedTools(ctx, config);
        const activeTools = assembly.tools.filter(t => pinnedSet.has(t.name) || t.name === 'list_tools' || t.name === 'get_tool_schema' || t.name === 'call_tool');
        const foldedTools = assembly.tools.filter(t => !pinnedSet.has(t.name) && t.name !== 'list_tools' && t.name !== 'get_tool_schema' && t.name !== 'call_tool');
        if (foldedTools.length === 0)
            return assembly;
        assembly.tools = activeTools;
        // Summarize descriptions (up to 140 chars) so the prompt stays compact and predictable
        const inventoryLines = [
            '## Specialized & Domain Tools (Progressive Disclosure)',
            'To optimize KV Cache and context tokens, full parameter schemas for specialized domain tools are folded.',
            '- To search/discover tools: call `list_tools({ query: "<keyword>" })` (returns complete descriptions and parameter schemas for matching tools in one call).',
            '- To view all tool categories or directory: call `list_tools({ action: "list" })`.',
            '- To inspect complete parameter specifications: call `get_tool_schema({ name: "<tool_name>" })`.',
            '- To execute any folded tool: call `call_tool({ name: "<tool_name>", arguments: { ... } })`.',
            '',
            '### Directory of Folded Tools:',
            ...foldedTools.map((t) => {
                return `- \`${formatSignature(t)}\`: ${summarizeDescription(t.description, 140)}`;
            }),
        ];
        assembly.sections.push({
            name: 'tools:lazy-directory',
            text: inventoryLines.join('\n'),
        });
        return assembly;
    });
}
//# sourceMappingURL=index.js.map