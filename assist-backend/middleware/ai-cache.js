/**
 * AI 接口通用缓存中间件
 *
 * 类似 api-tracker.js 的设计思路，以中间件方式为 AI 接口提供统一的缓存能力。
 * 各路由只需指定 prefix + keyBuilder，缓存的读取和写入由中间件透明处理。
 *
 * 用法：
 *   const aiCache = require('../middleware/ai-cache');
 *   router.post('/summary', aiCache({ prefix: 'summary', keyBuilder: (req) => req.body.groupId }), handler);
 */

const NodeCache = require('node-cache');

// 全局共享缓存实例（所有 AI 接口共用，通过 prefix 隔离）
const cache = new NodeCache({
    stdTTL: 60,
    checkperiod: 60,
    useClones: false,
});

/**
 * 创建缓存中间件
 *
 * @param {Object} options
 * @param {string} options.prefix   - 缓存键前缀，如 'summary'、'memo'、'worklog'
 * @param {Function} options.keyBuilder - (req) => string，根据请求构建缓存键后缀
 * @param {number} [options.ttl=60] - 缓存有效时间（秒），默认 60s
 * @returns {Function} Express 中间件
 */
function aiCache({ prefix, keyBuilder, ttl = 60 }) {
    return (req, res, next) => {
        const uId = req.headers['x-user-id'] || 'unknown';
        const keySuffix = keyBuilder(req);
        const cacheKey = `${prefix}:${uId}:${keySuffix}`;

        // ---- 读缓存 ----
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log(`[AI Cache] 命中缓存 - ${prefix} - 用户:${uId}，key:${keySuffix}`);
            return res.json({ ...cached, cached: true });
        }

        // ---- 拦截 res.json()，在响应发出前自动写入缓存 ----
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // 仅缓存成功响应，且避免把已标记 cached 的结果重复写入
            if (res.statusCode < 400 && body && !body.error) {
                // 剥离 cached 标记后存入
                const { cached: _flag, ...toCache } = body;
                cache.set(cacheKey, toCache, ttl);
                console.log(`[AI Cache] 写入缓存 - ${prefix} - 用户:${uId}，key:${keySuffix}，TTL:${ttl}s`);
            }
            return originalJson(body);
        };

        next();
    };
}

// 导出缓存实例，供 /status 等接口查询统计信息
aiCache.getCacheInstance = () => cache;
aiCache.getCacheStats = () => cache.getStats();
aiCache.getCacheKeys = () => cache.keys();

module.exports = aiCache;
