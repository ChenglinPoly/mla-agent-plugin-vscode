#!/usr/bin/env node
/**
 * LLM API 调用测试脚本
 * 用法：node test_llm.js
 */

const { spawn } = require('child_process');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// 从 mla-agent 读取配置
async function loadMLAConfig() {
  return new Promise((resolve, reject) => {
    const proc = spawn('mla-agent', ['--config-show']);
    let output = '';
    let error = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // 解析配置
        const config = {
          models: [],
          temperature: 0
        };

        const lines = output.split('\n');
        let inModelsSection = false;
        const models = [];
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          
          if (line.includes('base_url:')) {
            config.base_url = line.split(':').slice(1).join(':').trim();
          } else if (line.includes('api_key:')) {
            config.api_key = line.split(':').slice(1).join(':').trim();
          } else if (line.includes('models:')) {
            inModelsSection = true;
            // 检查是否同行有值（如 models: [model1, model2]）
            const sameLineValue = line.split(':').slice(1).join(':').trim();
            if (sameLineValue && sameLineValue !== '') {
              try {
                const parsed = JSON.parse(sameLineValue);
                config.models = Array.isArray(parsed) ? parsed : [parsed];
                inModelsSection = false;
              } catch {
                config.models = [sameLineValue];
                inModelsSection = false;
              }
            }
          } else if (inModelsSection && trimmedLine.startsWith('-')) {
            // YAML 多行列表项
            const modelName = trimmedLine.substring(1).trim();
            if (modelName) {
              models.push(modelName);
            }
          } else if (inModelsSection && trimmedLine && !trimmedLine.startsWith('-')) {
            // 结束 models 解析
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
        
        // 清洗模型名称：去掉 openai/ 前缀
        if (config.models && Array.isArray(config.models)) {
          config.models = config.models.map(model => {
            if (model.startsWith('openai/')) {
              return model.substring('openai/'.length);
            }
            return model;
          });
        }

        resolve(config);
      } else {
        reject(new Error(error || `Command failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

// 构建 API URL
function buildApiUrl(baseUrl) {
  let apiUrl = baseUrl;
  if (!apiUrl.includes('/chat/completions')) {
    apiUrl = apiUrl.replace(/\/$/, '');
    if (!apiUrl.endsWith('/v1')) {
      apiUrl += '/v1';
    }
    apiUrl += '/chat/completions';
  }
  return apiUrl;
}

// 测试非流式调用
async function testNonStreamingCall(config) {
  log('\n=== 测试 1: 非流式调用 ===', 'cyan');
  
  const apiUrl = buildApiUrl(config.base_url);
  log(`API URL: ${apiUrl}`, 'blue');
  log(`模型: ${config.models[0]}`, 'blue');

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`
      },
      body: JSON.stringify({
        model: config.models[0],
        messages: [
          { role: 'user', content: '用一句话介绍你自己' }
        ],
        max_tokens: 50,
        stream: false
      })
    });

    log(`响应状态: ${response.status} ${response.statusText}`, 
        response.ok ? 'green' : 'red');

    if (!response.ok) {
      const errorText = await response.text();
      log(`错误详情: ${errorText}`, 'red');
      return false;
    }

    const data = await response.json();
    log(`✅ 成功！`, 'green');
    log(`模型: ${data.model}`, 'blue');
    log(`回复: ${data.choices[0].message.content}`, 'yellow');
    log(`用量: ${JSON.stringify(data.usage)}`, 'blue');

    return true;

  } catch (error) {
    log(`❌ 错误: ${error.message}`, 'red');
    return false;
  }
}

// 测试流式调用
async function testStreamingCall(config) {
  log('\n=== 测试 2: 流式调用 ===', 'cyan');
  
  const apiUrl = buildApiUrl(config.base_url);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`
      },
      body: JSON.stringify({
        model: config.models[0],
        messages: [
          { role: 'user', content: '数到10，每个数字用逗号分隔' }
        ],
        temperature: config.temperature,
        stream: true
      })
    });

    log(`响应状态: ${response.status} ${response.statusText}`, 
        response.ok ? 'green' : 'red');

    if (!response.ok) {
      const errorText = await response.text();
      log(`错误详情: ${errorText}`, 'red');
      return false;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let chunkCount = 0;

    log('开始接收流式数据...', 'blue');
    process.stdout.write(colors.yellow);

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
            const content = json.choices?.[0]?.delta?.content;
            
            if (content) {
              process.stdout.write(content);
              fullContent += content;
              chunkCount++;
            }
          } catch (e) {
            log(`\n解析错误: ${line.substring(0, 100)}`, 'red');
          }
        }
      }
    }

    process.stdout.write(colors.reset + '\n');
    log(`\n✅ 流式调用成功！`, 'green');
    log(`接收到 ${chunkCount} 个数据块`, 'blue');
    log(`完整内容长度: ${fullContent.length} 字符`, 'blue');

    return true;

  } catch (error) {
    log(`\n❌ 错误: ${error.message}`, 'red');
    console.error(error.stack);
    return false;
  }
}

// 测试 JSON 格式响应解析
async function testJSONResponse(config) {
  log('\n=== 测试 3: JSON 格式响应解析 ===', 'cyan');
  
  const apiUrl = buildApiUrl(config.base_url);

  const systemPrompt = `你需要按以下 JSON 格式回复：
\`\`\`json
{
  "action": "CALL_MLA",
  "agent_name": "writing_agent",
  "refined_input": "优化后的任务"
}
\`\`\``;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`
      },
      body: JSON.stringify({
        model: config.models[0],
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '帮我查看当前目录的文件' }
        ],
        temperature: 0.3,
        stream: false
      })
    });

    if (!response.ok) {
      log(`❌ HTTP ${response.status}`, 'red');
      return false;
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    
    log('LLM 原始回复:', 'blue');
    log(content, 'yellow');

    // 测试 JSON 提取
    const jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n```/);
    
    if (jsonMatch) {
      log('\n✅ 成功提取 JSON 代码块', 'green');
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        log('解析结果:', 'blue');
        console.log(JSON.stringify(parsed, null, 2));
        
        if (parsed.action === 'CALL_MLA') {
          log('✅ 识别到 CALL_MLA 动作', 'green');
          log(`Agent: ${parsed.agent_name}`, 'blue');
          log(`Input: ${parsed.refined_input}`, 'blue');
        }
      } catch (e) {
        log(`❌ JSON 解析失败: ${e.message}`, 'red');
        return false;
      }
    } else {
      log('⚠️  未找到 JSON 代码块', 'yellow');
    }

    return true;

  } catch (error) {
    log(`❌ 错误: ${error.message}`, 'red');
    return false;
  }
}

// 主函数
async function main() {
  log('========================================', 'cyan');
  log('       LLM API 调用测试脚本', 'cyan');
  log('========================================', 'cyan');

  // 加载配置
  log('\n📋 加载 mla-agent 配置...', 'blue');
  let config;
  try {
    config = await loadMLAConfig();
    log('✅ 配置加载成功', 'green');
    log(`   Base URL: ${config.base_url}`, 'blue');
    log(`   模型: ${config.models.join(', ')}`, 'blue');
    log(`   Temperature: ${config.temperature}`, 'blue');
  } catch (error) {
    log(`❌ 配置加载失败: ${error.message}`, 'red');
    log('\n请确保已安装并配置 mla-agent:', 'yellow');
    log('  mla-agent --config-set api_key "YOUR_KEY"', 'yellow');
    process.exit(1);
  }

  // 运行测试
  const results = [];
  
  results.push(await testNonStreamingCall(config));
  results.push(await testStreamingCall(config));
  results.push(await testJSONResponse(config));

  // 汇总
  log('\n========================================', 'cyan');
  log('           测试结果汇总', 'cyan');
  log('========================================', 'cyan');
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  log(`通过: ${passed}/${total}`, passed === total ? 'green' : 'yellow');
  
  if (passed === total) {
    log('\n🎉 所有测试通过！', 'green');
    process.exit(0);
  } else {
    log('\n⚠️  部分测试失败', 'yellow');
    process.exit(1);
  }
}

// 运行
main().catch(error => {
  log(`\n❌ 未捕获的错误: ${error.message}`, 'red');
  console.error(error.stack);
  process.exit(1);
});

