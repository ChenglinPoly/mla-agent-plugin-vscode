# MLA Chatbot - VS Code 扩展

VS Code 集成的 MLA Agent 聊天助手，提供 Cursor 式的交互体验。

## 功能特性

- 🤖 **智能对话**：与 MLA Agent 系统无缝集成
- 📊 **实时执行**：JSONL 流式显示执行过程
- ⏸️ **暂停/继续**：支持任务中断和续跑
- 🤝 **人机交互**：HIL（Human-in-Loop）自动识别和处理
- 💾 **历史持久化**：对话历史自动保存和恢复
- 🎯 **极简上下文**：智能裁剪，避免上下文膨胀

## 快速开始

### 前置要求

1. 已安装 [MLA V3](https://github.com/your-repo/MLA_V3)：
   ```bash
   cd /path/to/MLA_V3
   pip install -e .
   ```

2. 配置 API Key：
   ```bash
   mla-agent --config-set api_key "sk-your-api-key"
   ```

### 安装扩展

1. 在 VS Code 中打开扩展目录
2. 按 F5 运行扩展开发主机
3. 在新窗口中点击左侧活动栏的 MLA 图标

### 使用方法

1. **打开聊天面板**：点击左侧 MLA 图标
2. **发送消息**：在输入框输入任务，按回车或点击"发送"
3. **查看执行**：JSONL 执行区块实时显示进度
4. **暂停/继续**：点击对应按钮控制任务执行

## 配置项

在 VS Code 设置中搜索 "MLA" 可配置：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `mla.autoStartToolServer` | 自动启动 tool-server | `true` |
| `mla.defaultAgentName` | 默认 Agent 名称 | `writing_agent` |
| `mla.jsonl.defaultExpanded` | JSONL 区块默认展开 | `true` |
| `mla.history.maxMessages` | 最大历史消息数 | `200` |
| `mla.toolMeta.maxInputChars` | 上下文输入最大字符 | `512` |
| `mla.toolMeta.maxResultChars` | 上下文结果最大字符 | `1024` |

## 命令

- `MLA: 打开聊天面板` - 打开或聚焦聊天面板
- `MLA: 清除历史记录` - 清空当前工作区的对话历史

## 工作原理

### 流切换式编排

1. **A-Stream（自然语言首段）**：助手先输出初步回复
2. **M-Stream（JSONL 执行区块）**：调用 MLA Agent，实时显示执行过程
3. **A-Stream（收尾总结）**：执行完成后，助手给出总结和建议

### 极简上下文策略

只保留关键信息到上下文：
- 调用参数：`agent_name` + `input`
- 最终结果：`result.summary`
- 暂停锚点：`last_agent_line`（仅暂停时）

其他 JSONL 细节仅用于 UI 展示，不进入 LLM 上下文，避免上下文膨胀。

### 暂停与续跑

- **暂停**：发送 SIGINT 软中断，保存运行快照
- **继续**：用完全一致的参数重新调用 `mla-agent --jsonl`，后端自动续跑

## 常见问题

### Q: mla-agent 命令未找到

**A**: 请确保已安装 MLA V3：
```bash
cd /path/to/MLA_V3
pip install -e .
```

### Q: Tool Server 连接失败

**A**: 手动启动 tool-server：
```bash
mla-tool-server start
```

### Q: 历史记录在哪里？

**A**: 历史记录保存在 VS Code 的 `workspaceState` 中，按工作区隔离。清除历史可使用命令 `MLA: 清除历史记录`。

### Q: 如何使用不同的 Agent？

**A**: 当前版本使用配置项 `mla.defaultAgentName` 指定。未来版本将支持 UI 选择器。

## 开发

### 编译

```bash
npm install
npm run compile
```

### 调试

按 F5 启动扩展开发主机

### 构建

```bash
npm run vscode:prepublish
```

## 架构

```
┌─────────────────────────────────────────┐
│         ChatViewProvider (UI)           │
│  - Webview 渲染                         │
│  - 用户交互                             │
│  - JSONL 区块折叠                       │
└──────────────┬──────────────────────────┘
               │
┌──────────────┴──────────────────────────┐
│         Orchestrator (编排)              │
│  - 上下文极简拼接                       │
│  - 历史持久化                           │
│  - 决策是否调用 MLA                     │
└──────────────┬──────────────────────────┘
               │
┌──────────────┴──────────────────────────┐
│      RuntimeManager (运行时)             │
│  - 进程管理 (spawn/kill)                │
│  - JSONL 流解析                         │
│  - 状态机控制                           │
│  - 暂停/续跑                            │
└─────────────────────────────────────────┘
```

## 路线图

- [x] M1（MVP）：基础对话、JSONL 执行区块、历史持久化
- [ ] M2：暂停/继续完整实现
- [ ] M3：HIL 完整支持（表单、文件选择等）
- [ ] M4：进度条、artifact 点击、diff 查看、多 Agent 选择器

## 参考文档

- [MLA V3 快速入门](../../QUICKSTART.md)
- [实施方案](../../develop.md)

## 许可证

MIT

