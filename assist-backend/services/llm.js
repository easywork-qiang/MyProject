/**
 * LLM 服务封装
 * 统一封装大语言模型调用，支持 OpenAI 兼容格式的所有供应商
 */

const OpenAI = require('openai');
const config = require('../config');

// 初始化 OpenAI 客户端（兼容所有 OpenAI 格式 API）
const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    timeout: config.llm.timeout,
});

// ---------- 轻量并发限制器（CJS 兼容）----------
const maxConcurrency = config.llm.maxConcurrency;
let running = 0;
const waiting = [];

function enqueue(fn) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            running++;
            try {
                resolve(await fn());
            } catch (e) {
                reject(e);
            } finally {
                running--;
                if (waiting.length > 0) {
                    waiting.shift()();
                }
            }
        };
        if (running < maxConcurrency) {
            run();
        } else {
            waiting.push(run);
        }
    });
}

/**
 * 调用 LLM 生成总结
 * @param {Array} messages - OpenAI 格式的 messages 数组
 * @param {Object} options - 额外选项
 * @returns {Object} OpenAI 格式的响应
 */
async function chatCompletion(messages, options = {}) {
    return enqueue(async () => {
        const startTime = Date.now();

        console.log(`[LLM] 开始调用 ${config.llm.model}，队列中等待: ${waiting.length}`);

        const maxRetries = 1;
        let attempt = 0;
        
        while (attempt <= maxRetries) {
            try {
                const response = await client.chat.completions.create({
                    model: options.model || config.llm.model,
                    messages,
                    temperature: options.temperature ?? 0.7,
                    max_tokens: options.maxTokens || 1024,
                }, {
                    timeout: 20000 // 服务端最大20s超时
                });

                const elapsed = Date.now() - startTime;
                const usage = response.usage;
                console.log(`[LLM] ✅ 调用完成 (${elapsed}ms) [尝试 ${attempt + 1}]，tokens: ${usage?.total_tokens || 'N/A'}`);

                return response;
            } catch (error) {
                attempt++;
                const elapsed = Date.now() - startTime;
                console.error(`[LLM] ❌ 调用失败 (${elapsed}ms) [尝试 ${attempt}]:`, error.message);
                
                const isTimeout = error.name === 'APITimeoutError' || error.message.toLowerCase().includes('timeout') || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
                
                if (isTimeout && attempt <= maxRetries) {
                    console.log(`[LLM] ⚠️ 触发超时重试 [第 ${attempt} 次重试]...`);
                    continue;
                }
                throw error;
            }
        }
    });
}

/**
 * 获取 LLM 服务状态
 */
function getStatus() {
    return {
        model: config.llm.model,
        baseURL: config.llm.baseURL,
        configured: !!config.llm.apiKey,
        queueRunning: running,
        queueWaiting: waiting.length,
    };
}

module.exports = {
    chatCompletion,
    getStatus,
};
