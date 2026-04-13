/**
 * AI 总结接口
 * POST /api/ai/summary
 *
 * 接收群聊原始消息数据，在服务端构建提示词并调用 LLM 生成摘要，带服务端缓存
 */

const express = require('express');
const config = require('../config');
const llm = require('../services/llm');
const aiCache = require('../middleware/ai-cache');

const router = express.Router();

// ======================== 提示词模板（从 .env 配置读取）========================

/**
 * 构建用户提示词：将模板中的占位符替换为实际值
 * 模板支持的占位符：{groupName}、{messageCount}、{rawMessages}
 */
function buildUserPrompt(groupName, rawMessages, messageCount) {
    const template = config.prompts.summary.user;
    return template
        .replace(/\{groupName\}/g, groupName)
        .replace(/\{messageCount\}/g, messageCount)
        .replace(/\{rawMessages\}/g, rawMessages);
}

/**
 * POST /api/ai/summary
 *
 * 请求体：
 * {
 *   groupId: 'xxx',           // 群组 ID
 *   groupName: '群名称',      // 群组名称
 *   messageCount: 50,         // 消息总数
 *   rawMessages: '...'        // 已格式化的消息文本（含真实用户名）
 * }
 *
 * 响应体：
 * {
 *   summary: '...',
 *   choices: [{ message: { role: 'assistant', content: '...' } }],
 *   cached: true/false,
 *   usage: { ... }
 * }
 */
router.post('/summary',
    aiCache({ prefix: 'summary', keyBuilder: (req) => req.body.groupId || 'unknown' }),
    async (req, res, next) => {
    try {
        const { groupId, groupName, messageCount, rawMessages } = req.body;
        const uId = req.headers['x-user-id'] || 'unknown';

        // --- 参数校验 ---
        if (!rawMessages) {
            return res.status(400).json({
                error: '缺少 rawMessages 参数',
                code: 'INVALID_PARAMS',
            });
        }

        const gId = groupId || 'unknown';
        const gName = groupName || gId;
        const msgCount = messageCount || 0;

        console.log(`[AI Summary] 收到总结请求 - 用户:${uId}，群:${gName}(${gId})，消息数:${msgCount}`);

        // --- 检查 LLM 配置 ---
        if (!config.llm.apiKey) {
            return res.status(503).json({
                error: 'LLM 服务未配置，请在 .env 中设置 LLM_API_KEY',
                code: 'LLM_NOT_CONFIGURED',
            });
        }

        // --- 在服务端构建提示词 ---
        const messages = [
            { role: 'system', content: config.prompts.summary.system },
            { role: 'user', content: buildUserPrompt(gName, rawMessages, msgCount) },
        ];

        // --- 调用 LLM（限制生成长度以保持总结简洁）---
        const response = await llm.chatCompletion(messages, { maxTokens: 512 });
        const content = response.choices?.[0]?.message?.content || '';

        const result = {
            summary: content,
            choices: response.choices,
            usage: response.usage,
        };

        console.log(`[AI Summary] ✅ 总结完成 - 用户:${uId}，群:${gId}`);

        // 直接返回，缓存由 aiCache 中间件自动处理
        res.json(result);

    } catch (error) {
        // LLM 特定错误处理
        if (error.status === 429) {
            return res.status(429).json({
                error: 'AI 服务请求过于频繁，请稍后重试',
                code: 'RATE_LIMITED',
            });
        }
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return res.status(502).json({
                error: 'AI 服务连接失败，请检查 LLM_BASE_URL 配置',
                code: 'LLM_UNREACHABLE',
            });
        }
        next(error);
    }
});

/**
 * GET /api/ai/status
 * 获取 AI 服务状态
 */
router.get('/status', (req, res) => {
    const cacheStats = aiCache.getCacheStats();
    res.json({
        llm: llm.getStatus(),
        cache: {
            keys: aiCache.getCacheKeys().length,
            hits: cacheStats.hits,
            misses: cacheStats.misses,
            ttl: config.cacheTTL,
        },
    });
});

module.exports = router;

