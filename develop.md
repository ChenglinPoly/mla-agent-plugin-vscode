下面是一份**端到端的整体实施方案**（给开发者的实现文档；不含具体代码），满足你最新的上下文策略与交互期望（Cursor 式体验 + 极简上下文拼接）。

---

# MLA × VS Code Chatbot 集成：整体实施方案

## 0. 目标与范围

**目标**

* 在 VS Code 中提供一个**聊天面板（Chatbot）**，以“Cursor 式流切换”体验与 **MLA V3** 后端协作。
* Chatbot 维护自己的对话与提示词，**按需**调用 `mla-agent`（固定 `task_id = 工作区根路径`）。
* UI 中**连续一条 assistant 消息**内：先输出 Chatbot 自己的自然语言，再插入**可折叠**的 JSONL 执行区块（来自 `mla-agent --jsonl`），待执行完毕后拼接总结文本继续输出。
* 支持 **发送 / 暂停 / 继续**；暂停/继续要联动后端（中断/续跑）。
* 支持 **Human-in-the-Loop（HIL）**：自动识别、弹窗确认、调用 HIL 确认服务后继续。
* **上下文极简拼接策略**（关键）：仅把

  1. 本次 MLA 调用的 `agent_name` 与 `input`，
  2. JSONL 的最终 `result.summary`，
  3. 若中途暂停/中断，则**当时 JSONL 内**“最后一条以 `[调用的agent_name]` 开头的消息”

  三者拼接进入 Chatbot 的**语义上下文**。其它 JSONL 细节仅用于 UI 展示，不进入上下文。

**范围**

* VS Code 插件（前端编排器、状态机、持久化、UI）
* 与已有后端（`mla-tool-server` / `mla-agent --jsonl` / HIL confirm）对接
* 不改动后端协议前提下完成编排；若后端增加事件类型更佳，但非必要

---

## 1. 总体架构

```
┌──────────────── VS Code Extension (Node/TS) ────────────────┐
│  ┌──────────────┐    ┌─────────────────┐    ┌───────────┐  │
│  │ Webview Chat │←→  │ Orchestrator    │←→  │ Runtime    │  │
│  │ (UI层)       │    │ (决策/上下文)    │    │ Manager    │  │
│  └──────────────┘    └─────────────────┘    └───────────┘  │
│         ↑                         ↑                 ↑       │
│         │                         │                 │       │
│         │ JSONL 渲染/折叠          │ 上下文极简拼接      │ 进程管控  │
│         │ HIL 弹窗/确认           │ 历史持久化         │ 暂停/继续 │
└─────────┼─────────────────────────┼─────────────────┼───────┘
          │                         │                 │
          ▼                         ▼                 ▼
         用户                    本地存储           后端进程
                                                  (mla-agent, mla-tool-server)
```

* **Webview Chat**：聊天 UI（消息流、JSONL 区块、按钮、HIL 对话框）
* **Orchestrator**：会话编排（是否调用 MLA 的决策；上下文裁剪；极简拼接）
* **Runtime Manager**：进程与状态机（spawn/中断/续跑、JSONL 解析、HIL 调用、日志）

---

## 2. 关键流程（Cursor 式流切换）

1. 用户点击**发送** → Orchestrator 追加一条 `user` 消息；
2. Chatbot 立即进入 **A-Stream**（助手自然语言首段），状态 `A_RUNNING`；
3. Orchestrator 判断**需要调用 MLA** →

   * 切换：`A_RUNNING → A_PAUSING → M_RUNNING`；
   * 在同一条 assistant 消息里插入**执行区块**（M-Stream 容器，默认展开）；
   * Runtime Manager 启动 `mla-agent --jsonl`（`task_id = workspaceRoot`，`agent_name`可选，`input = user_input`）。
4. 运行期间：JSONL 流**仅渲染到执行区块**（token/progress/artifact/HIL）；
5. **HIL**：出现 `human_in_loop` → Webview 弹窗；用户确认 → Runtime 调用 HIL 确认服务 → 继续流；
6. MLA 结束 → `M_COMPLETE`：

   * Runtime 产出 `final result.summary`；
   * Orchestrator 执行**极简拼接**（见 §4）；
   * Chatbot **A-Stream 恢复**，在同一条 assistant 消息尾部给出**总结/下一步建议**；
7. 完成 → 写入**历史持久化**（仅保存 user/assistant/tool_meta-简要）。

> 暂停/继续见 §5。

---

## 3. 状态机

**主状态**

* `IDLE`：待输入
* `A_RUNNING`：助手自然语言生成中
* `M_RUNNING`：MLA 执行中
* `AWAIT_HIL`：等待人机确认
* `PAUSED`：已暂停（A/M 均停）
* `DONE`：本轮完成
* `CANCELLED` / `ERROR`：终止或异常

**事件**

* `User.Send`：`IDLE → A_RUNNING`
* `Decide.CallMLA`：`A_RUNNING → A_PAUSING → M_RUNNING`
* `MLA.HIL`：`M_RUNNING → AWAIT_HIL → (Confirm) → M_RUNNING`
* `User.Pause`：`A_RUNNING|M_RUNNING → PAUSED`
* `User.Resume`：

  * 若停在 M：**同参续跑** → `M_RUNNING`
  * 若停在 A：恢复采样 → `A_RUNNING`
* `MLA.Done`：`M_RUNNING → DONE`
* `Error/Cancel`：`→ ERROR/CANCELLED`

---

## 4. **上下文极简拼接策略**（必须遵守）

**只拼接**以下三类小块到 Chatbot 语义上下文（tool_meta）：

1. **调用参数**（在触发 MLA 时立即记录）

   * `agent_name`
   * `input`（清洗/截断 ≤ 512 字符）
   * `call_id`（仅用于调试/对齐）

2. **最终结果**（MLA 正常结束时）

   * `final_result_summary`（来自 JSONL `result.summary`；清洗/截断 ≤ 512~1024 字符）

3. **暂停时的锚点**（若中途暂停/中断）

   * `last_agent_line`：在已收 JSONL 中，**最后一条以 `[agent_name]` 开头**的文本行（若无则为空）；清洗/截断 ≤ 256~512 字符
   * `status`: `"paused"` / `"interrupted"`

> **不**进入上下文：所有 token/progress/artifact 细粒度内容、完整 JSONL 文本。
> UI 仍完整渲染 JSONL（可折叠），但不喂给 LLM 上下文。

**持久化记录格式（建议）**

```json
{
  "role": "tool_meta",
  "agent_name": "writing_agent",
  "input": "用户输入的结构化/清洗版（≤512）",
  "call_id": "c-20251020-xxxx",
  "final_result_summary": "…（≤1024）",
  "last_agent_line": "…（暂停时记录；≤512）",
  "status": "ok|paused|interrupted|error",
  "ts": 1739999999999
}
```

---

## 5. 暂停 / 继续（与后端续跑对齐）

**暂停**

* UI 点击“暂停” → Orchestrator 发出 `User.Pause`：

  * 若 `M_RUNNING`：Runtime 首选**软中断**（`SIGINT` / Windows 用兼容方式）；
  * 若 `A_RUNNING`：停止采样；
  * 解析至今的 JSONL 中抽取 `last_agent_line` 并写入当前 tool_meta；
  * 状态 → `PAUSED`，执行区块在 UI 冻结显示“已暂停”。

**继续**

* UI 点击“继续”（不允许输入新消息）：

  * 若上次停在 M：Runtime 用**完全一致参数**再次 `spawn mla-agent --jsonl`（`task_id`、`input`、`agent_name` 均一致）→ 后端自动**续跑**。
  * 若上次停在 A：恢复 Chatbot 采样继续输出。
  * 状态回到 `M_RUNNING` 或 `A_RUNNING`。
* 执行区块内增加“续跑分割线”，便于回看。

**新消息**

* 若用户在暂停后或任务完成后输入新消息，Orchestrator：

  * 若仍有执行：**显式终止**当前 MLA（提示确认），
  * 以**前序极简摘要 + 对话历史**作为上下文，开启新一轮。

---

## 6. HIL（Human-in-the-Loop）

**识别**

* JSONL 中的 `human_in_loop` 事件：包含 `hil_id`、`title/message`、`ui`（confirm/form/select/file_pick 等）、`timeout_sec`。

**交互**

* Webview 弹出 HIL 卡片：展示说明与对应控件（确认按钮/表单…），显示倒计时。
* 用户提交 → Runtime 调用 HIL 确认服务（推荐 CLI：`mla-agent confirm <hil_id> --result ...`；或 HTTP API）。
* 成功 → 执行区块标记“已完成”，状态 `AWAIT_HIL → M_RUNNING`；JSONL 继续。

**持久化**

* HIL 待办（未完成的 hil_id 与表单数据草稿）记录到工作区存储，插件重启可恢复显示。

---

## 7. JSONL 渲染与折叠

**区块容器**

* 插入同一条 assistant 消息中的独立“执行区块”；默认**展开**，可折叠/展开；
* 结束后保留区块，显示总耗时；展示“查看详情”按钮。

**事件映射**

* `token`：追加文本（节流 50–200ms 合并渲染）
* `progress`：进度条（阶段名 + 百分比）
* `artifact`：产物列表（点击打开文件 / diff）
* `notice/warn/error`：高亮行
* `human_in_loop`：嵌入卡片（确认/表单等）
* `result`：收尾小结（也会被 Orchestrator 摘要，进入上下文）

**错误行**

* 无法 `JSON.parse` 的行 → 作为普通日志行显示，不影响主流程。

---

## 8. 历史与持久化

**存储内容（工作区作用域）**

* 最近 N 条对话：`user` / `assistant` 文本
* `tool_meta` 极简摘要（见 §4）
* 未完成 HIL 待办
* 运行参数快照（用于继续）：`task_id`、`agent_name`、`input`、`call_id`

**位置**

* 建议 `.vscode/mla_chat/state.json`（或 `workspaceState`）+ 可选归档目录
* 提示在项目 `.gitignore` 中忽略（或暴露设置让用户决定是否提交）

**恢复**

* 打开同一工作区：立即加载历史并渲染；若上次是 `PAUSED` 或有 HIL 待办，显示可恢复控件。

---

## 9. 配置项（示例）

* `mla.autoStartToolServer`: bool（默认 `true`）
* `mla.defaultAgentName`: string（默认 `writing_agent`）
* `mla.jsonl.defaultExpanded`: bool（默认 `true`）
* `mla.history.maxMessages`: number（默认 200）
* `mla.toolMeta.maxInputChars`: number（默认 512）
* `mla.toolMeta.maxResultChars`: number（默认 1024）
* `mla.pause.strategy`: `'soft' | 'hard' | 'auto'`（默认 `auto`）
* `mla.hil.resolve`: `'cli' | 'http'`（默认 `cli`）

---

## 10. 健壮性与安全

**健壮性**

* `mla-agent` 不存在/不可执行 → 友好提示安装（参考你的“快速上手”文档）。
* `mla-tool-server` 未运行 → 自动拉起并提示状态。
* JSON 损坏行 → 作为日志显示；错误率高时提示“未启用 --jsonl？”。
* 暂停软中断在 Windows 不可靠时 → 回退强杀；仍可基于同参续跑。
* 超长输出 → 渲染节流与虚拟列表（必要时）。

**安全**

* 文件修改由后端承担；插件仅传 `task_id = workspaceRoot`。
* HIL HTTP 仅在 `localhost`；可加一次性 token（可选）。
* 历史默认本地存储；敏感信息字段不入库（或脱敏）。

---

## 11. 测试计划（要点）

* **流程**：发送→A-Stream→CallMLA→M-Stream→HIL→继续→result→收尾
* **暂停/继续**：A 与 M 两种场景；参数一致续跑验证
* **HIL**：多种 `ui.type`；超时，重复确认幂等
* **恢复**：插件重启、VS Code 重启后恢复对话、未完成 HIL 与 “可继续”
* **跨平台**：Windows 的中断/续跑、路径与编码
* **性能**：长时间 JSONL、高频 progress、超大 token 流
* **上下文**：确保仅拼接三类极简摘要；历史不膨胀

---

## 12. 里程碑拆解

**M1（MVP）**

* Chat UI、发送按钮、A-Stream 首段
* 启动 tool-server（按需）
* 调用 `mla-agent --jsonl`、执行区块（默认展开）、结束后助手收尾
* 历史基本持久化（user/assistant/tool_meta）

**M2（控制与恢复）**

* 暂停/继续（软中断/续跑）
* 参数快照、续跑分割线
* 上下文极简拼接全落地（agent_name/input/result/last_agent_line）

**M3（HIL）**

* `human_in_loop` 识别、弹窗与确认
* `cli` confirm 与 `http` confirm 二选一
* HIL 待办持久化与恢复

**M4（体验与健壮化）**

* 进度条、artifact 列表点击、diff 打开
* 错误处理、日志面板、渲染节流与虚拟列表
* 配置项与多代理选择器、默认代理记忆

---

## 13. 开发提示

* **一致性是王道**：暂停前务必记录**运行参数快照**；继续一定用**完全一致**参数调用，确保后端续跑。
* **锚点提取**：暂停时要从 JSONL 的已收文本中找到**最后一条以 `[agent_name]` 开头的行**；没有则留空。
* **截断策略**：`input`/`final_result_summary`/`last_agent_line` 清洗与截断，避免上下文膨胀。
* **同一条 assistant 消息**里完成“三段式”：A-Stream（首段）→ M-Stream（执行区块）→ A-Stream（收尾）。
* **并发**：同一时间仅允许 1 个活跃 MLA 任务；新消息需用户确认中断老任务。

---

### TL;DR

* 采用**流切换式编排**：Chatbot 先说话 → 切入 MLA 执行区块（JSONL）→ 结束后继续说完。
* **上下文只拼接三类信息**：`agent_name + input`、`final result.summary`、（暂停时）`last_agent_line`。
* 支持**暂停/继续（续跑）**与**HIL**；历史在工作区持久化，打开即恢复。
* 架构清晰、耦合度低、实现路径直给，体验贴近 Cursor。

如果你希望，我可以把这份方案拆成 20~30 条具体开发任务（含验收标准），或补一页**JSONL 事件到 UI 组件的映射表**与**错误码/提示语规范**，方便多人并行开发。
