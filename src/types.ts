/**
 * 类型定义
 */

// 状态机
export type AgentState = 
  | 'IDLE' 
  | 'A_RUNNING'      // 助手自然语言生成中
  | 'M_RUNNING'      // MLA 执行中
  | 'AWAIT_HIL'      // 等待人机确认
  | 'PAUSED'         // 已暂停
  | 'DONE'           // 本轮完成
  | 'CANCELLED'      // 已取消
  | 'ERROR';         // 错误

// JSONL 事件类型
export interface JSONLEvent {
  type: 'start' | 'token' | 'progress' | 'artifact' | 'notice' | 'warn' | 'error' | 'result' | 'end' | 'human_in_loop';
  [key: string]: any;
}

// 消息角色
export type MessageRole = 'user' | 'assistant' | 'tool_meta';

// 用户/助手消息
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  // assistant 消息可能包含 JSONL 区块
  jsonlBlock?: JSONLBlock;
}

// tool_meta 消息（极简拼接）
export interface ToolMetaMessage {
  role: 'tool_meta';
  agent_name: string;
  input: string;          // 清洗/截断 ≤512
  call_id: string;
  final_result_summary?: string;  // ≤1024
  last_agent_line?: string;       // 暂停时记录 ≤512
  status: 'ok' | 'paused' | 'interrupted' | 'error';
  timestamp: number;
}

// JSONL 执行区块
export interface JSONLBlock {
  call_id: string;
  agent_name: string;
  status: 'running' | 'paused' | 'completed' | 'error';
  events: JSONLEvent[];
  startTime: number;
  endTime?: number;
  expanded: boolean;
}

// HIL 任务
export interface HILTask {
  hil_id: string;
  instruction: string;
  timeout?: number;
  timestamp: number;
}

// 运行参数快照（用于续跑）
export interface RunSnapshot {
  task_id: string;
  agent_name: string;
  input: string;
  call_id: string;
}

// 会话历史
export interface ConversationHistory {
  messages: (ChatMessage | ToolMetaMessage)[];
  pendingHIL?: HILTask[];
  runSnapshot?: RunSnapshot;
  lastState: AgentState;
}

