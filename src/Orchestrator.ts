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
    const maxResult = vscode.workspace.getConfiguration('mla').get('toolMeta.maxResultChars', 0);

    const message: ToolMetaMessage = {
      role: 'tool_meta',
      agent_name: params.agentName,
      input: this.truncate(params.input, maxInput),
      call_id: params.callId,
      // maxResult = 0 表示不截断，完整保存
      final_result_summary: params.finalResultSummary 
        ? (maxResult > 0 ? this.truncate(params.finalResultSummary, maxResult) : params.finalResultSummary)
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
   * 手动保存历史（供外部调用）
   */
  saveHistory(): void {
    this.saveHistoryInternal();
  }

  /**
   * 保存运行快照
   */
  saveRunSnapshot(snapshot: any): void {
    this.history.runSnapshot = snapshot;
    this.saveHistoryInternal();
  }

  /**
   * 更新最后状态
   */
  updateLastState(state: any): void {
    this.history.lastState = state;
    this.saveHistoryInternal();
  }

  /**
   * 构建上下文（用于 LLM 调用）
   * 仅包含: user/assistant 内容 + tool_meta 极简摘要
   * 限制轮次数（根据配置）
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
        
        // 只保留结果，不要格式化文本（避免 Chatbot 重复输出）
        if (meta.final_result_summary) {
          context.push({
            role: 'user',  // 改为 user 角色，表示这是"工具执行的结果"
            content: `[系统] Agent "${meta.agent_name}" 执行结果：\n${meta.final_result_summary}`
          });
        }
      }
    }

    // 限制上下文轮次（根据配置）
    const maxTurns = vscode.workspace.getConfiguration('mla').get('chatbot.maxContextTurns', 20);
    if (maxTurns > 0 && context.length > maxTurns) {
      return context.slice(-maxTurns);
    }

    return context;
  }

  // ========== 私有方法 ==========

  private saveHistoryInternal(): void {
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

  private loadHistory(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const key = `mla.history.${this.getWorkspaceHash(workspaceFolder.uri.fsPath)}`;
    const saved = this.context.workspaceState.get<ConversationHistory>(key);
    
    if (saved) {
      this.history = saved;
    }
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

