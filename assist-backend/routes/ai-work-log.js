/**
 * AI 工作日志总结接口
 * POST /api/ai/work-log
 *
 * 接收当日 IM 消息记录，在服务端构建提示词并调用 LLM 生成工作日志摘要
 */

const express = require('express');
const config = require('../config');
const llm = require('../services/llm');
const aiCache = require('../middleware/ai-cache');

const router = express.Router();

/**
 * 构建用户提示词
 */
function buildUserPrompt(date, rawMessages, messageCount, conversationCount) {
    const template = config.prompts.workLog.user;
    return template
        .replace(/\{date\}/g, date)
        .replace(/\{messageCount\}/g, messageCount)
        .replace(/\{conversationCount\}/g, conversationCount)
        .replace(/\{rawMessages\}/g, rawMessages);
}

/**
 * POST /api/ai/work-log
 *
 * 请求体：
 * {
 *   date: '2026-03-14',
 *   rawMessages: '...',
 *   messageCount: 45,
 *   conversationCount: 8
 * }
 */
router.post('/work-log',
    aiCache({ prefix: 'worklog', keyBuilder: (req) => req.body.date || new Date().toISOString().split('T')[0] }),
    async (req, res, next) => {
    try {
        const { date, rawMessages, messageCount, conversationCount } = req.body;
        const uId = req.headers['x-user-id'] || 'unknown';

        if (!rawMessages) {
            return res.status(400).json({
                error: '缺少 rawMessages 参数',
                code: 'INVALID_PARAMS',
            });
        }

        const dateStr = date || new Date().toISOString().split('T')[0];
        const msgCount = messageCount || 0;
        const convCount = conversationCount || 0;

        console.log(`[AI WorkLog] 收到请求 - 用户:${uId}，日期:${dateStr}，消息数:${msgCount}，会话数:${convCount}`);

        // 检查 LLM 配置
        if (!config.llm.apiKey) {
            return res.status(503).json({
                error: 'LLM 服务未配置，请在 .env 中设置 LLM_API_KEY',
                code: 'LLM_NOT_CONFIGURED',
            });
        }

        // 构建提示词
        const messages = [
            { role: 'system', content: config.prompts.workLog.system },
            { role: 'user', content: buildUserPrompt(dateStr, rawMessages, msgCount, convCount) },
        ];

        // 调用 LLM
        const response = await llm.chatCompletion(messages, { maxTokens: 1024 });
        const content = response.choices?.[0]?.message?.content || '';

        const result = {
            summary: content,
            choices: response.choices,
            usage: response.usage,
        };

        console.log(`[AI WorkLog] ✅ 总结完成 - 用户:${uId}，日期:${dateStr}`);

        // 直接返回，缓存由 aiCache 中间件自动处理
        res.json(result);

    } catch (error) {
        if (error.status === 429) {
            return res.status(429).json({
                error: 'AI 服务请求过于频繁，请稍后重试',
                code: 'RATE_LIMITED',
            });
        }
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            return res.status(502).json({
                error: 'AI 服务连接失败',
                code: 'LLM_UNREACHABLE',
            });
        }
        next(error);
    }
});

module.exports = router;
