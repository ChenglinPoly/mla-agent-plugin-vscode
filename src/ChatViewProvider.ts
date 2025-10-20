import * as vscode from 'vscode';
import { RuntimeManager } from './RuntimeManager';
import { Orchestrator } from './Orchestrator';
import { LLMService } from './LLMService';
import { JSONLEvent, JSONLBlock, AgentState, ChatMessage } from './types';

/**
 * Chat Webview Provider
 * 提供聊天 UI
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentJSONLBlock?: JSONLBlock;
  private currentAssistantMessage: string = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runtime: RuntimeManager,
    private readonly orchestrator: Orchestrator,
    private readonly llm: LLMService
  ) {
    // 监听 JSONL 事件
    this.runtime.onEvent(event => this.handleJSONLEvent(event));
    
    // 监听状态变化
    this.runtime.onStateChange(state => this.handleStateChange(state));
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // 处理来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'send':
          await this.handleSendMessage(message.text);
          break;
        case 'pause':
          this.runtime.pause();
          break;
        case 'resume':
          await this.runtime.resume();
          break;
        case 'stop':
          this.runtime.stop();
          break;
        case 'confirmHIL':
          await this.confirmHIL(message.hilId, message.result);
          break;
        case 'toggleJSONL':
          this.toggleJSONLBlock(message.callId);
          break;
        case 'ready':
          // Webview 加载完成，发送历史消息
          this.sendHistoryToView();
          break;
      }
    });
  }

  /**
   * 处理发送消息
   */
  private async handleSendMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('请先打开一个工作区');
      return;
    }

    // 1. 添加用户消息
    const userMsg = this.orchestrator.addUserMessage(text);
    this.sendMessageToView(userMsg);

    // 2. 调用 LLM 生成回复（流式）
    this.currentAssistantMessage = '';
    const assistantMsgId = Date.now();
    
    // 先发送一个空的助手消息占位
    this.sendToView({
      type: 'assistantStart',
      id: assistantMsgId
    });

    // 构建上下文
    const context = this.orchestrator.buildContext();
    
    let fullResponse = '';
    let displayedResponse = ''; // 用于实时显示的内容
    
    try {
      for await (const chunk of this.llm.chat(context)) {
        fullResponse += chunk;
        
        // 尝试提前解析（检测是否已经有完整的 JSON）
        const tempParsed = this.llm.parseResponse(fullResponse);
        
        if (tempParsed.shouldCallMLA) {
          // 如果检测到 CALL_MLA，只显示 response 部分
          displayedResponse = tempParsed.displayText;
        } else {
          // 否则显示完整内容
          displayedResponse = fullResponse;
        }
        
        // 流式更新助手消息
        this.sendToView({
          type: 'assistantChunk',
          id: assistantMsgId,
          content: displayedResponse
        });
      }

      // 最终解析响应
      const parsed = this.llm.parseResponse(fullResponse);
      
      // 保存助手消息到历史（只保存用户可见的文本）
      this.orchestrator.addAssistantMessage(parsed.displayText);
      
      // 最终更新显示（确保显示的是 displayText）
      this.sendToView({
        type: 'assistantChunk',
        id: assistantMsgId,
        content: parsed.displayText
      });

      // 判断是否需要调用 MLA
      if (parsed.shouldCallMLA && parsed.agentName && parsed.refinedInput) {
        await this.callMLAWithParams(
          workspaceFolder.uri.fsPath,
          parsed.agentName,
          parsed.refinedInput
        );
      }

    } catch (error: any) {
      this.sendToView({
        type: 'assistantChunk',
        id: assistantMsgId,
        content: `⚠️ 错误: ${error.message}`
      });
    }
  }

  /**
   * 调用 MLA Agent（带参数）
   */
  private async callMLAWithParams(
    taskId: string, 
    agentName: string, 
    userInput: string
  ): Promise<void> {
    const callId = `c-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // 创建 JSONL 区块
    this.currentJSONLBlock = this.orchestrator.createJSONLBlock(agentName, callId);
    
    // 发送区块到 UI
    this.sendToView({
      type: 'jsonlBlock',
      block: this.currentJSONLBlock
    });

    try {
      // 启动 Agent
      await this.runtime.startAgent({
        taskId,
        userInput,
        agentName
      });

      // 保存快照
      this.orchestrator.saveRunSnapshot(this.runtime.getSnapshot());

    } catch (error: any) {
      vscode.window.showErrorMessage(`启动 Agent 失败: ${error.message}`);
      
      if (this.currentJSONLBlock) {
        this.currentJSONLBlock.status = 'error';
        this.updateJSONLBlock();
      }
    }
  }

  /**
   * 处理 JSONL 事件
   */
  private handleJSONLEvent(event: JSONLEvent): void {
    if (!this.currentJSONLBlock) return;

    // 添加事件到区块
    this.currentJSONLBlock.events.push(event);

    // 发送到 UI
    this.sendToView({
      type: 'jsonlEvent',
      callId: this.currentJSONLBlock.call_id,
      event
    });

    // 处理特殊事件
    if (event.type === 'result') {
      // 提取 final result
      const summary = event.summary || event.text || '';
      
      console.log('[ChatViewProvider] 收到 result 事件，summary:', summary);
      
      // 添加 tool_meta
      const lastUserMsg = this.orchestrator.getHistory().messages
        .filter(m => m.role === 'user')
        .pop();
      
      this.orchestrator.addToolMeta({
        agentName: this.currentJSONLBlock.agent_name,
        input: (lastUserMsg && 'content' in lastUserMsg) ? lastUserMsg.content : '',
        callId: this.currentJSONLBlock.call_id,
        finalResultSummary: summary,
        status: 'ok'
      });

      // 🔄 将结果反馈给 Chatbot，让它决定是否继续
      console.log('[ChatViewProvider] 调用 continueWithResult');
      this.continueWithResult(summary).catch(err => {
        console.error('[ChatViewProvider] continueWithResult 失败:', err);
      });
    } else if (event.type === 'end') {
      // 结束当前 agent
      this.currentJSONLBlock.status = 'completed';
      this.currentJSONLBlock.endTime = Date.now();
      this.updateJSONLBlock();
    } else if (event.type === 'human_in_loop') {
      // HIL
      this.showHILDialog(event);
    }
  }

  /**
   * 将 MLA 结果反馈给 Chatbot，决定是否继续
   */
  private async continueWithResult(result: string): Promise<void> {
    console.log('[continueWithResult] 开始，result:', result);
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.log('[continueWithResult] 无工作区，退出');
      return;
    }

    // 添加系统消息到上下文（告知 Chatbot MLA 执行结果）
    const systemFeedback = `[系统反馈] MLA Agent 执行完成。结果摘要：${result}`;
    
    console.log('[continueWithResult] 创建助手消息');
    
    // 调用 LLM，让它基于结果决定下一步
    const assistantMsgId = Date.now();
    this.sendToView({
      type: 'assistantStart',
      id: assistantMsgId
    });

    // 构建上下文（包含最新的 tool_meta 结果）
    const context = this.orchestrator.buildContext();
    
    console.log('[continueWithResult] 上下文长度:', context.length);
    
    // 添加系统反馈
    context.push({
      role: 'user',  // 改为 user，更符合对话流
      content: systemFeedback
    });

    let fullResponse = '';
    let displayedResponse = '';
    let chunkCount = 0;
    
    try {
      console.log('[continueWithResult] 开始调用 LLM');
      
      for await (const chunk of this.llm.chat(context)) {
        fullResponse += chunk;
        chunkCount++;
        
        // 尝试提前解析
        const tempParsed = this.llm.parseResponse(fullResponse);
        displayedResponse = tempParsed.shouldCallMLA ? tempParsed.displayText : fullResponse;
        
        console.log(`[continueWithResult] 收到 chunk ${chunkCount}, 累计长度: ${fullResponse.length}`);
        
        this.sendToView({
          type: 'assistantChunk',
          id: assistantMsgId,
          content: displayedResponse
        });
      }

      console.log(`[continueWithResult] LLM 响应完成，总共 ${chunkCount} 个 chunks，长度: ${fullResponse.length}`);
      console.log(`[continueWithResult] 完整响应: ${fullResponse}`);

      // 解析响应
      const parsed = this.llm.parseResponse(fullResponse);
      
      console.log('[continueWithResult] 解析结果 shouldCallMLA:', parsed.shouldCallMLA);
      console.log('[continueWithResult] 解析结果 displayText:', parsed.displayText);
      
      // 保存助手消息
      this.orchestrator.addAssistantMessage(parsed.displayText);
      
      // 最终更新显示（确保显示完整内容）
      this.sendToView({
        type: 'assistantChunk',
        id: assistantMsgId,
        content: parsed.displayText
      });
      
      console.log('[continueWithResult] 已发送最终显示');

      // 判断是否需要继续调用下一个 agent
      if (parsed.shouldCallMLA && parsed.agentName && parsed.refinedInput) {
        console.log('[continueWithResult] 继续调用下一个 agent:', parsed.agentName);
        await this.callMLAWithParams(
          workspaceFolder.uri.fsPath,
          parsed.agentName,
          parsed.refinedInput
        );
      } else {
        console.log('[continueWithResult] 任务完成，不再调用');
      }
    } catch (error: any) {
      console.error('[continueWithResult] 错误:', error);
      this.sendToView({
        type: 'assistantChunk',
        id: assistantMsgId,
        content: `⚠️ 错误: ${error.message}`
      });
    }
  }

  /**
   * 处理状态变化
   */
  private handleStateChange(state: AgentState): void {
    this.orchestrator.updateLastState(state);
    
    if (state === 'PAUSED' && this.currentJSONLBlock) {
      this.currentJSONLBlock.status = 'paused';
      
      // 提取最后 agent 行
      const lastLine = this.runtime.extractLastAgentLine(
        this.currentJSONLBlock.agent_name,
        this.currentJSONLBlock.events
      );

      // 添加 tool_meta（暂停状态）
      const lastUserMsg = this.orchestrator.getHistory().messages
        .filter(m => m.role === 'user')
        .pop();
      
      this.orchestrator.addToolMeta({
        agentName: this.currentJSONLBlock.agent_name,
        input: (lastUserMsg && 'content' in lastUserMsg) ? lastUserMsg.content : '',
        callId: this.currentJSONLBlock.call_id,
        lastAgentLine: lastLine,
        status: 'paused'
      });

      this.updateJSONLBlock();
    }
  }

  /**
   * 显示 HIL 对话框
   */
  private async showHILDialog(event: JSONLEvent): Promise<void> {
    const hilId = event.hil_id || 'unknown';
    const instruction = event.instruction || '请确认';

    const result = await vscode.window.showInformationMessage(
      `🤝 ${instruction}`,
      '确认',
      '取消'
    );

    const userResult = result === '确认' ? '用户已确认' : '用户取消';
    await this.confirmHIL(hilId, userResult);
  }

  /**
   * 确认 HIL
   */
  private async confirmHIL(hilId: string, result: string): Promise<void> {
    const terminal = vscode.window.createTerminal({
      name: 'MLA HIL',
      hideFromUser: true
    });
    
    terminal.sendText(`mla-agent confirm ${hilId} --result "${result}"`);
    terminal.dispose();
  }

  /**
   * 切换 JSONL 区块展开/折叠
   */
  private toggleJSONLBlock(callId: string): void {
    if (this.currentJSONLBlock?.call_id === callId) {
      this.currentJSONLBlock.expanded = !this.currentJSONLBlock.expanded;
      this.updateJSONLBlock();
    }
  }

  /**
   * 更新 JSONL 区块
   */
  private updateJSONLBlock(): void {
    if (this.currentJSONLBlock) {
      this.sendToView({
        type: 'updateJSONLBlock',
        block: this.currentJSONLBlock
      });
    }
  }

  /**
   * 发送历史消息到 View
   */
  private sendHistoryToView(): void {
    const history = this.orchestrator.getHistory();
    
    // 构建显示消息列表（包含 tool_meta 的可视化）
    const displayMessages: any[] = [];
    
    for (let i = 0; i < history.messages.length; i++) {
      const msg = history.messages[i];
      
      if (msg.role === 'user' || msg.role === 'assistant') {
        displayMessages.push(msg);
      } else if (msg.role === 'tool_meta') {
        // 将 tool_meta 转换为可视化的 JSONL 区块摘要
        const meta = msg as any;
        const summaryBlock = {
          call_id: meta.call_id,
          agent_name: meta.agent_name,
          status: 'completed',
          summary: meta.final_result_summary || meta.last_agent_line || '执行完成',
          startTime: meta.timestamp,
          endTime: meta.timestamp,
          expanded: false
        };
        
        displayMessages.push({
          role: 'tool_meta_display',
          content: summaryBlock
        });
      }
    }
    
    this.sendToView({
      type: 'history',
      messages: displayMessages
    });
  }

  /**
   * 发送消息到 View
   */
  private sendMessageToView(message: any): void {
    this.sendToView({
      type: 'message',
      message
    });
  }

  /**
   * 发送数据到 Webview
   */
  private sendToView(data: any): void {
    this.view?.webview.postMessage(data);
  }

  /**
   * 获取 HTML 内容
   */
  private getHtmlContent(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      margin-bottom: 10px;
    }
    .message {
      margin-bottom: 15px;
      padding: 10px;
      border-radius: 5px;
    }
    .message.user {
      background: var(--vscode-input-background);
      margin-left: 20px;
    }
    .message.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground);
      margin-right: 20px;
    }
    .message .role {
      font-weight: bold;
      margin-bottom: 5px;
      font-size: 0.9em;
      opacity: 0.8;
    }
    .jsonl-block {
      margin: 10px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      overflow: hidden;
    }
    .jsonl-header {
      background: var(--vscode-panel-background);
      padding: 8px 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .jsonl-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .jsonl-content {
      padding: 10px;
      max-height: 400px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-editor-background);
    }
    .jsonl-event {
      margin-bottom: 5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .jsonl-event.token {
      color: var(--vscode-foreground);
    }
    .jsonl-event.progress {
      color: var(--vscode-terminal-ansiBlue);
    }
    .jsonl-event.error {
      color: var(--vscode-errorForeground);
    }
    .jsonl-event.warn {
      color: var(--vscode-terminal-ansiYellow);
    }
    #input-container {
      display: flex;
      gap: 5px;
      padding: 10px;
      background: var(--vscode-input-background);
      border-top: 1px solid var(--vscode-panel-border);
      position: sticky;
      bottom: 0;
    }
    #input {
      flex: 1;
      padding: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
    }
    button {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .status-badge {
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 0.8em;
    }
    .status-running { background: var(--vscode-terminal-ansiBlue); }
    .status-completed { background: var(--vscode-terminal-ansiGreen); }
    .status-paused { background: var(--vscode-terminal-ansiYellow); }
    .status-error { background: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div id="messages"></div>
  <div id="input-container">
    <input type="text" id="input" placeholder="输入消息..." />
    <button id="send">发送</button>
    <button id="pause" style="display:none;">暂停</button>
    <button id="resume" style="display:none;">继续</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesDiv = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const pauseBtn = document.getElementById('pause');
    const resumeBtn = document.getElementById('resume');

    let currentJSONLBlocks = {};

    // 发送消息
    sendBtn.onclick = () => {
      const text = input.value.trim();
      if (text) {
        vscode.postMessage({ type: 'send', text });
        input.value = '';
      }
    };

    input.onkeypress = (e) => {
      if (e.key === 'Enter') sendBtn.click();
    };

    pauseBtn.onclick = () => vscode.postMessage({ type: 'pause' });
    resumeBtn.onclick = () => vscode.postMessage({ type: 'resume' });

    // 接收消息
    window.addEventListener('message', event => {
      const data = event.data;
      
      switch (data.type) {
        case 'message':
          appendMessage(data.message);
          break;
        case 'assistantStart':
          startAssistantMessage(data.id);
          break;
        case 'assistantChunk':
          updateAssistantMessage(data.id, data.content);
          break;
        case 'jsonlBlock':
          appendJSONLBlock(data.block);
          break;
        case 'jsonlEvent':
          updateJSONLEvent(data.callId, data.event);
          break;
        case 'updateJSONLBlock':
          updateJSONLBlockStatus(data.block);
          break;
        case 'history':
          loadHistory(data.messages);
          break;
      }
    });

    let currentAssistantDiv = null;

    function startAssistantMessage(id) {
      const div = document.createElement('div');
      div.id = \`assistant-\${id}\`;
      div.className = 'message assistant';
      div.innerHTML = \`
        <div class="role">🤖 助手</div>
        <div class="content"></div>
      \`;
      messagesDiv.appendChild(div);
      currentAssistantDiv = div;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function updateAssistantMessage(id, content) {
      const div = document.getElementById(\`assistant-\${id}\`);
      if (div) {
        const contentDiv = div.querySelector('.content');
        if (contentDiv) {
          contentDiv.textContent = content;
        }
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function appendMessage(msg) {
      const div = document.createElement('div');
      div.className = \`message \${msg.role}\`;
      div.innerHTML = \`
        <div class="role">\${msg.role === 'user' ? '👤 用户' : '🤖 助手'}</div>
        <div class="content">\${escapeHtml(msg.content)}</div>
      \`;
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function appendJSONLBlock(block) {
      const div = document.createElement('div');
      div.id = \`block-\${block.call_id}\`;
      div.className = 'jsonl-block';
      div.innerHTML = \`
        <div class="jsonl-header" onclick="toggleBlock('\${block.call_id}')">
          <span>🔧 执行: \${block.agent_name}</span>
          <span class="status-badge status-\${block.status}">\${getStatusText(block.status)}</span>
        </div>
        <div class="jsonl-content" id="content-\${block.call_id}" style="display: \${block.expanded ? 'block' : 'none'}">
        </div>
      \`;
      messagesDiv.appendChild(div);
      currentJSONLBlocks[block.call_id] = div;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function updateJSONLEvent(callId, event) {
      const content = document.getElementById(\`content-\${callId}\`);
      if (!content) return;

      const eventDiv = document.createElement('div');
      eventDiv.className = \`jsonl-event \${event.type}\`;
      
      // 根据事件类型格式化显示
      if (event.type === 'start') {
        eventDiv.textContent = \`🚀 任务开始: \${event.task || ''}\`;
      } else if (event.type === 'token') {
        eventDiv.textContent = event.text || '';
      } else if (event.type === 'progress') {
        eventDiv.textContent = \`📊 \${event.phase || ''} \${event.pct || 0}%\`;
      } else if (event.type === 'result') {
        // 只显示摘要，不显示完整 JSON
        const summary = event.summary || event.output || '';
        eventDiv.textContent = \`\\n✅ 结果摘要:\\n\${summary.substring(0, 300)}...\`;
        eventDiv.style.fontWeight = 'bold';
        eventDiv.style.color = 'var(--vscode-terminal-ansiGreen)';
      } else if (event.type === 'end') {
        const duration = event.duration_ms ? \`(\${(event.duration_ms / 1000).toFixed(1)}s)\` : '';
        eventDiv.textContent = \`\\n🏁 任务完成 \${duration}\`;
        eventDiv.style.fontWeight = 'bold';
      } else if (event.type === 'notice') {
        eventDiv.textContent = \`ℹ️  \${event.text || ''}\`;
      } else if (event.type === 'warn') {
        eventDiv.textContent = \`⚠️  \${event.text || ''}\`;
      } else if (event.type === 'error') {
        eventDiv.textContent = \`❌ \${event.text || event.message || ''}\`;
      } else if (event.type === 'artifact') {
        eventDiv.textContent = \`📎 产物: \${event.path || ''}\`;
      } else {
        // 其他事件类型，简化显示
        eventDiv.textContent = \`[\${event.type}]\`;
        eventDiv.style.opacity = '0.5';
      }
      
      content.appendChild(eventDiv);
      content.scrollTop = content.scrollHeight;
    }

    function updateJSONLBlockStatus(block) {
      const blockDiv = currentJSONLBlocks[block.call_id];
      if (!blockDiv) return;

      const badge = blockDiv.querySelector('.status-badge');
      if (badge) {
        badge.className = \`status-badge status-\${block.status}\`;
        badge.textContent = getStatusText(block.status);
      }

      const content = document.getElementById(\`content-\${block.call_id}\`);
      if (content) {
        content.style.display = block.expanded ? 'block' : 'none';
      }
    }

    function toggleBlock(callId) {
      vscode.postMessage({ type: 'toggleJSONL', callId });
    }

    function loadHistory(messages) {
      messagesDiv.innerHTML = '';
      messages.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          appendMessage(msg);
          if (msg.jsonlBlock) {
            appendJSONLBlock(msg.jsonlBlock);
          }
        } else if (msg.role === 'tool_meta_display') {
          // 显示 tool_meta 的摘要信息
          appendToolMetaSummary(msg.content);
        }
      });
    }
    
    function appendToolMetaSummary(summary) {
      const div = document.createElement('div');
      div.className = 'jsonl-block';
      div.innerHTML = \`
        <div class="jsonl-header">
          <span>🔧 执行: \${summary.agent_name}</span>
          <span class="status-badge status-completed">已完成</span>
        </div>
        <div class="jsonl-content" style="display: none; padding: 10px;">
          <div style="white-space: pre-wrap;">\${escapeHtml(summary.summary)}</div>
        </div>
      \`;
      
      // 点击展开/折叠
      div.querySelector('.jsonl-header').onclick = function() {
        const content = div.querySelector('.jsonl-content');
        if (content.style.display === 'none') {
          content.style.display = 'block';
        } else {
          content.style.display = 'none';
        }
      };
      
      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function getStatusText(status) {
      const map = {
        running: '运行中',
        completed: '已完成',
        paused: '已暂停',
        error: '错误'
      };
      return map[status] || status;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // 通知就绪
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

