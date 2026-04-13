/**
 * 配置管理
 * 统一管理所有配置项，提供默认值
 */

const path = require('path');
const dotenv = require('dotenv');

// 优先加载环境特有配置
const envFile = process.env.NODE_ENV === 'development' ? '.env.development' : '.env';
// 兜底加载 .env
if (envFile !== '.env') {
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
}
// 特有配置覆盖
dotenv.config({ path: path.join(__dirname, '..', envFile), override: true });

/**
 * 解析提示词字符串：将 .env 中的 \\n 转为真实换行符
 */
function parsePrompt(str) {
  if (!str) return "";
  return str.replace(/\\n/g, "\n");
}

// ---------- 默认提示词（当 .env 未配置时使用）----------

const DEFAULT_SUMMARY_SYSTEM =
  "你是一个群聊消息分析助手。你的任务是对群聊消息进行总结，提炼关键信息。\n要求：\n- 使用简洁的中文\n- 总结应简明扼要，突出重点，不超过200字\n- 结构化输出，使用 emoji 标记";

const DEFAULT_SUMMARY_USER =
  "以下是群聊「{groupName}」的最近 {messageCount} 条消息记录，请总结群聊的最新动态和讨论要点：\n\n{rawMessages}\n\n请总结以下内容：\n1. 📋 讨论主题（有哪些主要话题）\n2. 📌 关键信息（重要的决定、通知等）\n3. 📊 活跃度（参与讨论的人数和频率）\n4. ⏳ 待办事项（如果有的话）";

const DEFAULT_WORKLOG_SYSTEM =
  "你是一个工作日志助手。你的任务是根据用户当天的即时通讯聊天记录，提炼出用户今天参与了哪些工作，生成结构化的工作日志摘要。\n要求：\n- 使用简洁的中文\n- 按工作事项分类整理\n- 突出重要决策和结论\n- 提取待办事项\n- 输出结构化、易读的格式，使用 emoji 标记";

const DEFAULT_WORKLOG_USER =
  "以下是我在 {date} 的即时通讯消息记录，涉及 {conversationCount} 个会话，共 {messageCount} 条消息：\n\n{rawMessages}\n\n请根据这些消息，总结我今天的工作内容，生成一份工作日志：\n1. 📋 今日主要工作（列出参与的工作事项）\n2. 📌 关键决策和结论\n3. 💬 重要沟通记录\n4. ⏳ 待跟进事项\n5. 📝 一句话日报总结";

const config = {
  // 服务
  port: parseInt(process.env.PORT, 10) || 8080,
  nodeEnv: process.env.NODE_ENV || "development",

  // 限流
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 30,
  },

  // API 鉴权
  apiKey: process.env.API_KEY || "",
  adminKey: process.env.ADMIN_KEY || "",

  // 管理后台
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  sessionSecret: process.env.SESSION_SECRET || "change-me-to-random-string",
  sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE, 10) || 24,

  // 客户端心跳
  clientOfflineThreshold: parseInt(process.env.CLIENT_OFFLINE_THRESHOLD, 10) || 7200,

  // LLM
  llm: {
    apiKey: process.env.LLM_API_KEY || "",
    baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com",
    model: process.env.LLM_MODEL || "deepseek-chat",
    timeout: (parseInt(process.env.LLM_TIMEOUT, 10) || 60) * 1000,
    maxConcurrency: parseInt(process.env.LLM_MAX_CONCURRENCY, 10) || 10,
  },

  // 缓存
  cacheTTL: parseInt(process.env.CACHE_TTL, 10) || 300,

  // 提示词（按场景组织，后续新增场景在此扩展）
  prompts: {
    // 群聊 AI 总结
    summary: {
      system: parsePrompt(process.env.PROMPT_SUMMARY_SYSTEM) || DEFAULT_SUMMARY_SYSTEM,
      user: parsePrompt(process.env.PROMPT_SUMMARY_USER) || DEFAULT_SUMMARY_USER,
    },
    // AI 备忘录生成
    memo: {
      system: parsePrompt(process.env.PROMPT_MEMO_SYSTEM) || '',
      user: parsePrompt(process.env.PROMPT_MEMO_USER) || '',
    },
    // 工作日志总结
    workLog: {
      system: parsePrompt(process.env.PROMPT_WORKLOG_SYSTEM) || DEFAULT_WORKLOG_SYSTEM,
      user: parsePrompt(process.env.PROMPT_WORKLOG_USER) || DEFAULT_WORKLOG_USER,
    },
  },
};

module.exports = config;

