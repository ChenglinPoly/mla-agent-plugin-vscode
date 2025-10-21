import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';

/**
 * LLM 配置
 */
interface LLMConfig {
  base_url: string;
  api_key: string;
  models: string[];
  temperature: number;
}

/**
 * LLM Service
 * 读取 mla-agent 配置，调用 LLM
 */
export class LLMService {
  private config?: LLMConfig;
  private systemPrompt = `你是 MLA Chatbot，一个集成在 VS Code 中的 AI 科研助手。
## 你的能力

1. **直接回答**：一般性问题、咨询、解释概念等（任何任务都应该真实的调用agent 进行!）
2. **调用 MLA Agent**：执行具体任务（文件操作、代码编写、论文写作、数据分析等）

## 可用的 MLA Agents

### writing_agent（默认，全流程科研助手）
- **职责**：学术论文写作全流程
- **能力**：文献收集、实验设计、代码实现、数据可视化、论文撰写
- **适用场景**：综合性任务、学术论文、研究报告、一般性查询

### data_collection_agent（文献收集）
- **职责**：收集学术文献和网页资料
- **适用场景**：文献综述、资料收集

### get_idea_and_experiment_plan（实验设计）
- **职责**：生成研究方向和实验方案
- **适用场景**：实验规划、研究设计、用户探讨研究想法时（基于已经通过data_collection_agent手收集了部分资料或者用户提供资料）

### coder_agent（代码实现）
- **职责**：完成编程和实验代码
- **适用场景**：代码实现、算法编程

### data_to_figures_agent（数据可视化）
- **职责**：将数据转换为学术图表
- **适用场景**：实验结果可视化

### material_to_document_agent（文档撰写）
- **职责**：整合材料为学术文档
- **适用场景**：论文撰写、技术报告

## 响应格式

### 如果是简单问答
直接回答，不添加任何标记。

### 如果需要调用 MLA Agent
先输出你对用户的回复，然后使用 XML 标签调用：

<mla_call>
  <action>CALL_MLA</action>
  <agent_name>选择的agent名称</agent_name>
  <refined_input>优化后的任务描述</refined_input>
</mla_call>

示例：
我将帮您查看文件列表。
<mla_call>
  <action>CALL_MLA</action>
  <agent_name>writing_agent</agent_name>
  <refined_input>查看当前目录的所有文件和子目录，列出详细信息</refined_input>
</mla_call>

注意：
- XML 前面的文本会显示给用户
- 不需要 <response> 标签（直接在 XML 前面写）
- <refined_input> 可以基于历史优化任务描述

**重要**：
- 每次 MLA 执行完成后，你会收到结果反馈
- 基于结果决定是否继续调用下一个 agent
- 可以串行调用多个 agent

示例（串行调用）：
用户："写一份 A* 算法的报告，不需要参考文献"

第1次：调用 coder_agent 实现代码
第2次（收到结果后）：调用 material_to_document_agent 写报告
第3次（收到结果后）：输出总结，不再调用`;

  constructor(private readonly outputChannel: vscode.OutputChannel) {
    this.loadConfig();
  }

  /**
   * 加载 mla-agent 配置
   */
  private async loadConfig(): Promise<void> {
    try {
      // 调用 mla-agent --config-show 获取配置
      const configText = await this.runCommand('mla-agent', ['--config-show']);
      
      // 解析配置（简单文本解析）
      const config: Partial<LLMConfig> = {
        models: [], // 从配置文件读取
        temperature: 0
      };

      const lines = configText.split('\n');
      let inModelsSection = false;
      const models: string[] = [];
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        if (line.includes('base_url:')) {
          config.base_url = line.split(':').slice(1).join(':').trim();
        } else if (line.includes('api_key:')) {
          config.api_key = line.split(':').slice(1).join(':').trim();
        } else if (line.includes('models:')) {
          inModelsSection = true;
          // 检查是否同行有值（如 models: [model1, model2] 或 models: model）
          const sameLineValue = line.split(':').slice(1).join(':').trim();
          if (sameLineValue && sameLineValue !== '') {
            try {
              // 尝试解析为 JSON 数组
              const parsed = JSON.parse(sameLineValue);
              config.models = Array.isArray(parsed) ? parsed : [parsed];
              inModelsSection = false;
            } catch {
              // 可能是单个值（无引号）
              config.models = [sameLineValue];
              inModelsSection = false;
            }
          }
        } else if (inModelsSection && trimmedLine.startsWith('-')) {
          // YAML 多行列表项
          let modelName = trimmedLine.substring(1).trim();
          // 清理所有引号和转义
          modelName = modelName.replace(/^["']+|["']+$/g, '');  // 移除首尾引号
          modelName = modelName.replace(/\\"/g, '');  // 移除转义的引号
          modelName = modelName.replace(/\\\\/g, '');  // 移除反斜杠
          if (modelName) {
            models.push(modelName);
          }
        } else if (inModelsSection && trimmedLine && !trimmedLine.startsWith('-')) {
          // 遇到非列表项，结束 models 解析
          inModelsSection = false;
          if (models.length > 0) {
            config.models = models;
          }
        } else if (line.includes('temperature:')) {
          config.temperature = parseFloat(line.split(':')[1]?.trim() || '0');
          if (inModelsSection && models.length > 0) {
            config.models = models;
            inModelsSection = false;
          }
        }
      }
      
      // 如果最后还在 models 区域，保存结果
      if (inModelsSection && models.length > 0) {
        config.models = models;
      }
      
      // 清洗模型名称：去掉 openai/ 前缀（MLA 配置的特殊格式）
      if (config.models && Array.isArray(config.models)) {
        config.models = config.models.map(model => {
          // 去掉开头的 openai/ 前缀
          if (model.startsWith('openai/')) {
            return model.substring('openai/'.length);
          }
          return model;
        });
      }
      
      this.outputChannel.appendLine(`[LLM] 解析后的模型列表: ${JSON.stringify(config.models)}`);

      if (config.base_url && config.api_key) {
        this.config = config as LLMConfig;
        this.outputChannel.appendLine(`[LLM] 配置加载成功: ${config.base_url}`);
      } else {
        this.outputChannel.appendLine('[LLM] 配置不完整，请运行: mla-agent --config-set api_key "YOUR_KEY"');
      }

    } catch (error) {
      this.outputChannel.appendLine(`[LLM] 配置加载失败: ${error}`);
    }
  }

  /**
   * 调用 LLM（流式）
   */
  async *chat(messages: Array<{role: string, content: string}>): AsyncGenerator<string> {
    if (!this.config) {
      yield '⚠️ LLM 配置未加载，请确保已设置 API Key';
      return;
    }

    // 检查是否有用户自定义的模型
    const customModel = (await import('vscode')).workspace.getConfiguration('mla').get('chatbot.model', '');
    const useModel = customModel || this.config.models[0];
    
    // 检查是否有用户自定义的温度
    const customTemp = (await import('vscode')).workspace.getConfiguration('mla').get('chatbot.temperature');
    const useTemperature = customTemp !== undefined ? customTemp : this.config.temperature;

    const fullMessages = [
      { role: 'system', content: this.systemPrompt },
      ...messages
    ];

    // 构建 API URL（处理 base_url 可能带或不带 /v1 的情况）
    let apiUrl = this.config.base_url;
    if (!apiUrl.includes('/chat/completions')) {
      // 移除末尾的斜杠
      apiUrl = apiUrl.replace(/\/$/, '');
      // 如果没有 /v1，添加它
      if (!apiUrl.endsWith('/v1')) {
        apiUrl += '/v1';
      }
      apiUrl += '/chat/completions';
    }

    this.outputChannel.appendLine(`[LLM] 调用 API: ${apiUrl}`);
    this.outputChannel.appendLine(`[LLM] 模型: ${useModel}`);
    this.outputChannel.appendLine(`[LLM] 温度: ${useTemperature}`);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const requestBody = {
        model: useModel,
        messages: fullMessages,
        temperature: useTemperature,
        stream: true
      };

      this.outputChannel.appendLine(`[LLM] 请求体: ${JSON.stringify(requestBody, null, 2).substring(0, 500)}...`);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.api_key}`
        },
        body: JSON.stringify(requestBody)
      });

      this.outputChannel.appendLine(`[LLM] 响应状态: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.outputChannel.appendLine(`[LLM] 错误详情: ${errorText}`);
        yield `⚠️ LLM 调用失败 (${response.status}): ${response.statusText}\n详情: ${errorText.substring(0, 200)}`;
        return;
      }

      reader = response.body?.getReader();
      if (!reader) {
        yield '⚠️ 无法读取响应流';
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let firstChunk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.trim() === 'data: [DONE]') continue;
          
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.slice(6));
              
              if (firstChunk) {
                this.outputChannel.appendLine(`[LLM] 首个数据块: ${JSON.stringify(json).substring(0, 200)}`);
                firstChunk = false;
              }
              
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              this.outputChannel.appendLine(`[LLM] 解析失败: ${line.substring(0, 100)}`);
            }
          }
        }
      }

      this.outputChannel.appendLine(`[LLM] 流式响应完成`);

    } catch (error: any) {
      // 捕获 terminated 错误，静默处理
      if (error.message === 'terminated' || error.name === 'AbortError') {
        this.outputChannel.appendLine(`[LLM] 流被终止（正常情况）`);
      } else {
        this.outputChannel.appendLine(`[LLM] 调用异常: ${error.message}`);
        this.outputChannel.appendLine(`[LLM] 堆栈: ${error.stack}`);
        yield `⚠️ LLM 调用错误: ${error.message}`;
      }
    } finally {
      // 确保清理 reader
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          // 忽略释放错误
        }
      }
    }
  }

  /**
   * 测试 LLM 连接
   */
  async testConnection(): Promise<{success: boolean, message: string}> {
    if (!this.config) {
      return {
        success: false,
        message: '配置未加载'
      };
    }

    try {
      let apiUrl = this.config.base_url;
      if (!apiUrl.includes('/chat/completions')) {
        apiUrl = apiUrl.replace(/\/$/, '');
        if (!apiUrl.endsWith('/v1')) {
          apiUrl += '/v1';
        }
        apiUrl += '/chat/completions';
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.api_key}`
        },
        body: JSON.stringify({
          model: this.config.models[0],
          messages: [
            { role: 'user', content: 'Hi' }
          ],
          max_tokens: 5,
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          message: `HTTP ${response.status}: ${errorText.substring(0, 200)}`
        };
      }

      const data: any = await response.json();
      
      return {
        success: true,
        message: `连接成功！模型: ${data.model || this.config.models[0]}`
      };

    } catch (error: any) {
      return {
        success: false,
        message: `连接失败: ${error.message}`
      };
    }
  }

  /**
   * 解析 LLM 响应，提取调用信息
   */
  parseResponse(response: string): {
    shouldCallMLA: boolean;
    displayText: string;
    agentName?: string;
    refinedInput?: string;
  } {
    // 检测 XML 格式的 MLA 调用
    const mlaCallMatch = response.match(/<mla_call>([\s\S]*?)<\/mla_call>/);
    
    if (mlaCallMatch) {
      try {
        const xmlContent = mlaCallMatch[1];
        
        // 提取各个字段
        const actionMatch = xmlContent.match(/<action>([\s\S]*?)<\/action>/);
        const agentNameMatch = xmlContent.match(/<agent_name>([\s\S]*?)<\/agent_name>/);
        const refinedInputMatch = xmlContent.match(/<refined_input>([\s\S]*?)<\/refined_input>/);
        
        if (actionMatch && actionMatch[1].trim() === 'CALL_MLA') {
          const agentName = agentNameMatch ? agentNameMatch[1].trim() : 'writing_agent';
          const refinedInput = refinedInputMatch ? refinedInputMatch[1].trim() : '';
          
          // displayText 是去掉 XML 后的内容（包含 XML 前面的文本）
          const displayText = response.replace(/<mla_call>[\s\S]*?<\/mla_call>/g, '').trim();
          
          this.outputChannel.appendLine(`[LLM] 检测到 MLA 调用`);
          this.outputChannel.appendLine(`[LLM] Agent: ${agentName}`);
          this.outputChannel.appendLine(`[LLM] DisplayText: ${displayText}`);
          
          return {
            shouldCallMLA: true,
            displayText,  // 返回 XML 外面的文本
            agentName,
            refinedInput
          };
        }
      } catch (error) {
        this.outputChannel.appendLine(`[LLM] XML 解析失败: ${error}`);
      }
    }
    
    // 没有检测到 MLA 调用，当作普通回复
    return {
      shouldCallMLA: false,
      displayText: response
    };
  }

  /**
   * 运行命令并返回输出
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
   * 重新加载配置
   */
  async reloadConfig(): Promise<void> {
    await this.loadConfig();
  }
}


