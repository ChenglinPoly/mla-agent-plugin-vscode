import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { JSONLEvent, AgentState, RunSnapshot } from './types';

/**
 * Runtime Manager
 * 负责进程管理、JSONL 解析、状态机控制
 */
export class RuntimeManager {
  private process?: ChildProcess;
  private state: AgentState = 'IDLE';
  private currentSnapshot?: RunSnapshot;
  private jsonlBuffer: string = '';
  
  // 事件发射器
  private readonly onEventEmitter = new vscode.EventEmitter<JSONLEvent>();
  public readonly onEvent = this.onEventEmitter.event;
  
  private readonly onStateChangeEmitter = new vscode.EventEmitter<AgentState>();
  public readonly onStateChange = this.onStateChangeEmitter.event;

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * 启动 mla-agent
   */
  async startAgent(params: {
    taskId: string;
    userInput: string;
    agentName?: string;
  }): Promise<void> {
    if (this.process) {
      throw new Error('Agent 已在运行中');
    }

    const agentName = params.agentName || vscode.workspace.getConfiguration('mla').get('defaultAgentName', 'writing_agent');
    const callId = `c-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // 保存快照（用于续跑）
    this.currentSnapshot = {
      task_id: params.taskId,
      agent_name: agentName,
      input: params.userInput,
      call_id: callId
    };

    const args = [
      '--task_id', params.taskId,
      '--user_input', params.userInput,
      '--agent_name', agentName,
      '--jsonl'
    ];

    this.outputChannel.appendLine(`[RuntimeManager] 启动 mla-agent: ${args.join(' ')}`);
    this.setState('M_RUNNING');

    try {
      this.process = spawn('mla-agent', args, {
        cwd: params.taskId,
        env: process.env
      });

      this.process.stdout?.on('data', (data) => this.handleStdout(data));
      this.process.stderr?.on('data', (data) => this.handleStderr(data));
      this.process.on('close', (code) => this.handleClose(code));
      this.process.on('error', (err) => this.handleError(err));

    } catch (error) {
      this.outputChannel.appendLine(`[RuntimeManager] 启动失败: ${error}`);
      this.setState('ERROR');
      throw error;
    }
  }

  /**
   * 暂停（软中断）
   */
  pause(): void {
    if (!this.process || this.state !== 'M_RUNNING') {
      return;
    }

    this.outputChannel.appendLine('[RuntimeManager] 发送暂停信号');
    
    // 软中断（SIGINT）
    if (process.platform === 'win32') {
      // Windows 不支持 SIGINT，使用 taskkill
      spawn('taskkill', ['/pid', this.process.pid!.toString(), '/T', '/F']);
    } else {
      this.process.kill('SIGINT');
    }

    this.setState('PAUSED');
  }

  /**
   * 继续（用相同参数重新调用）
   */
  async resume(): Promise<void> {
    if (!this.currentSnapshot) {
      throw new Error('无可恢复的任务快照');
    }

    this.outputChannel.appendLine('[RuntimeManager] 续跑任务');
    this.outputChannel.appendLine(`[RuntimeManager] 使用参数: task_id=${this.currentSnapshot.task_id}, input=${this.currentSnapshot.input}`);
    
    // 清理旧进程
    this.cleanup();
    
    // 发送续跑标记事件
    this.onEventEmitter.fire({
      type: 'resume_marker',
      text: '--- 续跑开始 ---'
    });

    // 用完全一致的参数重新启动
    await this.startAgent({
      taskId: this.currentSnapshot.task_id,
      userInput: this.currentSnapshot.input,
      agentName: this.currentSnapshot.agent_name
    });
  }

  /**
   * 停止
   */
  stop(): void {
    if (this.process) {
      this.outputChannel.appendLine('[RuntimeManager] 停止进程');
      this.process.kill();
      this.cleanup();
    }
    this.setState('CANCELLED');
  }

  /**
   * 获取当前快照
   */
  getSnapshot(): RunSnapshot | undefined {
    return this.currentSnapshot;
  }

  /**
   * 获取当前状态
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * 提取最后一条 agent 行（用于暂停锚点）
   */
  extractLastAgentLine(agentName: string, events: JSONLEvent[]): string {
    // 从后往前找最后一条 token 事件中包含 [agent_name] 的行
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'token' && event.text) {
        const lines = event.text.split('\n');
        for (let j = lines.length - 1; j >= 0; j--) {
          const line = lines[j].trim();
          if (line.startsWith(`[${agentName}]`)) {
            return this.truncate(line, 512);
          }
        }
      }
    }
    return '';
  }

  // ========== 私有方法 ==========

  private handleStdout(data: Buffer): void {
    const text = data.toString();
    this.jsonlBuffer += text;

    // 按行解析 JSONL
    const lines = this.jsonlBuffer.split('\n');
    this.jsonlBuffer = lines.pop() || ''; // 保留不完整的行

    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const event: JSONLEvent = JSON.parse(line);
        this.onEventEmitter.fire(event);
        
        // 处理特殊事件
        if (event.type === 'end') {
          this.setState('DONE');
        } else if (event.type === 'human_in_loop') {
          this.setState('AWAIT_HIL');
        }
      } catch (error) {
        // JSON 解析失败，作为普通日志
        this.outputChannel.appendLine(`[JSONL 解析失败] ${line}`);
        this.onEventEmitter.fire({
          type: 'notice',
          text: line
        });
      }
    }
  }

  private handleStderr(data: Buffer): void {
    const text = data.toString();
    this.outputChannel.appendLine(`[stderr] ${text}`);
  }

  private handleClose(code: number | null): void {
    this.outputChannel.appendLine(`[RuntimeManager] 进程退出，代码: ${code}`);
    
    if (code === 0) {
      this.setState('DONE');
    } else if (this.state === 'PAUSED') {
      // 保持暂停状态
    } else {
      this.setState(code === null ? 'CANCELLED' : 'ERROR');
    }
    
    this.cleanup();
  }

  private handleError(error: Error): void {
    this.outputChannel.appendLine(`[RuntimeManager] 错误: ${error.message}`);
    
    if (error.message.includes('ENOENT')) {
      vscode.window.showErrorMessage(
        'mla-agent 命令未找到，请确保已安装 MLA V3',
        '查看文档'
      ).then(selection => {
        if (selection === '查看文档') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/your-repo/MLA_V3'));
        }
      });
    }
    
    this.setState('ERROR');
    this.cleanup();
  }

  private cleanup(): void {
    this.process = undefined;
    this.jsonlBuffer = '';
  }

  private setState(newState: AgentState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChangeEmitter.fire(newState);
      this.outputChannel.appendLine(`[State] ${newState}`);
    }
  }

  private truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
  }

  dispose(): void {
    this.stop();
    this.onEventEmitter.dispose();
    this.onStateChangeEmitter.dispose();
  }
}

