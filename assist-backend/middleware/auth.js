/**
 * API Key 鉴权中间件
 */

const config = require('../config');

/**
 * 客户端 API 鉴权
 * 如果 .env 中 API_KEY 为空则跳过鉴权（开发阶段友好）
 */
function apiAuth(req, res, next) {
    if (!config.apiKey) {
        return next(); // 未配置 API Key，不启用鉴权
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: '缺少认证信息', code: 'UNAUTHORIZED' });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== config.apiKey) {
        return res.status(403).json({ error: '认证失败', code: 'FORBIDDEN' });
    }

    next();
}

/**
 * 管理接口鉴权
 */
function adminAuth(req, res, next) {
    if (!config.adminKey) {
        return res.status(500).json({ error: '管理密钥未配置', code: 'ADMIN_KEY_NOT_SET' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: '缺少管理认证信息', code: 'UNAUTHORIZED' });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== config.adminKey) {
        return res.status(403).json({ error: '管理认证失败', code: 'FORBIDDEN' });
    }

    next();
}

module.exports = { apiAuth, adminAuth };
