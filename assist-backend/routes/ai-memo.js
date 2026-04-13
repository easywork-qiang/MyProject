/**
 * AI 备忘生成接口
 * POST /api/ai/memo
 *
 * 接收聊天消息内容 + 上下文聊天记录，在服务端构建提示词并调用 LLM
 * 生成备忘录条目，包括内容、发起人、截止时间
 */

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const llm = require('../services/llm');
const aiCache = require('../middleware/ai-cache');

const router = express.Router();

// ======================== 提示词 ========================

const DEFAULT_MEMO_SYSTEM =
    '你是一个智能备忘录助手。你的任务是根据聊天消息及其上下文，提取关键信息并生成结构化的备忘录条目。\n' +
    '要求：\n' +
    '- 使用简洁的中文\n' +
    '- 提炼出核心待办事项、重要信息或关键决策\n' +
    '- 如果消息涉及会议，在备忘内容中包含会议主题、会议时间、会议号等关键信息\n' +
    '- 识别消息发起人（initiator）：即发送这条消息的人，让备忘录持有者知道是谁发起的这件事\n' +
    '- 根据消息内容和上下文推断截止时间（deadline），如果无法确定则留空\n' +
    '- 输出格式为 JSON：\n' +
    '  {"content": "备忘内容（简明扼要，如涉及会议请包含会议时间和主题等信息）", "initiator": "发起人姓名", "deadline": "YYYY-MM-DDTHH:mm 或 null", "summary": "一句话概要"}\n' +
    '- 只输出 JSON，不要输出其他内容';

const DEFAULT_MEMO_USER =
    '以下是一段聊天对话的上下文和一条目标消息。请从目标消息中提取关键信息并生成备忘录，' +
    '结合上下文推断出截止时间。\n\n' +
    '--- 最近聊天记录（上下文）---\n{contextMessages}\n\n' +
    '--- 目标消息 ---\n发送者：{senderName}\n内容：{messageContent}\n\n' +
    '请根据以上信息生成备忘录 JSON。注意：\n' +
    '1. 从目标消息提取核心待办事项，如涉及会议请在内容中包含会议时间、主题、会议号等\n' +
    '2. 发起人（initiator）就是目标消息的发送者\n' +
    '3. 从消息中提取或推断截止时间（如果有提及时间的话）';

function getSystemPrompt() {
    return config.prompts.memo?.system || DEFAULT_MEMO_SYSTEM;
}

function buildUserPrompt(messageContent, senderName, contextMessages) {
    const template = config.prompts.memo?.user || DEFAULT_MEMO_USER;
    return template
        .replace(/\{messageContent\}/g, messageContent)
        .replace(/\{senderName\}/g, senderName || '未知')
        .replace(/\{contextMessages\}/g, contextMessages || '（无上下文）');
}

/**
 * POST /api/ai/memo
 *
 * 请求体：
 * {
 *   messageContent: '...',         // 目标消息文本内容
 *   senderName: '张三',            // 发送者名称
 *   contextMessages: '...',        // 最近聊天记录（已格式化文本）
 *   conversationType: 1,           // 会话类型
 *   targetId: 'xxx',               // 会话目标 ID
 * }
 *
 * 响应体：
 * {
 *   content: '备忘内容',
 *   initiator: '发起人' | '',
 *   deadline: 'YYYY-MM-DDTHH:mm' | null,
 *   summary: '一句话概要',
 *   usage: { ... }
 * }
 */
router.post('/memo',
    aiCache({
        prefix: 'memo',
        keyBuilder: (req) => {
            const targetId = req.body.targetId || 'global';
            const contentHash = crypto.createHash('md5').update(req.body.messageContent || '').digest('hex');
            return `${targetId}:${contentHash}`;
        },
    }),
    async (req, res, next) => {
    try {
        const { messageContent, senderName, contextMessages, conversationType, targetId } = req.body;
        const uId = req.headers['x-user-id'] || 'unknown';

        // --- 参数校验 ---
        if (!messageContent) {
            return res.status(400).json({
                error: '缺少 messageContent 参数',
                code: 'INVALID_PARAMS',
            });
        }

        const hasContext = contextMessages && contextMessages.trim().length > 0;
        console.log(`[AI Memo] 收到备忘生成请求 - 用户:${uId}，发送者:${senderName || '未知'}，会话:${targetId || 'N/A'}，上下文:${hasContext ? '有' : '无'}`);

        // --- 检查 LLM 配置 ---
        if (!config.llm.apiKey) {
            return res.status(503).json({
                error: 'LLM 服务未配置，请在 .env 中设置 LLM_API_KEY',
                code: 'LLM_NOT_CONFIGURED',
            });
        }

        // --- 在服务端构建提示词（含上下文） ---
        const messages = [
            { role: 'system', content: getSystemPrompt() },
            { role: 'user', content: buildUserPrompt(messageContent, senderName, contextMessages) },
        ];

        // --- 调用 LLM ---
        const response = await llm.chatCompletion(messages, { maxTokens: 512 });
        const raw = response.choices?.[0]?.message?.content || '';

        // --- 尝试解析 JSON 响应 ---
        let parsed;
        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: raw, initiator: senderName || '', deadline: null, summary: raw.slice(0, 50) };
        } catch (e) {
            console.warn('[AI Memo] JSON 解析失败，使用原始文本:', e.message);
            parsed = { content: raw, initiator: senderName || '', deadline: null, summary: raw.slice(0, 50) };
        }

        console.log(`[AI Memo] ✅ 备忘生成完成 - 发起人:${parsed.initiator || '未知'}，截止:${parsed.deadline || '未推断'}`);

        const result = {
            content: parsed.content || raw,
            initiator: parsed.initiator || senderName || '',
            deadline: parsed.deadline || null,
            summary: parsed.summary || '',
            usage: response.usage,
        };

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
                error: 'AI 服务连接失败，请检查 LLM_BASE_URL 配置',
                code: 'LLM_UNREACHABLE',
            });
        }
        next(error);
    }
});

module.exports = router;
