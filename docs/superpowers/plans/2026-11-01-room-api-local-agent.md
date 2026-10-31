# Room API 本机任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Room 本机任务改为使用 Room 已配置的一个模型 API，并在用户确认文件修改或命令后操作所选工作目录。

**Architecture:** 在现有 Room API 适配层增加 provider 原生工具调用协议和逐次费用计数；Tauri 端运行有上限的任务循环和受限本地工具；前端通过任务卡显示搜索/读取进度、文件改动预览、命令审批和命令结果。测试命令结果回传模型后可继续修正。普通聊天保持无工具调用。

**Tech Stack:** Rust、Tauri 2、React 19、TypeScript、现有 Node test runner 和 Cargo 测试。

**Spec:** `docs/superpowers/specs/2026-11-01-room-api-local-agent-design.md`

## Global Constraints

- 一项任务只调用用户选定的一个已配置 API 模型；不得自动切换模型或触发其他模型。不启动 Claude Code、Antigravity、OpenCode 等外部 Agent CLI；Room 中已配置的 Claude API（若有）仅作为普通 API 模型使用。
- 工作目录内容按模型请求逐个读取后才发送给 API；不得默认上传整个目录。
- 文件修改须展示修改前后内容并经用户确认；命令须展示完整命令、工作目录、当前用户权限和“命令输出会发送给当前模型”的提示后经用户确认。
- 命令以当前 Windows 用户权限运行；工作目录不是系统隔离区，确认界面必须说明。
- 复用 Room 凭据、价格确认、付费开关和每日调用/预算限制；每次 API 往返计入限制，不自动重试。
- 普通 Room 聊天继续不提供工具；模拟模式不发起 API 调用。
- 真实 API 验收可能计费，必须另行取得用户确认；本计划的代码测试使用模拟响应。
- 不添加新依赖；沿用固定 `CARGO_TARGET_DIR=D:\win桌面\src-tauri\target`。

## Review Focus

- Windows 绝对路径、`..`、UNC 路径及符号链接不能越出所选目录；由本地工具路径测试覆盖。
- `.git`、`.env*`、私钥及 `node_modules`/`target`/`dist` 等生成目录默认跳过；由本地工具拒绝列表和搜索结果上限测试覆盖。
- Provider 返回畸形、未知或不支持的工具调用时不能执行；由每种协议的解析测试覆盖。
- 搜索结果只限所选目录、敏感文件/常见生成目录过滤且有数量/长度上限；越界路径和符号链接逃逸均拒绝。搜索片段和文件内容只在模型请求相应工具后发送。
- 支持状态按具体 provider + model 处理；未知或不支持原生工具调用时明确报错，不自动回退。
- 用户确认前、拒绝后及文件内容已变化时不能写入；由审批与过期修改测试覆盖。
- 命令和 API 任务取消时必须停止等待/执行并保留清晰状态；由任务状态与审批取消测试覆盖。

---

### Task 1: Room API 工具调用协议

**Files:**
- Modify: `src-tauri/src/agent_room_workspace.rs`
- Test: `src-tauri/src/agent_room_workspace.rs` 内 `tests` 模块

**Interfaces:**
- 提供 `pub(crate) enum AgentApiMessage { User(String), Assistant { text: String, calls: Vec<AgentApiToolCall>, provider_payload: Option<Value> }, ToolResults(Vec<AgentApiToolResult>) }`；对带工具调用的助手消息保留服务商原始 payload，以便后续请求无损回传。
- 提供 `pub(crate) struct AgentApiTool { name: String, description: String, parameters: serde_json::Value }`。
- 提供 `pub(crate) struct AgentApiToolCall { id: String, name: String, arguments: serde_json::Value }`。
- 提供 `pub(crate) struct AgentApiToolResult { call_id: String, name: String, content: String }`。
- 提供 `api_body_for_agent(config, system_prompt, history, tools, output_tokens) -> Result<Value, String>` 和 `parse_agent_turn(provider, response) -> Result<AgentApiTurn, String>`。

- [ ] **Step 1: 为 OpenAI-compatible、Claude、Gemini 和 Ollama 工具请求/回复格式补充失败测试**
  - 断言工具定义按 provider 原生字段序列化，回复中的名称、调用 ID、参数和文本按约定解析，并验证助手原始工具调用 payload 能无损进入下一轮请求。
  - 覆盖未知工具名、无效 JSON 参数、空调用列表和 provider 拒绝工具调用的情况；在任务分发测试中断言这些情况不会执行本地工具。
  - 断言旧 `api_body` 和 `parse_reply` 对普通聊天仍不发送或接受工具调用。
- [ ] **Step 2: 设置 `$env:CARGO_TARGET_DIR='D:\win桌面\src-tauri\target'` 并运行 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_room::workspace::tests`，确认新增测试失败**
- [ ] **Step 3: 实现上述消息类型、provider 工具请求构造和独立任务回复解析**
  - OpenAI-compatible 覆盖 DeepSeek、GPT、Qwen、Kimi、Grok、豆包、MiMo。
  - Claude 使用 Messages `tool_use` / `tool_result` 格式；Gemini 使用 `functionCall` / `functionResponse`；Ollama 使用其原生 `tool_calls` 格式。
  - 普通聊天路径维持原样。
- [ ] **Step 4: 重跑 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_room::workspace::tests`，确认新增测试通过**

### Task 2: 受限本地文件工具与审批数据

**Files:**
- Create: `src-tauri/src/agent_local_tools.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/agent_local_tools.rs` 内 `tests` 模块

**Interfaces:**
- `WorkspaceRoot::new(path: &str) -> Result<WorkspaceRoot, String>` 保存规范化后的用户工作目录。
- `WorkspaceRoot::list_files(relative_path: &str) -> Result<Vec<WorkspaceEntry>, String>` 只返回有界的相对路径清单。
- `WorkspaceRoot::search_text(query: &str, relative_path: &str) -> Result<Vec<SearchMatch>, String>` 在所选目录内返回有界的相对路径、行号和文本片段；搜索仅在模型请求后执行。
- `WorkspaceRoot::read_text(relative_path: &str) -> Result<String, String>` 读取受大小限制的 UTF-8 文本。
- `WorkspaceRoot::propose_edit(relative_path: &str, old_text: &str, new_text: &str) -> Result<PendingEdit, String>` 只生成待审阅修改，不写磁盘。
- `WorkspaceRoot::apply_edit(edit: &PendingEdit) -> Result<(), String>` 仅当原文仍匹配且用户已批准时写入。
- `WorkspaceEntry`、`SearchMatch` 和 `PendingEdit` 仅含相对路径、显示所需文本和校验信息，不包含 API 凭据。
- 任务工具只公开列目录、搜索文本、读取文本、提出修改、运行命令五种操作；未知名称一律返回工具错误。

- [ ] **Step 1: 编写根目录越界、绝对路径、链接逃逸、敏感/生成目录、二进制/超大文件和搜索结果上限测试**
- [ ] **Step 2: 设置 `$env:CARGO_TARGET_DIR='D:\win桌面\src-tauri\target'` 并运行 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_local_tools::tests`，确认新增测试失败**
- [ ] **Step 3: 实现规范化路径检查、默认排除 `.git`/`.env*`/密钥文件及 `node_modules`/`target`/`dist` 等常见生成目录、目录清单、受限文本搜索和有界文本读取**
- [ ] **Step 4: 编写待审阅修改不写磁盘、批准后写入、拒绝不写入、原文变化时拒绝写入的测试**
- [ ] **Step 5: 实现精确原文匹配和经批准的文件写入；在 `lib.rs` 注册新模块**
- [ ] **Step 6: 重跑 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_local_tools::tests`，确认通过**

### Task 3: API 任务循环、费用计数、命令审批和取消

**Files:**
- Modify: `src-tauri/src/agent_task.rs`
- Modify: `src-tauri/src/agent_room_workspace.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: 两个 Rust 模块中的 `tests` 模块

**Interfaces:**
- `agent_task_models(view) -> Result<Vec<AgentTaskModel>, String>` 返回已配置模型及服务商协议状态；具体模型在未经真实响应验证前标为“未验证”，API 拒绝工具请求时显示原因，不执行工具、不切换模型。
- `agent_task_run(view, state, request) -> Result<AgentTaskReceipt, String>` 启动一项单模型任务。
- `agent_task_resolve(view, state, task_id, approval_id, approved) -> Result<(), String>` 确认或拒绝待审阅文件修改/命令。
- `agent_task_cancel(view, state, task_id) -> Result<(), String>` 取消当前任务及待处理审批。
- 任务事件状态为 `running`、`approval_required`、`completed`、`failed`、`cancelled`；事件包含受界限的输出和可选审批内容。
- `agent_room_workspace.rs` 暴露一个只供本机任务使用的 API 调用函数；每次调用重新核对当前 provider 配置、凭据、付费开关、价格和每日上限。

- [ ] **Step 1: 为未知工具不执行、provider 错误不自动重试、命令结果导致后续正常模型往返、超出每任务往返上限及每日费用/调用上限编写测试**
- [ ] **Step 2: 为文件审批等待/拒绝、命令审批等待/拒绝、确认后才执行、取消后不执行编写测试**
- [ ] **Step 3: 设置固定 `CARGO_TARGET_DIR` 并运行相关 Rust 测试，确认新增测试失败；命令执行器和 API 客户端均用模拟实现**
- [ ] **Step 4: 实现 provider API 逐轮调用、只执行白名单工具名、每任务最多 10 次模型往返、单任务互斥及取消检查；以具体 provider + model 的工具调用响应判定支持情况，不支持时明确失败且不回退**
- [ ] **Step 5: 将文件写入和命令执行变为待确认事件；确认界面显示完整命令、目录、权限及命令输出将传给模型；命令使用 PowerShell 的无配置、非交互启动方式，设置选定目录为当前目录；完成后将退出码和有界输出回传模型继续任务，每个后续修改/命令仍单独审批**
- [ ] **Step 6: 让每个 API 往返沿用 Room 价格确认/预算预留/费用记账，不自动重试，并在失败、停止和达到上限时保存明确状态**
- [ ] **Step 7: 注册模型列表、启动、审批和取消命令；重跑相关 Rust 测试**

### Task 4: API 任务卡和审批交互

**Files:**
- Modify: `src/components/AgentTaskPanel.tsx`
- Modify: `src/components/AgentRoom.tsx`
- Modify: `src/services/agentTasks.ts`
- Modify: `src/agent-room.css`
- Modify: `tests/roomWorkspace.test.ts`
- Modify: `scripts/run-tests.mjs`（仅当新增测试文件时）

**Interfaces:**
- `AgentTaskPanel` 接收模型与工具调用验证状态（支持/未验证/不支持）、选定目录、任务状态、搜索/读取进度、待审阅修改/命令和命令结果，以及 `start`、`resolve`、`cancel`、`insertResult` 回调。审批界面明确提示命令输出会发送给当前模型。
- 前端 task service 只调用对应 Tauri 命令；浏览器预览模式不发起 API 调用。

- [ ] **Step 1: 编写 service/UI 测试，覆盖模型兼容状态、搜索与读取进度、文件/命令审批、命令输出传输提示、命令结果展示、停止和完成回复进入草稿**
- [ ] **Step 2: 运行对应 Node 测试确认新增的搜索进度、命令结果回传和任务循环用例失败**
- [ ] **Step 3: 更新任务卡为 API 模型选择，并增加搜索/读取进度、改动前后预览、命令确认、退出码/输出展示和拒绝/应用按钮**
- [ ] **Step 4: 接入启动/审批/取消服务，完成后仅把文本放入聊天草稿，不自动发送**
- [ ] **Step 5: 运行对应 Node 测试和 `npm.cmd run typecheck`**

### Task 5: 本地验证和真实 API 验收准备

**Files:** 无新增产品文件

- [ ] 设置 `$env:CARGO_TARGET_DIR='D:\win桌面\src-tauri\target'`，从项目根目录运行 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_room::workspace::tests`、`cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_local_tools::tests` 和 `cargo test --manifest-path src-tauri/Cargo.toml --offline --locked --lib agent_task::tests`；任务循环测试使用模拟 API 与模拟命令执行器，不访问真实服务或运行任意 shell 命令。
- [ ] 运行 `npm.cmd test` 与 `npm.cmd run typecheck`。
- [ ] 设置 `$env:CARGO_TARGET_DIR='D:\win桌面\src-tauri\target'` 后运行 `npm.cmd run tauri -- build --debug --no-bundle -- --offline --locked`，构建输出固定在 `D:\win桌面\src-tauri\target`。
- [ ] 在候选窗口检查任务卡搜索/读取、拒绝/批准文件改动、拒绝/批准命令、命令失败输出回传后的修正循环、停止与草稿回填；先使用模拟 API 响应和模拟命令执行器，不触发真实服务或任意 shell 命令。
- [ ] 检查工作树和构建新增占用；不合并、不推送、不运行真实 API 任务。
- 注：`agent_room_workspace.rs` 实际挂载为 `agent_room::workspace`，定向测试使用该模块路径。当前 `tests/updater_acceptance.rs` 的两个 `super::PUBLIC_KEY` 引用无法从集成测试 crate 根解析；本计划使用 `--lib` 运行定向 Rust 模块测试，不修改该无关文件。
