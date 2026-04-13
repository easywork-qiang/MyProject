/**
 * AI API 调用追踪中间件
 *
 * 记录 /api/ai/* 路由的调用信息到 api_usage 表
 */

const db = require('../database');

function apiTracker(req, res, next) {
    const startTime = Date.now();

    // 拦截响应完成事件
    res.on('finish', () => {
        try {
            const duration = Date.now() - startTime;
            // 异步写入，不阻塞响应
            db.run(
                `INSERT INTO api_usage (endpoint, client_id, user_id, status, duration_ms, error_message) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    req.path,
                    req.headers['x-client-id'] || null,
                    req.headers['x-user-id'] || null,
                    res.statusCode < 400 ? 'success' : 'error',
                    duration,
                    res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
                ]
            ).catch(err => {
                console.error('[APITracker] 记录失败:', err.message);
            });
        } catch (err) {
            console.error('[APITracker] 记录失败:', err.message);
        }
    });

    next();
}

module.exports = apiTracker;
