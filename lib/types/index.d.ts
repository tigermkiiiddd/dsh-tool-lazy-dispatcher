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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-lazy-dispatcher";
export declare const inject: string[];
/**
 * Default core tools that remain permanently pinned in the wire schema.
 * Defaults are official DSH tools only; non-existent names are harmless
 * (intersection with the live registry) but extra local tools should be added via `pinnedTools`.
 */
export declare const DEFAULT_PINNED_TOOLS: readonly string[];
export interface Config {
    /** Whether dynamic lazy tool folding is active (default true). */
    lazyToolFolding?: boolean;
    /** List of additional tool names to keep pinned alongside the defaults. */
    pinnedTools?: string[];
    /** Maximum number of search matches to return with full schema and usage (default 10). */
    maxFullResults?: number;
}
export declare const Config: z<Config>;
/** The only three indispensable meta-tools provided by this dispatcher that must always remain pinned. */
export declare const MANDATORY_META_TOOLS: readonly string[];
/**
 * Collapse whitespace and accumulate whole sentences up to `max` characters.
 * If the first sentence alone exceeds `max`, cut at the last whitespace before `max - 1`
 * (or hard cut if none) and append '…'.
 */
export declare function summarizeDescription(desc: string, max: number): string;
/**
 * Format a tool's parameter signature from its JSON-schema properties and required fields.
 * If total properties <= 5, optional parameters are listed by name with a `?` suffix (e.g. `call_tool(name?, args?, calls?)`).
 * When total properties > 5, outputs `name(req1, req2, +N opt)`, omitting `+N opt` when N=0, or `name()` when no params.
 */
export declare function formatSignature(t: {
    name: string;
    parameters?: unknown;
}): string;
/**
 * Defensively parse raw arguments into a record object.
 */
export declare function parseInnerArgs(raw: unknown): Record<string, unknown>;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map