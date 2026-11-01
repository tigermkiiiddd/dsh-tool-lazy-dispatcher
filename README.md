# DSH Tool Lazy Dispatcher

English | [简体中文](./README.zh-CN.md)

High-performance dynamic tool lazy folding and progressive disclosure dispatcher plugin for **DeepSeek Harness (DSH)** and the **Cordis** framework.

Engineered to resolve context window bloat, redundant tool schemas, and frequent **KV Cache / prefix caching invalidation** in local inference engines (such as `llama-server` and vLLM).

---

## 📖 Background & Motivation

In modern autonomous agent systems (Agentic Coding), registering dozens of MCP servers, domain workflows, and specialized tools frequently expands the available tool count to **100 ~ 150+**.

In conventional architectures, the full JSON Schema for every registered tool is flattened into the top-level wire schema of every LLM turn. This incurs serious bottlenecks:

1. **Context Window Inflation**: 130+ tools and extensive descriptions consume **3,000 ~ 8,000 tokens** on every round-trip.
2. **Local KV Cache Eviction**: On local LLM backends (e.g. `llama-server`), fluctuating tool lists break Longest Common Prefix (LCP) caching, resulting in severe Time-to-First-Token (TTFT) latency spikes and wasted GPU compute.
3. **Loss of Multimodal Content**: Naive dispatch proxies frequently coerce return payloads into plain strings (e.g. converting images to literals like `[image block]`), rendering vision models blind to screenshots and visual artifacts.

---

## ⚡ Core Architecture & Features

This dispatcher implements a **three-tier Progressive Tool Disclosure protocol**:

### 1. Minimal Wire Schema (~80% Token Reduction)
- Only official DSH built-in core tools stay permanently pinned by default: File (`read`, `read_image`, `write`, `edit`, `str_replace_editor`), Search (`glob`, `grep`), Shell (`bash`, `pwsh`), Subagents (`subagent`), Web (`web_search`, `web_fetch`), Skills (`skill`), User interaction (`ask_user_question`), Planning (`todo_write`), Deliverables (`present`), and Dispatcher meta-tools & PTC (`list_tools`, `get_tool_schema`, `call_tool`, `run_code`).
- Extra local, third-party, or MCP tools should be pinned via `pinnedTools` configuration; all other tools are dynamically folded away from the wire schema.

### 2. Dynamic Discovery Tool: `list_tools` (with Complete Usage Search)
- When the model encounters an unfamiliar task or doesn't know what tool to use, it queries `list_tools`.
- Supports `action: 'search' | 'list'`, fuzzy keyword matching (`query: "screenshot"`, `query: "git"`, `query: "image"`), and category filtering.
- **Complete Usage in One Call**: For any search `query`, returns complete, untruncated descriptions and compact JSON parameter schemas for each match in a single call. If matches exceed `maxFullResults` (default 10), the first 10 show full usage and remaining matches are listed by name.
- **One-Line Catalog**: When browsing with `action: 'list'` without a query, returns a concise one-line catalog (~200 chars).

### 3. On-Demand Parameter Inspection: `get_tool_schema` (Single & Batch)
- Once a target tool is discovered, the model pulls its complete parameter specification and requirements on demand, supporting both single `name` and batch `names: [...]` lookup.

### 4. Universal Execution Proxy: `call_tool` (100% Multimodal Fidelity & Card Reuse)
- Executes any folded tool dynamically via `call_tool({ name, arguments })`.
- **Zero Loss for Media Blocks**: Deeply integrated into the DSH `ContentBlock` pipeline. Passes through `ImageBlock` structures and attachments intact. Screenshots, local image reads (`read_image`), and media analysis payloads reach the vision LLM with full fidelity.
- **UI Card Presentation Reuse**: Transparently delegates `presentCall` and `presentResult` to the target tool's presenters, reusing specialized UI cards and presentation metadata with safe fallback to generic cards.

---

## 📊 Comparison

### Before (Flat Wire Schema)
```
┌────────────────────────────────────────────────────────┐
│  LLM Context Window                                    │
│  ├── System Prompt                                     │
│  └── Top-Level Wire Tool Schemas (130+ Full Schemas)   │ ← 6,000+ Tokens!
│      ├── read, write, bash, edit...                    │
│      ├── 80+ MCP Tools (verbose nested schemas)        │
│      └── 40+ Domain Tools (workflow, team, etc.)       │
└────────────────────────────────────────────────────────┘
Repeated transmission every turn; breaks local KV Cache easily!
```

### After (Progressive Tool Disclosure)
```
┌────────────────────────────────────────────────────────┐
│  LLM Context Window                                    │
│  ├── System Prompt (Concise Progressive Guide)         │
│  └── Top-Level Wire Tool Schemas (~15 Core Tools Only) │ ← ~1,200 Tokens!
│      ├── Core File & Shell (read, write, bash, pwsh...)│
│      ├── list_tools      ← Search across 120+ tools    │
│      ├── get_tool_schema ← Inspect target parameters   │
│      └── call_tool       ← Universal proxy execution   │
└────────────────────────────────────────────────────────┘
Fast, lightweight turn-by-turn latency. On-demand 3-step execution:
[list_tools] ──> [get_tool_schema] ──> [call_tool]
```

---

## 🚀 Installation & Setup

### Method 1: Direct Installation in DSH Web UI (Recommended)

1. Open DeepSeek Harness Web UI or desktop client.
2. Go to **Settings / Plugins** and click **"Add Plugin"** (添加插件).
3. In the modal input, enter this GitHub repository address directly:
   ```text
   https://github.com/tigermkiiiddd/dsh-tool-lazy-dispatcher
   ```
   *(Or shorthand: `github:tigermkiiiddd/dsh-tool-lazy-dispatcher` or `tigermkiiiddd/dsh-tool-lazy-dispatcher`)*
4. Click **"Install"** (安装). DSH will automatically clone, build, and mount the plugin layer.

---

### Method 2: Via DSH CLI

Run inside your DSH workspace or profile:
```bash
dsh plugin install github:tigermkiiiddd/dsh-tool-lazy-dispatcher
```

---

### Method 3: Manual Monorepo / Profile Patch

1. Install the package from GitHub into your project or profile:
```bash
pnpm add github:tigermkiiiddd/dsh-tool-lazy-dispatcher
```

2. Register the plugin in your Cordis patch configuration (e.g. `cordis.patch.yml`):
```yaml
- insert:
    - id: tool-lazy-dispatcher
      name: 'dsh-tool-lazy-dispatcher'
      config:
        # Optional: pin additional high-frequency tools (e.g. screenshots)
        pinnedTools:
          - read_image
          - mcp__chrome__take_screenshot
          - mcp__sprite-pipeline__inspect_node_media

- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    lazyToolFolding: true
```

---

## 🛠️ Tool API Reference

### 1. `list_tools`
Search or browse available folded tools. Searching with a `query` returns complete usage and parameter schemas in a single call.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `action` | `'search' \| 'list'` | No | Action type: `'search'` (default if query provided) or `'list'` |
| `query` | `string` | No | Intent or capability keywords (e.g. `"image"`, `"screenshot"`, `"database"`) |
| `category` | `string` | No | Optional category filter |

**Example**:
```json
{
  "name": "list_tools",
  "arguments": {
    "action": "search",
    "query": "screenshot"
  }
}
```

### 2. `get_tool_schema`
Fetch complete parameter specifications for a specific tool or batch of tools.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | No* | Target tool name for single inspection |
| `names` | `string[]` | No* | List of tool names for batch schema inspection |

*\*Either `name` or `names` must be provided.*

**Example**:
```json
{
  "name": "get_tool_schema",
  "arguments": {
    "names": ["mcp__chrome__take_screenshot", "read_image"]
  }
}
```

### 3. `call_tool`
Universal dispatch proxy to execute folded tools.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | Yes | Target tool name |
| `arguments` | `object \| string` | No | Arguments payload (accepts JSON object or stringified JSON) |

**Example**:
```json
{
  "name": "call_tool",
  "arguments": {
    "name": "mcp__chrome__take_screenshot",
    "arguments": {
      "fullPage": true
    }
  }
}
```

---

## 🧪 Testing

The repository includes a comprehensive Vitest suite covering meta-tool registration, fuzzy discovery, schema querying, dispatch execution, and multimodal `ImageBlock` preservation:

```bash
pnpm test
```

---

## 📄 License

[MIT License](./LICENSE) © 2026 tigermkiiiddd
