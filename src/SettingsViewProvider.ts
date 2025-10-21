import * as vscode from 'vscode';
import { spawn } from 'child_process';

/**
 * 设置页面 Provider
 */
export class SettingsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly extensionUri: vscode.Uri) {}

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

    webviewView.webview.html = this.getHtmlContent();

    // 处理来自 Webview 的消息
    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'getConfig':
          await this.sendCurrentConfig();
          break;
        case 'saveConfig':
          await this.saveConfig(message.config);
          break;
        case 'saveMlaConfig':
          await this.saveMlaConfig(message.config);
          break;
      }
    });
  }

  /**
   * 发送当前配置到 View
   */
  private async sendCurrentConfig(): Promise<void> {
    const config = vscode.workspace.getConfiguration('mla');
    
    // 读取 mla-agent 配置
    let mlaConfig: any = {};
    try {
      const configText = await this.runCommand('mla-agent', ['--config-show']);
      mlaConfig = this.parseMlaConfig(configText);
    } catch (error) {
      console.error('读取 mla-agent 配置失败:', error);
    }

    this.view?.webview.postMessage({
      type: 'config',
      data: {
        chatbot: {
          model: config.get('chatbot.model', ''),
          temperature: config.get('chatbot.temperature', 0),
          maxContextTurns: config.get('chatbot.maxContextTurns', 20)
        },
        history: {
          maxMessages: config.get('history.maxMessages', 200),
          displayRecentCount: config.get('history.displayRecentCount', 0)
        },
        server: {
          autoStartToolServer: config.get('autoStartToolServer', true)
        },
        jsonl: {
          defaultExpanded: config.get('jsonl.defaultExpanded', true)
        },
        toolMeta: {
          maxInputChars: config.get('toolMeta.maxInputChars', 512),
          maxResultChars: config.get('toolMeta.maxResultChars', 1024)
        },
        mla: {
          models: mlaConfig.models || [],
          baseUrl: mlaConfig.base_url || '',
          apiKey: mlaConfig.api_key || '',
          temperature: mlaConfig.temperature || 0,
          max_tokens: mlaConfig.max_tokens || 0,
          max_context_window: mlaConfig.max_context_window || 200000
        }
      }
    });
  }

  /**
   * 保存配置
   */
  private async saveConfig(newConfig: any): Promise<void> {
    const config = vscode.workspace.getConfiguration('mla');

    try {
      await config.update('chatbot.model', newConfig.chatbot.model, vscode.ConfigurationTarget.Global);
      await config.update('chatbot.temperature', newConfig.chatbot.temperature, vscode.ConfigurationTarget.Global);
      await config.update('chatbot.maxContextTurns', newConfig.chatbot.maxContextTurns, vscode.ConfigurationTarget.Global);
      await config.update('history.maxMessages', newConfig.history.maxMessages, vscode.ConfigurationTarget.Global);
      await config.update('history.displayRecentCount', newConfig.history.displayRecentCount, vscode.ConfigurationTarget.Global);
      await config.update('autoStartToolServer', newConfig.server.autoStartToolServer, vscode.ConfigurationTarget.Global);
      await config.update('jsonl.defaultExpanded', newConfig.jsonl.defaultExpanded, vscode.ConfigurationTarget.Global);
      await config.update('toolMeta.maxInputChars', newConfig.toolMeta.maxInputChars, vscode.ConfigurationTarget.Global);
      await config.update('toolMeta.maxResultChars', newConfig.toolMeta.maxResultChars, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage('✅ 配置已保存');
      
      // 重新加载配置
      await this.sendCurrentConfig();
    } catch (error: any) {
      vscode.window.showErrorMessage(`保存配置失败: ${error.message}`);
    }
  }

  /**
   * 保存 MLA 配置（使用 mla-agent 命令）
   */
  private async saveMlaConfig(config: any): Promise<void> {
    try {
      // 使用 mla-agent --config-set 命令设置每个参数
      await this.runCommand('mla-agent', ['--config-set', 'base_url', config.base_url]);
      await this.runCommand('mla-agent', ['--config-set', 'api_key', config.api_key]);
      await this.runCommand('mla-agent', ['--config-set', 'temperature', config.temperature.toString()]);
      await this.runCommand('mla-agent', ['--config-set', 'max_tokens', config.max_tokens.toString()]);
      await this.runCommand('mla-agent', ['--config-set', 'max_context_window', config.max_context_window.toString()]);
      
      // 模型列表需要 JSON 格式
      const modelsJson = JSON.stringify(config.models);
      await this.runCommand('mla-agent', ['--config-set', 'models', modelsJson]);
      
      vscode.window.showInformationMessage('✅ MLA 配置已更新');
      
      // 延迟后重新加载配置
      setTimeout(async () => {
        await this.sendCurrentConfig();
      }, 500);
      
    } catch (error: any) {
      vscode.window.showErrorMessage(`更新 MLA 配置失败: ${error.message}`);
      console.error('[saveMlaConfig] 错误:', error);
    }
  }

  /**
   * 解析 mla-agent 配置
   */
  private parseMlaConfig(configText: string): any {
    const config: any = { 
      models: [],
      temperature: 0,
      max_tokens: 0,
      max_context_window: 200000
    };
    const lines = configText.split('\n');
    let inModelsSection = false;
    const models: string[] = [];

    for (const line of lines) {
      if (line.includes('base_url:')) {
        config.base_url = line.split(':').slice(1).join(':').trim();
      } else if (line.includes('api_key:')) {
        config.api_key = line.split(':').slice(1).join(':').trim();
      } else if (line.includes('temperature:')) {
        config.temperature = parseFloat(line.split(':')[1]?.trim() || '0');
      } else if (line.includes('max_tokens:')) {
        config.max_tokens = parseInt(line.split(':')[1]?.trim() || '0');
      } else if (line.includes('max_context_window:')) {
        config.max_context_window = parseInt(line.split(':')[1]?.trim() || '200000');
      } else if (line.includes('models:')) {
        inModelsSection = true;
      } else if (inModelsSection && line.trim().startsWith('-')) {
        // 清理引号和转义
        let model = line.trim().substring(1).trim();
        // 移除所有引号和转义字符
        model = model.replace(/^["']+|["']+$/g, '');  // 移除首尾引号
        model = model.replace(/\\"/g, '');  // 移除转义引号
        model = model.replace(/\\\\/g, '');  // 移除反斜杠
        models.push(model);
      } else if (inModelsSection && line.trim() && !line.trim().startsWith('-')) {
        inModelsSection = false;
        config.models = models;
      }
    }

    if (inModelsSection && models.length > 0) {
      config.models = models;
    }

    return config;
  }

  /**
   * 运行命令
   */
  private runCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let output = '';
      let error = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(error || `Command failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * 获取 HTML 内容
   */
  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      padding: 20px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .section {
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .section:last-child {
      border-bottom: none;
    }
    h2 {
      margin-top: 0;
      margin-bottom: 15px;
      color: var(--vscode-terminal-ansiCyan);
    }
    .setting-item {
      margin-bottom: 15px;
    }
    label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
    }
    input[type="text"], input[type="number"], select, textarea {
      width: 100%;
      padding: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      box-sizing: border-box;
    }
    input[type="checkbox"] {
      margin-right: 8px;
    }
    .description {
      font-size: 0.9em;
      opacity: 0.8;
      margin-top: 3px;
    }
    button {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      margin-right: 10px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .model-list {
      list-style: none;
      padding: 0;
    }
    .model-item {
      display: flex;
      align-items: center;
      padding: 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      margin-bottom: 5px;
      border-radius: 3px;
    }
    .model-item input {
      flex: 1;
      margin-right: 10px;
    }
    .model-item button {
      padding: 4px 8px;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <h1>⚙️ MLA Chatbot 设置</h1>

  <!-- MLA Agent 配置 -->
  <div class="section">
    <h2>🛠️ MLA Agent 配置</h2>
    
    <div class="setting-item">
      <label>Base URL</label>
      <input type="text" id="mla-baseUrl" />
      <div class="description">API 服务地址</div>
    </div>

    <div class="setting-item">
      <label>API Key</label>
      <input type="text" id="mla-apiKey" />
      <div class="description">API 密钥</div>
    </div>

    <div class="setting-item">
      <label>Temperature</label>
      <input type="number" id="mla-temperature" min="0" max="2" step="0.1" />
      <div class="description">生成温度（0-2）</div>
    </div>

    <div class="setting-item">
      <label>Max Tokens</label>
      <input type="number" id="mla-maxTokens" min="0" />
      <div class="description">最大生成 token 数（0=不限制）</div>
    </div>

    <div class="setting-item">
      <label>Max Context Window</label>
      <input type="number" id="mla-maxContextWindow" min="1000" />
      <div class="description">上下文窗口大小</div>
    </div>

    <div class="setting-item">
      <label>模型列表（需要 openai/ 前缀）</label>
      <div class="description" style="margin-bottom: 10px;">
        示例：openai/anthropic/claude-haiku-4.5<br>
        注意：Chatbot 会自动去掉 openai/ 前缀调用
      </div>
      <div id="models-container"></div>
      <button onclick="addModel()">➕ 添加模型</button>
    </div>

    <button onclick="saveMlaConfig()" style="background: var(--vscode-button-background); margin-top: 15px;">💾 保存所有 MLA 配置</button>
  </div>

  <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--vscode-panel-border); font-size: 0.9em; opacity: 0.7;">
    <p>💡 提示：</p>
    <ul>
      <li>Chatbot 默认使用第一个模型</li>
      <li>修改后需要重新加载扩展才能生效</li>
      <li>其他配置（上下文轮次、历史数量等）已优化默认值</li>
    </ul>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentConfig = {};
    let mlaModels = [];

    // 页面加载时获取配置
    vscode.postMessage({ type: 'getConfig' });

    // 接收配置数据
    window.addEventListener('message', event => {
      const data = event.data;
      
      if (data.type === 'config') {
        currentConfig = data.data;
        loadConfig(data.data);
      }
    });

    function loadConfig(config) {
      // MLA
      document.getElementById('mla-baseUrl').value = config.mla.baseUrl || '';
      document.getElementById('mla-apiKey').value = config.mla.apiKey === '***已设置***' ? '' : config.mla.apiKey || '';
      document.getElementById('mla-temperature').value = config.mla.temperature || 0;
      document.getElementById('mla-maxTokens').value = config.mla.max_tokens || 0;
      document.getElementById('mla-maxContextWindow').value = config.mla.max_context_window || 200000;
      
      // 模型列表
      mlaModels = config.mla.models || [];
      renderModelsList();
    }

    function saveMlaConfig() {
      const config = {
        base_url: document.getElementById('mla-baseUrl').value,
        api_key: document.getElementById('mla-apiKey').value,
        temperature: parseFloat(document.getElementById('mla-temperature').value),
        max_tokens: parseInt(document.getElementById('mla-maxTokens').value),
        max_context_window: parseInt(document.getElementById('mla-maxContextWindow').value),
        models: mlaModels
      };
      
      vscode.postMessage({ type: 'saveMlaConfig', config });
    }

    function renderModelsList() {
      const container = document.getElementById('models-container');
      container.innerHTML = '';
      
      mlaModels.forEach((model, index) => {
        const div = document.createElement('div');
        div.className = 'model-item';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = model;
        input.onchange = (e) => updateModel(index, e.target.value);
        
        const btn = document.createElement('button');
        btn.textContent = '删除';
        btn.onclick = () => removeModel(index);
        
        div.appendChild(input);
        div.appendChild(btn);
        container.appendChild(div);
      });
    }

    function addModel() {
      mlaModels.push('openai/anthropic/claude-haiku-4.5');
      renderModelsList();
    }

    function updateModel(index, value) {
      mlaModels[index] = value;
    }

    function removeModel(index) {
      mlaModels.splice(index, 1);
      renderModelsList();
    }

  </script>
</body>
</html>`;
  }
}

