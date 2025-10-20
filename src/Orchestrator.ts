import * as vscode from 'vscode';
import { ChatMessage, ToolMetaMessage, JSONLEvent, ConversationHistory, JSONLBlock } from './types';
import { RuntimeManager } from './RuntimeManager';

/**
 * Orchestrator
 * 负责会话编排、上下文极简拼接、历史持久化
 */
export class Orchestrator {
  private history: ConversationHistory = {
    messages: [],
    lastState: 'IDLE'
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: RuntimeManager
  ) {
    this.loadHistory();
  }

  /**
   * 添加用户消息
   */
  addUserMessage(content: string): ChatMessage {
    const message: ChatMessage = {
      role: 'user',
      content,
      timestamp: Date.now()
    };
    this.history.messages.push(message);
    this.saveHistory();
    return message;
  }

  /**
   * 添加助手消息（带 JSONL 区块）
   */
  addAssistantMessage(content: string, jsonlBlock?: JSONLBlock): ChatMessage {
    const message: ChatMessage = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
      jsonlBlock
    };
    this.history.messages.push(message);
    this.saveHistory();
    return message;
  }

  /**
   * 创建 JSONL 区块
   */
  createJSONLBlock(agentName: string, callId: string): JSONLBlock {
    const expanded = vscode.workspace.getConfiguration('mla').get('jsonl.defaultExpanded', true);
    return {
      call_id: callId,
      agent_name: agentName,
      status: 'running',
      events: [],
      startTime: Date.now(),
      expanded
    };
  }

  /**
   * 添加 tool_meta（极简拼接）
   */
  addToolMeta(params: {
    agentName: string;
    input: string;
    callId: string;
    finalResultSummary?: string;
    lastAgentLine?: string;
    status: 'ok' | 'paused' | 'interrupted' | 'error';
  }): ToolMetaMessage {
    const maxInput = vscode.workspace.getConfiguration('mla').get('toolMeta.maxInputChars', 512);
    const maxResult = vscode.workspace.getConfiguration('mla').get('toolMeta.maxResultChars', 1024);

    const message: ToolMetaMessage = {
      role: 'tool_meta',
      agent_name: params.agentName,
      input: this.truncate(params.input, maxInput),
      call_id: params.callId,
      final_result_summary: params.finalResultSummary 
        ? this.truncate(params.finalResultSummary, maxResult) 
        : undefined,
      last_agent_line: params.lastAgentLine 
        ? this.truncate(params.lastAgentLine, 512) 
        : undefined,
      status: params.status,
      timestamp: Date.now()
    };

    this.history.messages.push(message);
    this.saveHistory();
    return message;
  }

  /**
   * 获取历史消息
   */
  getHistory(): ConversationHistory {
    return this.history;
  }

  /**
   * 清除历史
   */
  clearHistory(): void {
    this.history = {
      messages: [],
      lastState: 'IDLE'
    };
    this.saveHistory();
  }

  /**
   * 保存运行快照
   */
  saveRunSnapshot(snapshot: any): void {
    this.history.runSnapshot = snapshot;
    this.saveHistory();
  }

  /**
   * 更新最后状态
   */
  updateLastState(state: any): void {
    this.history.lastState = state;
    this.saveHistory();
  }

  /**
   * 构建上下文（用于 LLM 调用 - 未来扩展）
   * 仅包含: user/assistant 内容 + tool_meta 极简摘要
   */
  buildContext(): any[] {
    const context: any[] = [];

    for (const msg of this.history.messages) {
      if (msg.role === 'user') {
        context.push({
          role: 'user',
          content: msg.content
        });
      } else if (msg.role === 'assistant') {
        context.push({
          role: 'assistant',
          content: msg.content
        });
      } else if (msg.role === 'tool_meta') {
        // 极简拼接：只保留关键信息
        const meta = msg as ToolMetaMessage;
        let toolSummary = `[调用 ${meta.agent_name}]\n输入: ${meta.input}\n`;
        
        if (meta.final_result_summary) {
          toolSummary += `结果: ${meta.final_result_summary}\n`;
        }
        
        if (meta.last_agent_line) {
          toolSummary += `锚点: ${meta.last_agent_line}\n`;
        }
        
        toolSummary += `状态: ${meta.status}`;

        context.push({
          role: 'assistant',
          content: toolSummary
        });
      }
    }

    return context;
  }

  // ========== 私有方法 ==========

  private loadHistory(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const key = `mla.history.${this.getWorkspaceHash(workspaceFolder.uri.fsPath)}`;
    const saved = this.context.workspaceState.get<ConversationHistory>(key);
    
    if (saved) {
      this.history = saved;
    }
  }

  private saveHistory(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const maxMessages = vscode.workspace.getConfiguration('mla').get('history.maxMessages', 200);
    
    // 限制历史长度
    if (this.history.messages.length > maxMessages) {
      this.history.messages = this.history.messages.slice(-maxMessages);
    }

    const key = `mla.history.${this.getWorkspaceHash(workspaceFolder.uri.fsPath)}`;
    this.context.workspaceState.update(key, this.history);
  }

  private getWorkspaceHash(path: string): string {
    // 简单哈希
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }
}

