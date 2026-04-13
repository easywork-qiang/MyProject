/**
 * Session 中间件配置
 *
 * 使用 express-session + MemoryStore（node-cache）
 * 单实例部署够用，无需额外交叉编译 native 模块
 */

const session = require('express-session');
const NodeCache = require('node-cache');
const config = require('../config');

// 内存 Session Store（基于 node-cache）
class MemoryStore extends session.Store {
    constructor() {
        super();
        this._cache = new NodeCache({
            stdTTL: (config.sessionMaxAge || 24) * 60 * 60, // 默认 24 小时
            checkperiod: 300,                                // 每 5 分钟清理过期
            useClones: false,                                // 存对象引用，节省内存
        });
        this._cache.on('del', (key) => this.emit('destroy', key));
    }

    get(sid, callback) {
        const session = this._cache.get(sid);
        return callback(null, session || null);
    }

    set(sid, session, callback) {
        // session.maxAge 单位毫秒，转 TTL 秒
        const ttl = session.cookie?.maxAge
            ? Math.ceil(session.cookie.maxAge / 1000)
            : (config.sessionMaxAge || 24) * 3600;
        this._cache.set(sid, session, ttl);
        if (callback) callback(null);
    }

    destroy(sid, callback) {
        this._cache.del(sid);
        if (callback) callback(null);
    }

    touch(sid, session, callback) {
        // 刷新过期时间
        const ttl = session.cookie?.maxAge
            ? Math.ceil(session.cookie.maxAge / 1000)
            : (config.sessionMaxAge || 24) * 3600;
        this._cache.ttl(sid, ttl);
        if (callback) callback(null);
    }
}

const sessionMiddleware = session({
    store: new MemoryStore(),
    secret: config.sessionSecret || 'default-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: (config.sessionMaxAge || 24) * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
    },
    name: 'assist.sid',
});

/**
 * 登录检查中间件
 */
function requireLogin(req, res, next) {
    if (req.session && req.session.admin) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
    }
    res.redirect('/admin/login');
}

module.exports = { sessionMiddleware, requireLogin };
