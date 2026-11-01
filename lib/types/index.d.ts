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
/** Default core tools that remain permanently pinned in the wire schema. */
export declare const DEFAULT_PINNED_TOOLS: readonly string[];
export interface Config {
    /** Whether dynamic lazy tool folding is active (default true). */
    lazyToolFolding?: boolean;
    /** List of additional tool names to keep pinned alongside the defaults. */
    pinnedTools?: string[];
}
export declare const Config: z<Config>;
/** The only three indispensable meta-tools provided by this dispatcher that must always remain pinned. */
export declare const MANDATORY_META_TOOLS: readonly string[];
/** Global call count tracker for diagnostic and settings panel reporting. */
export declare const toolCallCounts: Map<string, number>;
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map