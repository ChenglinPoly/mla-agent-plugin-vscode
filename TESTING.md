# MLA Chatbot 测试指南

## 环境准备

### 1. 确保 MLA V3 已安装

```bash
# 检查安装
mla-agent --config-show

# 如未安装
cd /path/to/MLA_V3
pip install -e .
mla-agent --config-set api_key "sk-your-api-key"
```

### 2. 启动 Tool Server

```bash
mla-tool-server start

# 验证
mla-tool-server status
# 应显示: ✅ Tool Server 运行中
```

### 3. 安装扩展依赖

```bash
cd /Users/chenglin/Desktop/research/agent_framwork/vscode_version/vscode_mla_plugin
npm install
```

## 启动调试

### 方法一：VS Code 内调试（推荐）

1. 在 VS Code 中打开本项目目录
2. 按 `F5` 或点击"运行 > 启动调试"
3. 新窗口会打开"扩展开发主机"
4. 在新窗口中打开任意工作区（如 `~/test_project`）
5. 点击左侧活动栏的 **MLA** 图标

### 方法二：编译后测试

```bash
npm run compile
code --extensionDevelopmentPath=$(pwd)
```

## 测试用例

### ✅ 测试 1：基础对话

**步骤**：
1. 打开聊天面板
2. 输入：`查看当前目录有什么文件`
3. 点击"发送"

**预期结果**：
- 显示用户消息
- 显示助手消息："正在处理您的请求..."
- 出现 JSONL 执行区块（默认展开）
- 区块标题显示：`🔧 执行: writing_agent`
- 状态徽章显示：`运行中` → `已完成`
- 区块内实时显示 token 流
- 完成后显示：`✅ 任务已完成`

### ✅ 测试 2：JSONL 区块折叠

**步骤**：
1. 完成测试 1
2. 点击 JSONL 区块标题

**预期结果**：
- 区块内容折叠/展开切换
- 状态徽章保持可见

### ✅ 测试 3：历史持久化

**步骤**：
1. 发送 2-3 条消息
2. 关闭扩展开发主机
3. 重新按 F5 启动
4. 打开同一工作区
5. 点击 MLA 图标

**预期结果**：
- 历史消息完整显示
- JSONL 区块保留（但不会重新执行）

### ✅ 测试 4：清除历史

**步骤**：
1. 发送若干消息
2. 按 `Cmd+Shift+P` (Mac) 或 `Ctrl+Shift+P` (Windows)
3. 输入：`MLA: 清除历史记录`
4. 确认

**预期结果**：
- 聊天面板清空
- 显示提示：`历史记录已清除`

### ✅ 测试 5：不同工作区隔离

**步骤**：
1. 在工作区 A 发送消息
2. 切换到工作区 B
3. 打开 MLA 聊天面板

**预期结果**：
- 工作区 B 的聊天面板为空（或显示 B 的历史）
- 工作区 A 的历史不会出现在 B

### ✅ 测试 6：Tool Server 自动启动

**步骤**：
1. 停止 Tool Server：`mla-tool-server stop`
2. 重启扩展（关闭开发主机，再按 F5）
3. 查看"输出"面板 > "MLA Chatbot"

**预期结果**：
- 输出显示：`[Tool Server] 未运行，尝试启动...`
- 2 秒后显示：`[Tool Server] 启动完成`
- 弹出提示：`MLA Tool Server 已启动`

### ✅ 测试 7：错误处理 - mla-agent 未安装

**步骤**：
1. 临时重命名 mla-agent（模拟未安装）：
   ```bash
   mv $(which mla-agent) $(which mla-agent).bak
   ```
2. 发送消息

**预期结果**：
- 显示错误提示：`mla-agent 命令未找到，请确保已安装 MLA V3`
- 提供"查看文档"按钮

**恢复**：
```bash
mv $(which mla-agent).bak $(which mla-agent)
```

### ✅ 测试 8：配置项生效

**步骤**：
1. 打开 VS Code 设置（`Cmd+,` 或 `Ctrl+,`）
2. 搜索 `mla`
3. 修改 `mla.defaultAgentName` 为 `coder_agent`
4. 发送消息

**预期结果**：
- JSONL 区块标题显示：`🔧 执行: coder_agent`
- 调用对应的 Agent

### ✅ 测试 9：长时间任务

**步骤**：
1. 发送复杂任务：`写一篇关于 Transformer 的论文大纲`
2. 观察执行过程

**预期结果**：
- token 流持续输出
- 进度事件显示（如有）
- UI 不卡顿
- 滚动条自动跟随到底部

### ⏸️ 测试 10：暂停/继续（未来版本）

**步骤**：
1. 发送长时间任务
2. 点击"暂停"按钮
3. 等待 2 秒
4. 点击"继续"按钮

**预期结果**：
- 暂停后，JSONL 区块状态变为 `已暂停`
- 进程收到 SIGINT
- 继续后，用相同参数重新调用 mla-agent
- 任务从断点续跑

### 🤝 测试 11：HIL（Human-in-Loop）

**步骤**：
1. 发送：`请求用户先阅读完项目内的文件再继续`
2. 等待 HIL 触发

**预期结果**：
- JSONL 区块显示 `human_in_loop` 事件
- 弹出对话框，显示指令
- 提供"确认"和"取消"按钮
- 点击确认后，任务继续执行

## 调试技巧

### 查看输出日志

1. 打开"输出"面板：`Cmd+Shift+U` (Mac) 或 `Ctrl+Shift+U` (Windows)
2. 下拉选择：`MLA Chatbot`
3. 查看详细日志：
   - `[RuntimeManager]` - 进程管理日志
   - `[State]` - 状态机变化
   - `[Tool Server]` - 工具服务器状态
   - `[JSONL 解析失败]` - 无法解析的行

### 查看 Webview 控制台

1. 在扩展开发主机中
2. 按 `Cmd+Shift+P` > `Developer: Open Webview Developer Tools`
3. 查看 Console 中的 JavaScript 日志

### 检查持久化数据

```bash
# 注意：workspaceState 存储在 VS Code 内部数据库中，无法直接查看
# 可通过代码添加日志：
# console.log(context.workspaceState.get('mla.history.xxxxx'));
```

## 性能测试

### 1. 大量历史消息

```bash
# 发送 50+ 条消息，观察：
# - 加载速度
# - UI 滚动流畅度
# - 内存占用
```

### 2. 超长 JSONL 流

```bash
# 发送会产生大量输出的任务
# 观察：
# - 渲染是否节流
# - 是否有丢失事件
# - CPU 占用
```

## 故障排除

### 问题：消息发送后无反应

**检查**：
1. 输出面板是否有错误
2. mla-agent 是否可执行：`which mla-agent`
3. Tool Server 是否运行：`mla-tool-server status`

### 问题：JSONL 区块无内容

**检查**：
1. 是否使用 `--jsonl` 参数（代码中已添加）
2. 查看输出面板的 stderr 日志
3. 手动测试：`mla-agent --task_id ~/test --user_input "test" --jsonl`

### 问题：历史记录丢失

**检查**：
1. 是否在同一工作区
2. 是否调用了"清除历史记录"
3. workspaceState 是否正常（检查 VS Code 版本）

### 问题：扩展无法激活

**检查**：
1. `package.json` 中的 `activationEvents`
2. TypeScript 编译是否成功：`npm run compile`
3. VS Code 版本是否 >= 1.80.0

## 下一步测试（M2-M4）

- [ ] 暂停/继续完整流程
- [ ] HIL 多种 UI 类型（表单、文件选择等）
- [ ] 进度条渲染
- [ ] Artifact 点击打开文件
- [ ] Diff 查看
- [ ] 多 Agent 选择器
- [ ] 虚拟列表（超长消息）

## 自动化测试（未来）

```typescript
// 示例：单元测试框架
import * as assert from 'assert';
import { Orchestrator } from '../Orchestrator';

suite('Orchestrator Test Suite', () => {
  test('truncate should limit length', () => {
    const text = 'a'.repeat(1000);
    const result = orchestrator.truncate(text, 512);
    assert.equal(result.length, 515); // 512 + '...'
  });
});
```

## 反馈

测试中发现问题，请记录：
- 复现步骤
- 预期结果
- 实际结果
- 日志截图

