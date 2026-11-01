# DSH Tool Lazy Dispatcher (动态工具惰性折叠与渐进式调度器)

[English](./README.md) | 简体中文

适用于 **DeepSeek Harness (DSH)** 与 **Cordis** 生态的高性能动态工具惰性折叠（Lazy Folding）与渐进式暴露（Progressive Disclosure）调度插件。

专为解决大模型上下文膨胀、工具 Schema 冗余以及本地 `llama-server` / vLLM 的 **前缀缓存（KV Cache）频繁失效** 难题而设计。

---

## 📖 诞生背景与痛点

在现代自主智能体（Agentic Coding）中，随着 MCP 服务器、工作流工具、领域插件的引入，注册的工具数量经常迅速膨胀到 **100 ~ 150+** 个。

传统方式是将所有工具的完整 JSON Schema 扁平地暴露在每轮 LLM 请求的顶层 Wire Schema 中，这带来了灾难性的性能瓶颈：

1. **上下文严重浪费**：130+ 个工具的 Schema 和长描述会强行吃掉 **3,000 ~ 8,000 tokens**，每轮多轮对话都在重复传输巨额冗余数据。
2. **本地模型 KV Cache 频繁失效**：在本地运行 `llama-server` 等推理后端时，随会话动态变化的工具描述会导致 LCP 前缀缓存被无情击穿，造成巨大的首字生成延迟（TTFT）与 GPU 算力浪费。
3. **多模态与媒体块易丢失**：一般的工具代理如果没有经过底层针对性适配，经常在透传结果时将多模态数据强转为纯文本（例如把图片换成 `[image block]`），导致视觉大模型无法查看截图和图像。

---

## ⚡ 核心设计与特性

本插件通过 **三层渐进式暴露协议（Progressive Tool Disclosure）** 彻底解决上述问题：

### 1. 顶层 Wire Schema 极简化（~80% 瘦身）
- 顶层默认仅常驻 DSH 官方内置核心工具：文件（`read`, `read_image`, `write`, `edit`, `str_replace_editor`）、搜索（`glob`, `grep`）、终端（`bash`, `pwsh`）、子代理（`subagent`）、网络（`web_search`, `web_fetch`）、技能（`skill`）、交互（`ask_user_question`）、规划（`todo_write`）、成果物（`present`）、元工具及 PTC 传输（`list_tools`, `get_tool_schema`, `call_tool`, `run_code`）。
- 本地扩展或 MCP 工具请通过 `pinnedTools` 配置按需常驻；其余低频与重型工具动态折叠。

### 2. 动态工具发现工具：`list_tools` (单次查询返回完整用法)
- 大模型遇到不确定的需求或不知道用什么工具时，无需靠猜，直接调用 `list_tools` 动态检索。
- 支持 `action: 'search' | 'list'`，支持关键词与意图模糊搜索（如 `query: "screenshot"`、`query: "image"`、`query: "git"`）。
- **一次查询返回完整用法**：对任何检索 `query`，单次调用即可返回每个匹配工具的完整长描述（不截断）以及紧凑的参数 JSON Schema。若匹配工具数超出 `maxFullResults`（默认 10），前 10 个展示完整用法，其余工具仅列出名称。
- **单行精简目录**：无查询词的纯浏览 `action: 'list'` 保留紧凑单行格式（约 200 字符内），避免长文本污染。

### 3. 按需拉取 Schema：`get_tool_schema` (支持单工具及批量)
- 模型发现所需工具后，可按需查询特定工具的完整参数规范与 JSON Schema，支持单个 `name` 或批量 `names: [...]` 查询。

### 4. 万能代理调用：`call_tool`（100% 多模态保真与 UI 卡片复用）
- 模型直接通过 `call_tool({ name, arguments })` 代理执行被折叠的工具。
- **媒体块零损失**：深度适配 DSH 的 `ContentBlock` 管线，底层透传 `ImageBlock` 及其附件元数据。`read_image`、浏览器截图、多媒体分析等工具生成的图片能够 **原样送达视觉模型与 Web UI**。
- **UI 卡片无缝复用**：自动代理目标工具的 `presentCall` 与 `presentResult`，复用专业 UI 卡片展示与元数据透传，兜底保障安全回退。

---

## 📊 架构对比

### 改造前（传统全量暴露模式）
```
┌────────────────────────────────────────────────────────┐
│  LLM Context Window                                    │
│  ├── System Prompt                                     │
│  └── Top-Level Wire Tool Schemas (130+ 工具完整定义)   │ ← 占用 6,000+ Tokens!
│      ├── read, write, bash, edit...                    │
│      ├── 80+ 个 MCP 工具 (长篇英文参数与复杂嵌套)       │
│      └── 40+ 个领域工具 (工作流、团队、数据库...)       │
└────────────────────────────────────────────────────────┘
每次对话重复传输，本地 KV Cache 极易颠簸失效！
```

### 改造后（渐进式暴露模式）
```
┌────────────────────────────────────────────────────────┐
│  LLM Context Window                                    │
│  ├── System Prompt (极简 Progressive Disclosure 指引)   │
│  └── Top-Level Wire Tool Schemas (仅 ~15 个核心工具)   │ ← 仅需 ~1,200 Tokens!
│      ├── 常用文件与终端 (read, write, bash, pwsh...)    │
│      ├── list_tools      ← 动态模糊搜索 120+ 个折叠工具 │
│      ├── get_tool_schema ← 按需查单个工具 Schema        │
│      └── call_tool       ← 万能代理执行 (多模态完整保留) │
└────────────────────────────────────────────────────────┘
日常交互极速响应，需要高级能力时按需三步调用：
[list_tools] ──> [get_tool_schema] ──> [call_tool]
```

---

## 🚀 安装与启用

### 方式一：在 DSH 图形界面直接安装（最推荐）

1. 打开 DeepSeek Harness Web UI 或桌面客户端。
2. 进入 **插件管理 / 设置** 页面，点击 **「添加插件」** 按钮。
3. 在弹出的输入框中直接粘贴本项目的 GitHub 仓库地址：
   ```text
   https://github.com/tigermkiiiddd/dsh-tool-lazy-dispatcher
   ```
   *(亦可简写输入 `github:tigermkiiiddd/dsh-tool-lazy-dispatcher` 或 `tigermkiiiddd/dsh-tool-lazy-dispatcher`)*
4. 点击 **「安装」**，DSH 将自动下载代码、构建并挂载生效。

---

### 方式二：通过 DSH CLI 命令行安装

在 DSH 根目录或对应 profile 下执行：
```bash
dsh plugin install github:tigermkiiiddd/dsh-tool-lazy-dispatcher
```

---

### 方式三：手动配置与二次开发

1. 在项目或 profile 中安装依赖：
```bash
pnpm add dsh-tool-lazy-dispatcher
```

2. 在 Cordis 配置补丁文件（如 `cordis.patch.yml`）中挂载插件：
```yaml
- insert:
    - id: tool-lazy-dispatcher
      name: 'dsh-tool-lazy-dispatcher'
      config:
        # 可选：配置额外常驻的高频工具名单（如截图工具）
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

## 🛠️ API 工具参考

### 1. `list_tools`
动态搜索或列出可用工具。通过 `query` 检索时一次性返回完整用法与参数 Schema。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `action` | `'search' \| 'list'` | 否 | 操作类型：`'search'`（关键词检索，默认）或 `'list'`（列出全部目录） |
| `query` | `string` | 否 | 意图或能力关键词（如 `"image"`、`"screenshot"`、`"database"`） |
| `category` | `string` | 否 | 可选分类过滤 |

**调用示例**：
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
按需查询特定工具或批量工具的完整 JSON Schema。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 否* | 单工具查询的目标工具名 |
| `names` | `string[]` | 否* | 批量工具查询的目标工具名数组 |

*\*`name` 与 `names` 至少需提供其一。*

**调用示例**：
```json
{
  "name": "get_tool_schema",
  "arguments": {
    "names": ["mcp__chrome__take_screenshot", "read_image"]
  }
}
```

### 3. `call_tool`
万能代理执行入口。

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | `string` | 是 | 目标工具全名 |
| `arguments` | `object \| string` | 否 | 传给目标工具的参数载荷（对象或 JSON 字符串均支持） |

**调用示例**：
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

## 🧪 单元测试

本项目自带完整的单元测试套件，涵盖元工具注册、动态搜索、Schema 按需查询、代理执行、系统提示词拦截、以及多模态 `ImageBlock` 保真透传测试：

```bash
pnpm test
```

---

## 📄 License

[MIT License](./LICENSE) © 2026 tigermkiiiddd
