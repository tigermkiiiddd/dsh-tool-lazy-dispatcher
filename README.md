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
- Only ~10–15 high-frequency core tools (file operations, shell, subagents, and the 3 meta-tools of this dispatcher) stay permanently in the top-level wire schema.
- All specialized, heavy domain tools (MCP servers, complex workflows, multi-agent teams) are dynamically folded away from the wire schema.

### 2. Dynamic Discovery Tool: `list_tools` (with Search Action)
- When the model encounters an unfamiliar task or doesn't know what tool to use, it queries `list_tools`.
- Supports `action: 'search' | 'list'`, fuzzy keyword matching (`query: "screenshot"`, `query: "git"`, `query: "image"`), and category filtering.
- **Automatic Description Truncation**: Returned descriptions are concisely clipped (~120 chars) to prevent context pollution.

### 3. On-Demand Parameter Inspection: `get_tool_schema`
- Once a target tool is discovered, the model pulls its complete parameter specification and requirements on demand.

### 4. Universal Execution Proxy: `call_tool` (100% Multimodal Fidelity)
- Executes any folded tool dynamically via `call_tool({ name, arguments })`.
- **Zero Loss for Media Blocks**: Deeply integrated into the DSH `ContentBlock` pipeline. Passes through `ImageBlock` structures and attachments intact. Screenshots, local image reads (`read_image`), and media analysis payloads reach the vision LLM with full fidelity.

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

### Inside DeepSeek Harness

1. Install the package into your project or profile:
```bash
pnpm add dsh-tool-lazy-dispatcher
```

2. Register the plugin in your Cordis patch configuration (e.g. `cordis.patch.yml`):
```yaml
- insert:
    - id: tool-lazy-dispatcher
      name: '@deepseek-ai/dsh-tool-lazy-dispatcher'
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
Search or browse available folded tools.

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
Fetch the complete parameter specifications for a specific tool.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | Yes | Target tool name |

**Example**:
```json
{
  "name": "get_tool_schema",
  "arguments": {
    "name": "mcp__chrome__take_screenshot"
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
