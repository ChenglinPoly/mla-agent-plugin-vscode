# 项目结构说明

## 目录结构

```
vscode_mla_plugin/
├── src/                           # 源代码目录
│   ├── extension.ts               # 扩展入口文件
│   ├── RuntimeManager.ts          # 运行时管理器
│   ├── Orchestrator.ts            # 上下文编排器
│   ├── ChatViewProvider.ts        # 聊天 UI 提供者
│   └── types.ts                   # 类型定义
├── out/                           # 编译输出目录（自动生成）
├── resources/                     # 资源文件
│   └── icon.svg                   # 扩展图标
├── .vscode/                       # VS Code 配置
│   ├── launch.json                # 调试配置
│   └── tasks.json                 # 任务配置
├── package.json                   # 扩展清单
├── tsconfig.json                  # TypeScript 配置
├── .eslintrc.json                 # ESLint 配置
├── .gitignore                     # Git 忽略规则
├── .vscodeignore                  # 打包忽略规则
├── README.md                      # 用户文档
├── TESTING.md                     # 测试指南
├── PROJECT_STRUCTURE.md           # 本文件
├── develop.md                     # 实施方案（参考）
└── QUICKSTART.md                  # MLA V3 快速入门（参考）
```

## 核心模块

### 1. extension.ts

**职责**：扩展生命周期管理

**功能**：
- 注册扩展激活/停用钩子
- 初始化核心组件（RuntimeManager, Orchestrator, ChatViewProvider）
- 注册命令（打开聊天、清除历史）
- 自动启动 mla-tool-server

**关键代码**：
```typescript
export function activate(context: vscode.ExtensionContext) {
  // 创建组件
  runtimeManager = new RuntimeManager(outputChannel);
  orchestrator = new Orchestrator(context, runtimeManager);
  chatViewProvider = new ChatViewProvider(...);
  
  // 注册 Webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mla.chatView', chatViewProvider)
  );
}
```

### 2. RuntimeManager.ts

**职责**：进程管理与 JSONL 解析

**功能**：
- 启动/停止 `mla-agent --jsonl` 进程
- 解析 JSONL 流（stdout）
- 状态机控制（IDLE → M_RUNNING → DONE/PAUSED/ERROR）
- 暂停（SIGINT）和续跑（相同参数重新调用）
- 提取最后 agent 行（暂停锚点）

**事件发射**：
- `onEvent`: 发射解析后的 JSONL 事件
- `onStateChange`: 发射状态变化

**关键方法**：
- `startAgent()`: 启动进程
- `pause()`: 软中断
- `resume()`: 续跑
- `extractLastAgentLine()`: 提取暂停锚点

### 3. Orchestrator.ts

**职责**：上下文编排与历史持久化

**功能**：
- 管理对话历史（user/assistant/tool_meta）
- 实现极简拼接策略（只保留关键信息）
- 持久化到 workspaceState（按工作区隔离）
- 构建 LLM 上下文（未来扩展）

**极简拼接策略**：
只保留 3 类信息到 `tool_meta`：
1. 调用参数：`agent_name` + `input`（≤512 字符）
2. 最终结果：`final_result_summary`（≤1024 字符）
3. 暂停锚点：`last_agent_line`（≤512 字符）

**关键方法**：
- `addUserMessage()`: 添加用户消息
- `addAssistantMessage()`: 添加助手消息
- `addToolMeta()`: 添加工具元数据（极简拼接）
- `buildContext()`: 构建上下文（未来用于 LLM 调用）

### 4. ChatViewProvider.ts

**职责**：Webview UI 渲染与交互

**功能**：
- 提供 HTML/CSS/JS 的聊天界面
- 渲染消息流（user/assistant）
- 渲染 JSONL 执行区块（可折叠）
- 处理用户交互（发送、暂停、继续、HIL 确认）
- 监听 RuntimeManager 事件，实时更新 UI

**消息流**：
```
User → ChatViewProvider → Orchestrator.addUserMessage()
                        → RuntimeManager.startAgent()
                        → JSONL 流 → 更新 UI
                        → 完成 → Orchestrator.addToolMeta()
                        → 助手收尾消息
```

**Webview 通信**：
- Extension → Webview: `postMessage({ type: 'message', message })`
- Webview → Extension: `onDidReceiveMessage({ type: 'send', text })`

### 5. types.ts

**职责**：TypeScript 类型定义

**核心类型**：
- `AgentState`: 状态机枚举
- `JSONLEvent`: JSONL 事件接口
- `ChatMessage`: 用户/助手消息
- `ToolMetaMessage`: 工具元数据（极简拼接）
- `JSONLBlock`: JSONL 执行区块
- `ConversationHistory`: 对话历史
- `RunSnapshot`: 运行快照（用于续跑）

## 数据流

### 发送消息流程

```
1. 用户输入 "test"
   ↓
2. Webview 发送 { type: 'send', text: 'test' }
   ↓
3. ChatViewProvider.handleSendMessage()
   ├─ Orchestrator.addUserMessage('test')
   │  └─ 保存到 history.messages
   ├─ 发送助手消息（首段）
   └─ callMLA()
      ↓
4. RuntimeManager.startAgent({ taskId, userInput: 'test' })
   ├─ 生成 callId
   ├─ spawn('mla-agent', ['--jsonl', ...])
   └─ 监听 stdout
      ↓
5. JSONL 事件流
   ├─ { type: 'token', text: '...' }
   ├─ { type: 'progress', pct: 50 }
   └─ { type: 'result', summary: '...' }
      ↓
6. ChatViewProvider.handleJSONLEvent()
   ├─ 添加到 currentJSONLBlock.events
   ├─ 发送到 Webview 渲染
   └─ 如果 type === 'result':
      └─ Orchestrator.addToolMeta(...)
         └─ 保存极简摘要
      ↓
7. { type: 'end' }
   ├─ 标记区块 status = 'completed'
   └─ 发送助手收尾消息
```

### 暂停与续跑

```
暂停:
1. 用户点击"暂停"
   ↓
2. RuntimeManager.pause()
   ├─ process.kill('SIGINT')
   └─ state = 'PAUSED'
      ↓
3. ChatViewProvider.handleStateChange('PAUSED')
   ├─ 提取 last_agent_line
   └─ Orchestrator.addToolMeta({ status: 'paused', lastAgentLine })

续跑:
1. 用户点击"继续"
   ↓
2. RuntimeManager.resume()
   ├─ 读取 currentSnapshot (task_id, input, agent_name)
   └─ startAgent(完全一致参数)
      ↓
3. 后端 mla-agent 自动检测并续跑
```

## 配置项

在 `package.json` > `contributes.configuration` 中定义：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `mla.autoStartToolServer` | boolean | `true` | 自动启动工具服务器 |
| `mla.defaultAgentName` | string | `"writing_agent"` | 默认 Agent |
| `mla.jsonl.defaultExpanded` | boolean | `true` | JSONL 区块默认展开 |
| `mla.history.maxMessages` | number | `200` | 最大历史消息数 |
| `mla.toolMeta.maxInputChars` | number | `512` | 上下文输入最大字符 |
| `mla.toolMeta.maxResultChars` | number | `1024` | 上下文结果最大字符 |

## 持久化

### workspaceState 存储

**位置**：VS Code 内部数据库（SQLite）

**Key 格式**：`mla.history.{workspaceHash}`

**内容**：
```typescript
{
  messages: [
    { role: 'user', content: '...', timestamp: ... },
    { role: 'assistant', content: '...', timestamp: ... },
    { role: 'tool_meta', agent_name: '...', input: '...', ... }
  ],
  lastState: 'DONE',
  runSnapshot: { task_id: '...', input: '...', ... },
  pendingHIL: []
}
```

### 为什么用 workspaceState？

- ✅ 按工作区自动隔离
- ✅ VS Code 原生支持
- ✅ 无需手动管理文件
- ✅ 自动跨平台兼容

## 状态机

```
IDLE
  ↓ User.Send
A_RUNNING (助手自然语言首段)
  ↓ Decide.CallMLA
M_RUNNING (MLA 执行中)
  ├─ User.Pause → PAUSED
  │                ↓ User.Resume
  │                M_RUNNING
  ├─ MLA.HIL → AWAIT_HIL
  │              ↓ User.Confirm
  │              M_RUNNING
  └─ MLA.Done → DONE
                  ↓ User.Send
                IDLE
```

## 错误处理

### mla-agent 未安装
- 检测：`spawn` 报 `ENOENT`
- 处理：显示友好提示 + "查看文档"按钮

### Tool Server 未运行
- 检测：`mla-tool-server status` 输出
- 处理：自动启动（如果 `autoStartToolServer = true`）

### JSONL 解析失败
- 检测：`JSON.parse()` 抛异常
- 处理：作为普通日志显示，不中断流程

### 进程异常退出
- 检测：`on('close')` 收到非 0 退出码
- 处理：state → ERROR，显示错误提示

## 未来扩展（M2-M4）

### M2: 暂停/继续完整实现
- [ ] UI 显示"续跑分割线"
- [ ] 验证后端续跑一致性
- [ ] Windows 兼容性测试

### M3: HIL 完整支持
- [ ] 多种 UI 类型（表单、文件选择、超时）
- [ ] HIL 待办持久化
- [ ] 超时倒计时显示

### M4: 体验优化
- [ ] 进度条渲染
- [ ] Artifact 点击打开文件
- [ ] Diff 查看
- [ ] 多 Agent 选择器（UI 下拉菜单）
- [ ] 虚拟列表（超长消息）
- [ ] 暗色/亮色主题适配

## 调试建议

1. **查看输出日志**：输出面板 > "MLA Chatbot"
2. **查看 Webview 控制台**：`Developer: Open Webview Developer Tools`
3. **断点调试**：在 VS Code 中直接打断点（需按 F5 启动调试）
4. **手动测试后端**：
   ```bash
   mla-agent --task_id ~/test --user_input "test" --jsonl 2>/dev/null
   ```

## 贡献指南

1. 遵循 TypeScript 严格模式
2. 保持代码风格一致（ESLint）
3. 添加必要的注释
4. 更新相关文档
5. 测试通过后再提交

