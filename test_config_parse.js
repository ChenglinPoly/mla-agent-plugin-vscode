#!/usr/bin/env node
const { spawn } = require('child_process');

// 测试解析 mla-agent 配置
function parseMlaConfig(configText) {
  const config = { models: [], temperature: 0, max_tokens: 0, max_context_window: 200000 };
  const lines = configText.split('\n');
  let inModelsSection = false;
  const models = [];

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
      let model = line.trim().substring(1).trim();
      // 清理引号和转义
      model = model.replace(/^["']+|["']+$/g, '');
      model = model.replace(/\\"/g, '');
      model = model.replace(/\\\\/g, '');
      models.push(model);
    } else if (inModelsSection && line.trim() && !line.trim().startsWith('-')) {
      inModelsSection = false;
      config.models = models;
    }
  }

  if (inModelsSection && models.length > 0) {
    config.models = models;
  }

  // 去掉 openai/ 前缀
  config.models = config.models.map(model => {
    if (model.startsWith('openai/')) {
      return model.substring('openai/'.length);
    }
    return model;
  });

  return config;
}

// 运行测试
const proc = spawn('mla-agent', ['--config-show']);
let output = '';

proc.stdout.on('data', (data) => {
  output += data.toString();
});

proc.on('close', () => {
  console.log('=== 原始配置 ===');
  console.log(output);
  
  console.log('\n=== 解析结果 ===');
  const config = parseMlaConfig(output);
  console.log(JSON.stringify(config, null, 2));
  
  console.log('\n=== 最终使用的模型 ===');
  console.log('模型:', config.models[0]);
  console.log('是否包含 openai/ 前缀:', config.models[0]?.includes('openai/') ? '是' : '否');
});

