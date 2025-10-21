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
  private pendingMessages: any[] = [];  // 缓存未发送的消息

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runtime: RuntimeManager,
    private readonly orchestrator: Orchestrator,
    private readonly llm: LLMService
  ) {
    // 监听 JSONL 事件
    this.runtime.onEvent(event => this.handleJSONLEvent(event));
    
    // 监听状态变化
    this.runtime.onStateChange(state => {
      this.handleStateChange(state);
      // 同步状态到 UI
      this.sendToView({
        type: 'updateState',
        state: state
      });
    });
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
    
    // 监听可见性变化
    webviewView.onDidChangeVisibility(() => {
      console.log(`[ChatView] 可见性变化: ${webviewView.visible}`);
      
      if (webviewView.visible && this.pendingMessages.length > 0) {
        // 切回来时，补发缓存消息
        console.log(`[ChatView] 补发 ${this.pendingMessages.length} 条缓存消息`);
        const messages = [...this.pendingMessages];
        this.pendingMessages = [];
        
        // 延迟发送，确保 Webview 完全准备好
        setTimeout(() => {
          messages.forEach(msg => {
            webviewView.webview.postMessage(msg);
          });
        }, 100);
      }
    });

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
          // Webview 加载完成，延迟发送历史消息
          console.log('[Webview] ready 事件接收');
          setTimeout(() => {
            console.log('[Webview] 延迟后发送历史');
            this.sendHistoryToView();
          }, 100);
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
    
    // 上下文调试日志（仅在 OUTPUT 面板查看）
    this.runtime['outputChannel']?.appendLine('=== Chatbot 上下文 ===');
    this.runtime['outputChannel']?.appendLine(`消息数: ${context.length}`);
    context.forEach((msg, i) => {
      this.runtime['outputChannel']?.appendLine(`[${i}] ${msg.role}: ${msg.content.substring(0, 200)}...`);
    });
    this.runtime['outputChannel']?.appendLine('=== 上下文结束 ===');
    
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
      
      // 保存助手消息到历史（完整保存，包含 XML 前的文本和 XML）
      this.orchestrator.addAssistantMessage(fullResponse);
      
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
    
    // 🔥 立即保存到历史（将执行区块关联到最后一条 assistant 消息）
    const history = this.orchestrator.getHistory();
    const lastAssistantMsg = history.messages.filter(m => m.role === 'assistant').pop();
    if (lastAssistantMsg && 'jsonlBlock' in lastAssistantMsg) {
      (lastAssistantMsg as any).jsonlBlock = this.currentJSONLBlock;
      this.orchestrator.saveHistory();
    }
    
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
    
    // 🔥 实时保存执行区块到历史
    this.saveCurrentBlockToHistory();

    // 检测 HIL（在 token 事件中）
    if (event.type === 'token' && event.text) {
      const hilMatch = event.text.match(/调用工具:\s*human_in_loop\s*\n参数:\s*({[\s\S]*?})/);
      if (hilMatch) {
        try {
          // 解析 HIL 参数
          const paramsStr = hilMatch[1].replace(/\n/g, '').replace(/\s+/g, ' ');
          const params = JSON.parse(paramsStr);
          
          console.log('[ChatViewProvider] 检测到 HIL:', params);
          
          // 显示 HIL UI
          this.showHILDialog({
            type: 'human_in_loop',
            hil_id: params.hil_id,
            instruction: params.instruction,
            timeout: params.timeout || null,
            ui: params.ui || { type: 'confirm' }
          });
          
          // 添加到事件列表（标记为 HIL）
          this.currentJSONLBlock.events.push({
            type: 'human_in_loop',
            hil_id: params.hil_id,
            instruction: params.instruction,
            timeout: params.timeout
          });
          
          // 发送 HIL 事件到 UI（特殊渲染）
          this.sendToView({
            type: 'jsonlEvent',
            callId: this.currentJSONLBlock.call_id,
            event: {
              type: 'human_in_loop',
              hil_id: params.hil_id,
              instruction: params.instruction,
              timeout: params.timeout
            }
          });
          
          return; // 不再处理为普通 token
        } catch (error) {
          console.error('[ChatViewProvider] HIL 参数解析失败:', error);
        }
      }
    }

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

      // 在 JSONL 区块内添加摘要信息卡片（不依赖 Chatbot）
      this.sendToView({
        type: 'jsonlEvent',
        callId: this.currentJSONLBlock.call_id,
        event: {
          type: 'meta_summary',
          agent_name: this.currentJSONLBlock.agent_name,
          summary: summary
        }
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
    const systemFeedback = `[系统反馈] MLA Agent "${this.currentJSONLBlock?.agent_name}" 已执行完成。

注意：
1. 不要重复输出执行结果的详细内容（结果已在执行区块中显示）
2. 只需判断：是否需要继续调用下一个 agent？
3. 如果不需要继续，直接简短总结即可（1-2句话）
4. 如果需要继续，说明下一步要做什么，然后输出 XML 调用`;
    
    console.log('[continueWithResult] 创建助手消息');
    
    // 调用 LLM，让它基于结果决定下一步
    const assistantMsgId = Date.now();
    this.sendToView({
      type: 'assistantStart',
      id: assistantMsgId
    });

    // 构建上下文（包含最新的 tool_meta 结果）
    const context = this.orchestrator.buildContext();
    
    // 添加系统反馈
    context.push({
      role: 'user',  // 改为 user，更符合对话流
      content: systemFeedback
    });
    
    // 上下文调试日志（OUTPUT 面板）
    this.runtime['outputChannel']?.appendLine('=== [continueWithResult] Chatbot 上下文 ===');
    this.runtime['outputChannel']?.appendLine(`消息数: ${context.length}`);
    context.forEach((msg, i) => {
      this.runtime['outputChannel']?.appendLine(`[${i}] ${msg.role}: ${msg.content.substring(0, 200)}...`);
    });
    this.runtime['outputChannel']?.appendLine('=== 上下文结束 ===');

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
      
      // 保存助手消息（包含 XML）
      this.orchestrator.addAssistantMessage(fullResponse);
      
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
    console.log(`[handleStateChange] 状态变化: ${state}`);
    
    this.orchestrator.updateLastState(state);
    
    if (state === 'PAUSED' && this.currentJSONLBlock) {
      console.log('[handleStateChange] 更新 JSONL 区块为暂停状态');
      
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
      
      // 在 JSONL 区块中添加暂停提示
      this.sendToView({
        type: 'jsonlEvent',
        callId: this.currentJSONLBlock.call_id,
        event: {
          type: 'notice',
          text: '⏸ 任务已暂停'
        }
      });
    } else if (state === 'DONE' && this.currentJSONLBlock) {
      console.log('[handleStateChange] 任务完成，清除 currentJSONLBlock');
      this.currentJSONLBlock = undefined;
    }
  }

  /**
   * 显示 HIL 对话框
   */
  private async showHILDialog(event: any): Promise<void> {
    const hilId = event.hil_id || 'unknown';
    const instruction = event.instruction || '请确认';
    const uiType = event.ui?.type || 'confirm';
    const timeout = event.timeout;

    console.log(`[showHILDialog] HIL ID: ${hilId}, UI类型: ${uiType}, 超时: ${timeout}`);

    // 根据 UI 类型显示不同的界面
    switch (uiType) {
      case 'confirm':
        await this.showHILConfirm(hilId, instruction, timeout);
        break;
      case 'form':
        await this.showHILForm(hilId, instruction, event.ui?.fields || [], timeout);
        break;
      case 'select':
        await this.showHILSelect(hilId, instruction, event.ui?.options || [], timeout);
        break;
      case 'file_pick':
        await this.showHILFilePick(hilId, instruction, event.ui?.filter || {}, timeout);
        break;
      default:
        await this.showHILConfirm(hilId, instruction, timeout);
    }
  }

  /**
   * HIL - 确认对话框
   */
  private async showHILConfirm(hilId: string, instruction: string, timeout?: number): Promise<void> {
    const message = timeout 
      ? `🤝 ${instruction}\n\n⏱ 超时时间: ${timeout} 秒`
      : `🤝 ${instruction}`;

    const result = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      '确认',
      '取消'
    );

    const userResult = result === '确认' ? '用户已确认' : '用户取消';
    await this.confirmHIL(hilId, userResult);
  }

  /**
   * HIL - 表单输入
   */
  private async showHILForm(hilId: string, instruction: string, fields: any[], timeout?: number): Promise<void> {
    const results: any = {};
    
    for (const field of fields) {
      const value = await vscode.window.showInputBox({
        prompt: `${instruction}\n\n${field.label}`,
        placeHolder: field.placeholder || '',
        value: field.default || ''
      });
      
      if (value === undefined) {
        await this.confirmHIL(hilId, '用户取消');
        return;
      }
      
      results[field.name] = value;
    }
    
    await this.confirmHIL(hilId, JSON.stringify(results));
  }

  /**
   * HIL - 选择列表
   */
  private async showHILSelect(hilId: string, instruction: string, options: string[], timeout?: number): Promise<void> {
    const result = await vscode.window.showQuickPick(options, {
      placeHolder: instruction,
      canPickMany: false
    });

    if (!result) {
      await this.confirmHIL(hilId, '用户取消');
      return;
    }

    await this.confirmHIL(hilId, result);
  }

  /**
   * HIL - 文件选择
   */
  private async showHILFilePick(hilId: string, instruction: string, filter: any, timeout?: number): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: '选择',
      filters: filter
    });

    if (!result || result.length === 0) {
      await this.confirmHIL(hilId, '用户取消');
      return;
    }

    await this.confirmHIL(hilId, result[0].fsPath);
  }

  /**
   * 确认 HIL
   */
  private async confirmHIL(hilId: string, result: string): Promise<void> {
    console.log(`[confirmHIL] HIL ID: ${hilId}, 结果: ${result}`);
    
    /**
     * 使用 qwen3 环境中 mla-agent 的完整路径
     * 避免 VSCode 子进程中找不到 conda 环境的问题
     */
    const { spawn } = require('child_process');
    const mlaAgentPath = '/home/colin/miniconda3/envs/qwen3/bin/mla-agent';
    const proc = spawn(mlaAgentPath, ['confirm', hilId, '--result', result]);
    
    proc.on('close', (code: number) => {
      if (code === 0) {
        console.log(`[confirmHIL] HIL 确认成功: ${hilId}`);
      } else {
        console.error(`[confirmHIL] HIL 确认失败，退出码: ${code}`);
      }
    });
    
    proc.on('error', (err: Error) => {
      console.error(`[confirmHIL] 调用 mla-agent confirm 失败:`, err);
    });
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
      
      // 实时保存到历史
      this.saveCurrentBlockToHistory();
    }
  }

  /**
   * 保存当前执行区块到历史
   */
  private saveCurrentBlockToHistory(): void {
    if (!this.currentJSONLBlock) return;
    
    const history = this.orchestrator.getHistory();
    const lastAssistantMsg = history.messages.filter(m => m.role === 'assistant').pop();
    
    if (lastAssistantMsg && 'jsonlBlock' in lastAssistantMsg) {
      (lastAssistantMsg as any).jsonlBlock = this.currentJSONLBlock;
      this.orchestrator.saveHistory();
    }
  }

  /**
   * 发送历史消息到 View
   */
  private sendHistoryToView(): void {
    const history = this.orchestrator.getHistory();
    
    console.log('[sendHistoryToView] 历史消息总数:', history.messages.length);
    
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
    
    console.log('[sendHistoryToView] 发送显示消息数:', displayMessages.length);
    
    // 限制历史消息数量（根据配置）
    const displayCount = vscode.workspace.getConfiguration('mla').get('history.displayRecentCount', 0);
    const recentMessages = displayCount > 0 
      ? displayMessages.slice(-displayCount) 
      : displayMessages;  // 0 = 全部显示
    console.log('[sendHistoryToView] 实际发送消息数:', recentMessages.length);
    
    this.sendToView({
      type: 'history',
      messages: recentMessages
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
    if (!this.view) {
      console.error('[sendToView] view 不存在！');
      return;
    }
    
    console.log('[sendToView] 发送消息类型:', data.type, '数据大小:', JSON.stringify(data).length);
    
    // 如果 Webview 不可见，缓存消息
    if (!this.view.visible) {
      console.log('[sendToView] Webview 不可见，缓存消息');
      this.pendingMessages.push(data);
      return;
    }
    
    try {
      this.view.webview.postMessage(data);
    } catch (error) {
      console.error('[sendToView] 发送失败:', error);
    }
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
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 10px;
    }
    .message {
      margin-bottom: 15px;
      padding: 10px;
      border-radius: 5px;
    }
    .message.user {
      background: var(--vscode-input-background);
      border-left: 3px solid var(--vscode-terminal-ansiBlue);
    }
    .message.assistant {
      background: transparent;
      padding-left: 0;
    }
    .message .role {
      font-weight: bold;
      margin-bottom: 8px;
      font-size: 0.9em;
      opacity: 0.8;
    }
    .message .content {
      line-height: 1.6;
    }
    .message.assistant .content {
      color: var(--vscode-foreground);
    }
    /* Markdown 样式 */
    .message .content h1, .message .content h2, .message .content h3 {
      margin-top: 0.5em;
      margin-bottom: 0.5em;
    }
    .message .content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
    }
    .message .content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 5px;
      overflow-x: auto;
    }
    .message .content ul, .message .content ol {
      margin-left: 1.5em;
    }
    .message .content blockquote {
      border-left: 3px solid var(--vscode-terminal-ansiCyan);
      padding-left: 10px;
      margin-left: 0;
      opacity: 0.8;
    }
    .xml-hidden {
      display: none;
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
      max-height: 300px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-editor-background);
      position: relative;
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
      gap: 8px;
      padding: 12px;
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      position: sticky;
      bottom: 0;
      align-items: center;
    }
    #input {
      flex: 1;
      padding: 10px 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    #input:focus {
      border-color: var(--vscode-focusBorder);
    }
    button {
      padding: 10px 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    }
    button:active {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
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
    <button id="pause" class="secondary" style="display:none;">⏸ 暂停</button>
    <button id="resume" style="display:none;">▶️ 继续</button>
    <button id="stop" class="secondary" style="display:none;">⏹ 停止</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesDiv = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const pauseBtn = document.getElementById('pause');
    const resumeBtn = document.getElementById('resume');
    const stopBtn = document.getElementById('stop');

    let currentJSONLBlocks = {};
    let currentState = 'IDLE';  // 跟踪当前状态

    // 发送消息
    sendBtn.onclick = () => {
      const text = input.value.trim();
      if (text) {
        vscode.postMessage({ type: 'send', text });
        input.value = '';
      }
    };

    input.onkeypress = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    };

    pauseBtn.onclick = () => vscode.postMessage({ type: 'pause' });
    resumeBtn.onclick = () => vscode.postMessage({ type: 'resume' });
    stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });

    // 接收消息
    window.addEventListener('message', event => {
      const data = event.data;
      
      console.log('[Webview] 收到消息类型:', data.type);
      
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
          console.log('[Webview] 调用 loadHistory, 消息数:', data.messages?.length);
          loadHistory(data.messages);
          break;
        case 'updateState':
          updateUIState(data.state);
          break;
        default:
          console.warn('[Webview] 未知消息类型:', data.type);
      }
    });

    // 更新 UI 状态（按钮显示/隐藏）
    function updateUIState(state) {
      currentState = state;
      
      // 根据状态显示不同按钮
      if (state === 'IDLE' || state === 'DONE' || state === 'ERROR' || state === 'CANCELLED') {
        // 空闲或完成状态：显示发送按钮
        sendBtn.style.display = 'inline-block';
        input.disabled = false;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        stopBtn.style.display = 'none';
      } else if (state === 'M_RUNNING') {
        // MLA 运行中：显示暂停和停止按钮
        sendBtn.style.display = 'none';
        input.disabled = true;
        pauseBtn.style.display = 'inline-block';
        resumeBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
      } else if (state === 'PAUSED') {
        // 暂停状态：显示继续和停止按钮
        sendBtn.style.display = 'none';
        input.disabled = true;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'inline-block';
        stopBtn.style.display = 'inline-block';
      } else if (state === 'AWAIT_HIL') {
        // 等待 HIL：禁用所有操作
        sendBtn.style.display = 'none';
        input.disabled = true;
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
      }
    }

    let currentAssistantDiv = null;
    
    // 简单 Markdown 渲染（必须在 appendMessage 之前定义）
    function renderMarkdown(text) {
      if (!text) return '';
      
      try {
        let html = text;
        
        // 转义 HTML
        const tempDiv = document.createElement('div');
        tempDiv.textContent = html;
        html = tempDiv.innerHTML;
        
        // 粗体
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        
        // 行内代码
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        
        // 换行
        html = html.replace(/\\n/g, '<br>');
        
        return html;
      } catch (e) {
        console.error('renderMarkdown 错误:', e);
        return escapeHtml(text);
      }
    }

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
          // 隐藏 XML 标签
          let displayContent = content.replace(/<mla_call>[\\s\\S]*?<\\/mla_call>/g, '').trim();
          
          // TODO: Markdown 渲染暂时禁用
          // displayContent = renderMarkdown(displayContent);
          
          contentDiv.textContent = displayContent;
        }
      }
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function appendMessage(msg) {
      try {
        const div = document.createElement('div');
        div.className = \`message \${msg.role}\`;
        
        let displayContent = msg.content || '';
        
        // 助手消息：隐藏 XML
        if (msg.role === 'assistant') {
          displayContent = displayContent.replace(/<mla_call>[\\s\\S]*?<\\/mla_call>/g, '').trim();
          // TODO: Markdown 渲染暂时禁用
          // displayContent = renderMarkdown(displayContent);
        }
        
        div.innerHTML = \`
          <div class="role">\${msg.role === 'user' ? '👤 用户' : '🤖 助手'}</div>
          <div class="content">\${escapeHtml(displayContent)}</div>
        \`;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      } catch (e) {
        console.error('appendMessage 错误:', e, msg);
      }
    }

    function appendJSONLBlock(block) {
      const div = document.createElement('div');
      div.id = \`block-\${block.call_id}\`;
      div.className = 'jsonl-block';
      div.innerHTML = \`
        <div class="jsonl-header">
          <span>🔧 执行: \${block.agent_name}</span>
          <span class="status-badge status-\${block.status}">\${getStatusText(block.status)}</span>
        </div>
        <div class="jsonl-content" id="content-\${block.call_id}" style="display: \${block.expanded ? 'block' : 'none'}">
        </div>
      \`;
      
      // 添加点击事件（使用事件委托，避免 onclick 属性）
      const header = div.querySelector('.jsonl-header');
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBlock(block.call_id);
      });
      
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
        // 完整显示 result（区块有滚动条）
        const summary = event.summary || event.output || '';
        eventDiv.textContent = \`\\n✅ 结果摘要:\\n\${summary}\`;
        eventDiv.style.fontWeight = 'bold';
        eventDiv.style.color = 'var(--vscode-terminal-ansiGreen)';
        eventDiv.style.whiteSpace = 'pre-wrap';
      } else if (event.type === 'end') {
        const duration = event.duration_ms ? \`(\${(event.duration_ms / 1000).toFixed(1)}s)\` : '';
        eventDiv.textContent = \`\\n🏁 任务完成 \${duration}\`;
        eventDiv.style.fontWeight = 'bold';
      } else if (event.type === 'resume_marker') {
        // 续跑分割线
        eventDiv.innerHTML = '<hr style="border: 1px dashed var(--vscode-terminal-ansiYellow); margin: 10px 0;"><div style="text-align: center; color: var(--vscode-terminal-ansiYellow);">▼ 续跑开始 ▼</div><hr style="border: 1px dashed var(--vscode-terminal-ansiYellow); margin: 10px 0;">';
      } else if (event.type === 'notice') {
        eventDiv.textContent = \`ℹ️  \${event.text || ''}\`;
      } else if (event.type === 'warn') {
        eventDiv.textContent = \`⚠️  \${event.text || ''}\`;
      } else if (event.type === 'error') {
        eventDiv.textContent = \`❌ \${event.text || event.message || ''}\`;
      } else if (event.type === 'artifact') {
        eventDiv.textContent = \`📎 产物: \${event.path || ''}\`;
      } else if (event.type === 'meta_summary') {
        // 执行摘要卡片（简洁版，在区块内显示）
        eventDiv.innerHTML = \`
          <div style="border-left: 3px solid var(--vscode-terminal-ansiGreen); padding: 10px; margin: 10px 0; background: var(--vscode-editor-inactiveSelectionBackground);">
            <div style="font-weight: bold; margin-bottom: 5px; color: var(--vscode-terminal-ansiGreen);">✅ 执行完成</div>
            <div style="font-size: 0.9em; opacity: 0.9;">Agent: \${event.agent_name}</div>
          </div>
        \`;
      } else if (event.type === 'human_in_loop') {
        // HIL 事件 - 特殊卡片显示
        eventDiv.innerHTML = \`
          <div style="border: 2px solid var(--vscode-terminal-ansiYellow); padding: 10px; margin: 10px 0; border-radius: 5px; background: var(--vscode-editor-inactiveSelectionBackground);">
            <div style="font-weight: bold; margin-bottom: 5px;">🤝 等待用户操作</div>
            <div style="margin-bottom: 5px;">HIL ID: \${event.hil_id}</div>
            <div>\${event.instruction}</div>
            \${event.timeout ? '<div style="margin-top: 5px; color: var(--vscode-terminal-ansiYellow);">⏱ 超时: ' + event.timeout + ' 秒</div>' : ''}
            <div style="margin-top: 10px; font-size: 0.9em; opacity: 0.8;">等待确认中...</div>
          </div>
        \`;
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
      const contentDiv = document.getElementById(\`content-\${callId}\`);
      if (contentDiv) {
        const isHidden = contentDiv.style.display === 'none';
        contentDiv.style.display = isHidden ? 'block' : 'none';
      }
    }

    function loadHistory(messages) {
      console.log('[loadHistory] 接收到历史消息:', messages.length);
      
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
      
      console.log('[loadHistory] 消息添加完成, messagesDiv.children.length:', messagesDiv.children.length);
      console.log('[loadHistory] scrollHeight:', messagesDiv.scrollHeight);
      
      // 加载完历史后，立即滚动并再次确认
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      console.log('[loadHistory] 第1次滚动, scrollTop:', messagesDiv.scrollTop);
      
      setTimeout(() => {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        console.log('[loadHistory] 第2次滚动(200ms), scrollTop:', messagesDiv.scrollTop, 'scrollHeight:', messagesDiv.scrollHeight);
      }, 200);
      
      // 再次确认（处理异步渲染）
      setTimeout(() => {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        console.log('[loadHistory] 第3次滚动(500ms), scrollTop:', messagesDiv.scrollTop);
      }, 500);
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
      const header = div.querySelector('.jsonl-header');
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const content = div.querySelector('.jsonl-content');
        if (content.style.display === 'none') {
          content.style.display = 'block';
        } else {
          content.style.display = 'none';
        }
      });
      
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

    // 初始化 UI 状态
    updateUIState('IDLE');
    
    // 通知就绪
    vscode.postMessage({ type: 'ready' });
    
    // 自动滚动到底部（稍作延迟确保内容加载完成）
    setTimeout(() => {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }, 100);
  </script>
</body>
</html>`;
  }
}

