#!/usr/bin/env node
/**
 * 测试 parseResponse 函数
 */

// 模拟 parseResponse 函数（XML 版本）
function parseResponse(response) {
  // 检测 XML 格式的 MLA 调用
  const mlaCallMatch = response.match(/<mla_call>([\s\S]*?)<\/mla_call>/);
  
  if (mlaCallMatch) {
    try {
      const xmlContent = mlaCallMatch[1];
      
      // 提取各个字段
      const responseMatch = xmlContent.match(/<response>([\s\S]*?)<\/response>/);
      const actionMatch = xmlContent.match(/<action>([\s\S]*?)<\/action>/);
      const agentNameMatch = xmlContent.match(/<agent_name>([\s\S]*?)<\/agent_name>/);
      const refinedInputMatch = xmlContent.match(/<refined_input>([\s\S]*?)<\/refined_input>/);
      
      if (actionMatch && actionMatch[1].trim() === 'CALL_MLA') {
        const displayText = responseMatch ? responseMatch[1].trim() : '正在调用 MLA Agent...';
        const agentName = agentNameMatch ? agentNameMatch[1].trim() : 'writing_agent';
        const refinedInput = refinedInputMatch ? refinedInputMatch[1].trim() : '';
        
        console.log(`✅ 检测到 MLA 调用`);
        
        return {
          shouldCallMLA: true,
          displayText,
          agentName,
          refinedInput
        };
      }
    } catch (error) {
      console.log(`XML 解析失败: ${error.message}`);
    }
  }
  
  // 没有检测到 MLA 调用，当作普通回复
  // 去掉可能残留的 XML 标签
  let cleanResponse = response;
  if (mlaCallMatch) {
    cleanResponse = response.replace(/<mla_call>[\s\S]*?<\/mla_call>/, '').trim();
  }
  
  return {
    shouldCallMLA: false,
    displayText: cleanResponse || response
  };
}

// 测试用例1：XML 格式（多行）
const response1 = `我将为您在 upload 文件夹中创建一个包含"测试"内容的 txt 文本文件。
<mla_call>
<response>我将为您在 upload 文件夹中创建一个包含"测试"内容的 txt 文本文件</response>
<action>CALL_MLA</action>
<agent_name>writing_agent</agent_name>
<refined_input>在 upload 文件夹中创建一个新的 txt 文本文件，文件名为 test.txt，内容为：测试</refined_input>
</mla_call>`;

console.log('========== 测试 1: XML 多行格式 ==========');
const result1 = parseResponse(response1);
console.log('shouldCallMLA:', result1.shouldCallMLA);
console.log('displayText:', result1.displayText);
console.log('agentName:', result1.agentName);
console.log('refinedInput:', result1.refinedInput);

// 测试用例2：XML 格式（单行）
const response2 = `<mla_call><response>我将帮您查看文件</response><action>CALL_MLA</action><agent_name>writing_agent</agent_name><refined_input>查看当前目录所有文件</refined_input></mla_call>`;

console.log('\n========== 测试 2: XML 单行格式 ==========');
const result2 = parseResponse(response2);
console.log('shouldCallMLA:', result2.shouldCallMLA);
console.log('displayText:', result2.displayText);
console.log('agentName:', result2.agentName);

// 测试用例3：普通回复
const response3 = `深度学习是机器学习的一个分支...`;

console.log('\n========== 测试 3: 普通回复 ==========');
const result3 = parseResponse(response3);
console.log('shouldCallMLA:', result3.shouldCallMLA);
console.log('displayText:', result3.displayText);

// 测试用例4：response 前有文本
const response4 = `好的，我来帮您处理。
<mla_call>
<response>我将创建文件</response>
<action>CALL_MLA</action>
<agent_name>writing_agent</agent_name>
<refined_input>创建测试文件</refined_input>
</mla_call>`;

console.log('\n========== 测试 4: response 前有文本 ==========');
const result4 = parseResponse(response4);
console.log('shouldCallMLA:', result4.shouldCallMLA);
console.log('displayText:', result4.displayText);
console.log('cleanResponse (去掉XML后):', result4.displayText);


