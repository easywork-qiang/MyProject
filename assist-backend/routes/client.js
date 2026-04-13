/**
 * 客户端 API
 *
 * GET  /api/client/manifest  - 获取客户端可见的 manifest（过滤 draft 插件）
 * POST /api/client/heartbeat - 客户端心跳上报
 */

const express = require('express');
const db = require('../database');
const manifest = require('../services/manifest');

const router = express.Router();

/**
 * GET /api/client/manifest
 * 返回客户端可见的 manifest（从内存读取，零 IO）
 */
router.get('/manifest', (req, res) => {
    res.json(manifest.readRef());
});

/**
 * POST /api/client/heartbeat
 * 接收客户端心跳数据
 */
router.post('/heartbeat', (req, res) => {
    try {
        const { userInfo, platform, coreComponents, plugins } = req.body;

        // 使用 userInfo.id 作为主键，避免重复创建用户
        const userId = userInfo?.id;
        if (!userId) {
            return res.status(400).json({ error: '缺少 userInfo.id' });
        }

        const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        // SQLite UPSERT：用 INSERT OR REPLACE（user_id TEXT PRIMARY KEY 触发覆盖）
        db.run(`
            INSERT INTO client_user (user_id, user_name, portrait, dept_name, company_id, company_name, platform, core_components, plugin_config, last_heartbeat, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        `, [
            userId,
            userInfo?.name || null,
            userInfo?.portrait || null,
            userInfo?.deptName || null,
            userInfo?.companyId || null,
            userInfo?.companyName || null,
            platform || null,
            coreComponents ? JSON.stringify(coreComponents) : null,
            plugins ? JSON.stringify(plugins) : null,
            ip
        ]);

        res.json({
            ok: true,
            serverTime: new Date().toISOString(),
        });

    } catch (err) {
        console.error('[Client] 心跳处理失败:', err);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

module.exports = router;
