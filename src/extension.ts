import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { RuntimeManager } from './RuntimeManager';
import { Orchestrator } from './Orchestrator';
import { LLMService } from './LLMService';
import { ChatViewProvider } from './ChatViewProvider';
import { SettingsViewProvider } from './SettingsViewProvider';

let outputChannel: vscode.OutputChannel;
let runtimeManager: RuntimeManager;
let orchestrator: Orchestrator;
let llmService: LLMService;
let chatViewProvider: ChatViewProvider;
let settingsViewProvider: SettingsViewProvider;

/**
 * 扩展激活
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('MLA Chatbot 扩展已激活');

  // 创建输出通道
  outputChannel = vscode.window.createOutputChannel('MLA Chatbot');
  context.subscriptions.push(outputChannel);

  // 创建核心组件
  runtimeManager = new RuntimeManager(outputChannel);
  orchestrator = new Orchestrator(context, runtimeManager);
  llmService = new LLMService(outputChannel);
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    runtimeManager,
    orchestrator,
    llmService
  );
  settingsViewProvider = new SettingsViewProvider(context.extensionUri);

  // 注册 Webview Provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mla.chatView',
      chatViewProvider
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'mla.settingsView',
      settingsViewProvider
    )
  );

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('mla.openChat', () => {
      vscode.commands.executeCommand('mla.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mla.clearHistory', () => {
      orchestrator.clearHistory();
      vscode.window.showInformationMessage('历史记录已清除');
    })
  );

  // 测试 LLM 连接
  context.subscriptions.push(
    vscode.commands.registerCommand('mla.testConnection', async () => {
      const result = await llmService.testConnection();
      if (result.success) {
        vscode.window.showInformationMessage(`✅ ${result.message}`);
      } else {
        vscode.window.showErrorMessage(`❌ ${result.message}`);
      }
    })
  );

  // 打开设置
  context.subscriptions.push(
    vscode.commands.registerCommand('mla.openSettings', () => {
      vscode.commands.executeCommand('mla.settingsView.focus');
    })
  );

  // 自动启动 tool-server
  const autoStart = vscode.workspace.getConfiguration('mla').get('autoStartToolServer', true);
  if (autoStart) {
    checkAndStartToolServer();
  }

  outputChannel.appendLine('MLA Chatbot 扩展初始化完成');
}

/**
 * 扩展停用
 */
export function deactivate() {
  if (runtimeManager) {
    runtimeManager.dispose();
  }
}

/**
 * 检查并启动 tool-server
 */
async function checkAndStartToolServer(): Promise<void> {
  try {
    // 检查 tool-server 状态
    const statusProcess = spawn('mla-tool-server', ['status'], {
      shell: true
    });

    let statusOutput = '';
    statusProcess.stdout?.on('data', (data) => {
      statusOutput += data.toString();
    });

    statusProcess.on('close', (code) => {
      if (statusOutput.includes('运行中') || statusOutput.includes('running')) {
        outputChannel.appendLine('[Tool Server] 已在运行');
      } else {
        outputChannel.appendLine('[Tool Server] 未运行，尝试启动...');
        startToolServer();
      }
    });

  } catch (error) {
    outputChannel.appendLine(`[Tool Server] 检查失败: ${error}`);
  }
}

/**
 * 启动 tool-server
 */
function startToolServer(): void {
  try {
    const startProcess = spawn('mla-tool-server', ['start'], {
      shell: true,
      detached: true,
      stdio: 'ignore'
    });

    startProcess.unref();

    // 等待2秒后检查
    setTimeout(() => {
      outputChannel.appendLine('[Tool Server] 启动完成');
      vscode.window.showInformationMessage('MLA Tool Server 已启动');
    }, 2000);

  } catch (error) {
    outputChannel.appendLine(`[Tool Server] 启动失败: ${error}`);
    vscode.window.showWarningMessage(
      'MLA Tool Server 启动失败，请手动运行: mla-tool-server start',
      '查看文档'
    ).then(selection => {
      if (selection === '查看文档') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/your-repo/MLA_V3'));
      }
    });
  }
}

