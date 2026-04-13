/**
 * 管理后台页面路由
 *
 * 提供 SSR 渲染的管理后台页面（EJS 模板）
 * 包含：登录、Dashboard、用户管理、插件管理、审计日志、AI统计
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const db = require('../database');
const audit = require('../services/audit');
const stats = require('../services/stats');

const manifestService = require('../services/manifest');
const { requireLogin } = require('../middleware/session');
const { parseZipBuffer, listZipContents } = require('../utils/zip');

const router = express.Router();

const ARCHIVE_DIR = path.join(__dirname, '..', 'public', 'archive');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * 清理旧版本归档，保留最近的 maxRetain 个版本
 * 多余的数据文件和 .meta.json 一并删除
 */
function cleanupArchive(archiveDir, id, maxRetain = 10) {
    if (!fs.existsSync(archiveDir)) return;
    try {
        const files = fs.readdirSync(archiveDir)
            .filter(f => f.startsWith(`${id}-`) && !f.endsWith('.meta.json'))
            .map(f => ({
                name: f,
                path: path.join(archiveDir, f),
                stat: fs.statSync(path.join(archiveDir, f))
            }))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

        if (files.length > maxRetain) {
            const toDelete = files.slice(maxRetain);
            toDelete.forEach(file => {
                fs.unlinkSync(file.path);
                console.log(`[Admin] 🗑️ 已清理过期归档: ${file.name}`);
                const baseName = file.name.replace(/\.(js|zip)$/, '');
                const metaPath = path.join(archiveDir, `${baseName}.meta.json`);
                if (fs.existsSync(metaPath)) {
                    fs.unlinkSync(metaPath);
                    console.log(`[Admin] 🗑️ 已清理过期元信息: ${baseName}.meta.json`);
                }
            });
        }
    } catch (e) {
        console.error(`[Admin] 清理归档失败:`, e);
    }
}

// ======================== 登录限流 ========================
const loginAttempts = new Map(); // IP -> { count, firstAttempt }

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record) return true;
    if (now - record.firstAttempt > 5 * 60 * 1000) {
        loginAttempts.delete(ip);
        return true;
    }
    return record.count < 5;
}

function recordLoginAttempt(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now - record.firstAttempt > 5 * 60 * 1000) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        record.count++;
    }
}

// ======================== 密码哈希缓存 ========================
let passwordHash = null;
function getPasswordHash() {
    if (!passwordHash) {
        passwordHash = bcrypt.hashSync(config.adminPassword || 'admin', 10);
    }
    return passwordHash;
}

// ======================== 登录页面 ========================

router.get('/login', (req, res) => {
    if (req.session && req.session.admin) {
        return res.redirect('/admin/dashboard');
    }
    res.render('login', { error: null, layout: false });
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip;

    if (!checkLoginRateLimit(ip)) {
        return res.render('login', { error: '登录尝试过于频繁，请 5 分钟后再试', layout: false });
    }

    recordLoginAttempt(ip);

    const validUsername = config.adminUsername || 'admin';
    const validPasswordHash = getPasswordHash();

    if (username === validUsername && bcrypt.compareSync(password || '', validPasswordHash)) {
        req.session.admin = { username, loginAt: new Date().toISOString() };
        await audit.log({ action: 'login', operator: username, ipAddress: ip });
        loginAttempts.delete(ip); // 成功后清除限流记录
        return res.redirect('/admin/dashboard');
    }

    await audit.log({ action: 'login_failed', operator: username, ipAddress: ip, detail: { reason: '密码错误' } });
    res.render('login', { error: '用户名或密码错误', layout: false });
});

router.get('/logout', async (req, res) => {
    const admin = req.session && req.session.admin;
    if (admin) {
        await audit.log({ action: 'logout', operator: admin.username, ipAddress: req.ip });
    }
    req.session.destroy(() => {
        res.redirect('/admin/login');
    });
});

// ======================== 时间格式化工具（UTC → 中国时间） ========================
function formatChinaTime(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    // toLocaleString 使用 Asia/Shanghai 时区
    return d.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).replace(/\//g, '-');
}

// 注入 formatTime 到所有 EJS 模板
router.use((req, res, next) => {
    res.locals.formatTime = formatChinaTime;
    next();
});

// ======================== 从这里开始，所有路由需要登录 ========================
router.use(requireLogin);

router.get('/', (req, res) => {
    res.redirect('/admin/dashboard');
});

// ======================== Dashboard ========================

router.get('/dashboard', async (req, res) => {
    const overview = await stats.getOverview();
    const recentUsers = await stats.getRecentOnline(10);
    res.render('dashboard', {
        page: 'dashboard',
        admin: req.session.admin,
        overview,
        recentUsers,
    });
});

// ======================== 用户管理 ========================

router.get('/users', (req, res) => {
    res.render('users', {
        page: 'users',
        admin: req.session.admin,
    });
});

router.get('/users/:clientId', async (req, res) => {
    const client = await db.getOne('SELECT * FROM client_user WHERE user_id = ?', [req.params.clientId]);
    if (!client) {
        return res.status(404).render('error', { message: '用户不存在', page: 'users', admin: req.session.admin });
    }

    // 查询该用户最近 30 天的 AI 接口调用记录（按日期+接口聚合）
    const aiUsageDaily = await db.getAll(
        `SELECT DATE(created_at) as call_date, endpoint, COUNT(*) as call_count,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
                ROUND(AVG(duration_ms)) as avg_duration
         FROM api_usage
         WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY call_date, endpoint
         ORDER BY call_date DESC, endpoint`,
        [req.params.clientId]
    );

    // 查询该用户最近 20 条详细调用记录
    const aiUsageRecent = await db.getAll(
        `SELECT endpoint, status, duration_ms, tokens_used, error_message, created_at
         FROM api_usage
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        [req.params.clientId]
    );

    res.render('user-detail', {
        page: 'users',
        admin: req.session.admin,
        client,
        aiUsageDaily,
        aiUsageRecent,
    });
});

// ======================== 插件管理 ========================

router.get('/plugins', (req, res) => {
    const manifest = manifestService.read();

    // 计算已发布插件的文件大小
    const pluginSizes = {};
    (manifest.plugins || []).forEach(p => {
        if (p.file) {
            const filePath = path.join(PUBLIC_DIR, p.file);
            try {
                if (fs.existsSync(filePath)) {
                    pluginSizes[p.id] = fs.statSync(filePath).size;
                }
            } catch (e) { /* ignore */ }
        }
    });

    // 扫描归档目录，获取每个插件/核心组件的最新归档版本
    const latestArchiveVersions = { plugins: {}, core: {} };

    // 扫描插件归档
    const pluginArchiveDir = path.join(ARCHIVE_DIR, 'plugins');
    if (fs.existsSync(pluginArchiveDir)) {
        const pluginFiles = fs.readdirSync(pluginArchiveDir)
            .filter(f => (f.endsWith('.js') || f.endsWith('.zip')) && !f.endsWith('.meta.json'));
        for (const f of pluginFiles) {
            const match = f.match(/^(.+)-([^-]+)\.(js|zip)$/);
            if (!match) continue;
            const [, id, version] = match;
            const metaPath = path.join(pluginArchiveDir, `${id}-${version}.meta.json`);
            let pushedAt = null;
            if (fs.existsSync(metaPath)) {
                try { pushedAt = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).pushedAt; } catch (e) { /* ignore */ }
            }
            if (!pushedAt) {
                try { pushedAt = fs.statSync(path.join(pluginArchiveDir, f)).mtime.toISOString(); } catch (e) { /* ignore */ }
            }
            if (!latestArchiveVersions.plugins[id] || (pushedAt && pushedAt > latestArchiveVersions.plugins[id].pushedAt)) {
                latestArchiveVersions.plugins[id] = { version, pushedAt: pushedAt || '' };
            }
        }
    }

    // 扫描核心组件归档
    const coreArchiveDir = path.join(ARCHIVE_DIR, 'core');
    if (fs.existsSync(coreArchiveDir)) {
        const coreFiles = fs.readdirSync(coreArchiveDir)
            .filter(f => f.endsWith('.js') && !f.endsWith('.meta.json'));
        for (const f of coreFiles) {
            const match = f.match(/^(.+)-([^-]+)\.js$/);
            if (!match) continue;
            const [, id, version] = match;
            const metaPath = path.join(coreArchiveDir, `${id}-${version}.meta.json`);
            let pushedAt = null;
            if (fs.existsSync(metaPath)) {
                try { pushedAt = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).pushedAt; } catch (e) { /* ignore */ }
            }
            if (!pushedAt) {
                try { pushedAt = fs.statSync(path.join(coreArchiveDir, f)).mtime.toISOString(); } catch (e) { /* ignore */ }
            }
            if (!latestArchiveVersions.core[id] || (pushedAt && pushedAt > latestArchiveVersions.core[id].pushedAt)) {
                latestArchiveVersions.core[id] = { version, pushedAt: pushedAt || '' };
            }
        }
    }

    res.render('plugins', {
        page: 'plugins',
        admin: req.session.admin,
        manifest,
        pluginSizes,
        latestArchiveVersions,
    });
});

router.get('/plugins/push', (req, res) => {
    res.render('plugin-publish', {
        page: 'plugins',
        admin: req.session.admin,
    });
});



// ======================== AI 调用统计 ========================

router.get('/api-stats', (req, res) => {
    res.render('api-stats', {
        page: 'api-stats',
        admin: req.session.admin,
    });
});

// ======================== 审计日志 ========================

router.get('/audit-logs', (req, res) => {
    res.render('audit-logs', {
        page: 'audit-logs',
        admin: req.session.admin,
    });
});

// ======================== API 路由（AJAX 调用） ========================

// --- 用户管理 API ---
router.get('/api/users', async (req, res) => {
    const { page = 1, pageSize = 20, search, status, platform } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
        where += ' AND (user_name LIKE ? OR user_id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    if (platform) {
        where += ' AND platform = ?';
        params.push(platform);
    }

    const thresholdSeconds = config.clientOfflineThreshold || 7200;
    if (status === 'online') {
        where += ' AND last_heartbeat > DATE_SUB(NOW(), INTERVAL ? SECOND)';
        params.push(thresholdSeconds);
    } else if (status === 'offline') {
        where += ' AND (last_heartbeat IS NULL OR last_heartbeat <= DATE_SUB(NOW(), INTERVAL ? SECOND))';
        params.push(thresholdSeconds);
    }

    const totalRow = await db.getOne(`SELECT COUNT(*) as count FROM client_user ${where}`, params);
    const total = totalRow.count;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const users = await db.getAll(
        `SELECT * FROM client_user ${where} ORDER BY last_heartbeat DESC LIMIT ? OFFSET ?`,
        [...params, parseInt(pageSize), offset]
    );

    // 计算在线阈值时间（用于判断 isOnline）
    const onlineThreshold = new Date(Date.now() - thresholdSeconds * 1000);

    res.json({
        items: users.map(u => ({
            ...u,
            isOnline: u.last_heartbeat && new Date(u.last_heartbeat) > onlineThreshold,
        })),
        total,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        totalPages: Math.ceil(total / parseInt(pageSize)),
    });
});

router.get('/api/users/:clientId', async (req, res) => {
    const client = await db.getOne('SELECT * FROM client_user WHERE user_id = ?', [req.params.clientId]);
    if (!client) {
        return res.status(404).json({ error: '用户不存在' });
    }
    res.json(client);
});

// --- 统计 API ---
router.get('/api/stats/overview', async (req, res) => {
    res.json(await stats.getOverview());
});

router.get('/api/stats/plugins', async (req, res) => {
    res.json(await stats.getPluginStats());
});

router.get('/api/stats/trend', async (req, res) => {
    const days = parseInt(req.query.days) || 7;
    res.json(await stats.getActivityTrend(days));
});

router.get('/api/stats/platforms', async (req, res) => {
    res.json(await stats.getPlatformDistribution());
});

router.get('/api/stats/api-usage', async (req, res) => {
    const { period, endpoint } = req.query;
    res.json(await stats.getApiUsageStats({ period, endpoint }));
});

router.get('/api/stats/user-growth', async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    res.json(await stats.getUserGrowthTrend(days));
});

router.get('/api/stats/api-call-trend', async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    res.json(await stats.getApiCallTrend(days));
});


// --- 插件 ZIP 解析 API ---
router.post('/api/parse-zip', upload.single('file'), (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: '缺少上传文件' });

        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.zip') return res.status(400).json({ error: '仅支持 .zip 文件' });

        const entries = parseZipBuffer(file.buffer);
        const fileList = entries.map(f => f.path);
        const result = { files: fileList };

        // 优先查找 manifest.json
        const manifestEntry = entries.find(f => f.path === 'manifest.json');
        if (manifestEntry) {
            try {
                const meta = JSON.parse(manifestEntry.data.toString('utf-8'));
                result.id = meta.id || '';
                result.name = meta.name || '';
                result.version = meta.version || '';
                result.description = meta.description || '';
                result.changelog = meta.changelog || '';
                result.source = 'manifest.json';
                return res.json(result);
            } catch (e) { /* ignore */ }
        }

        // fallback: package.json
        const packageEntry = entries.find(f => f.path === 'package.json');
        if (packageEntry) {
            try {
                const pkg = JSON.parse(packageEntry.data.toString('utf-8'));
                result.id = pkg.name || '';
                result.name = pkg.displayName || pkg.name || '';
                result.version = pkg.version || '';
                result.description = pkg.description || '';
                result.changelog = '';
                result.source = 'package.json';
                return res.json(result);
            } catch (e) { /* ignore */ }
        }

        const guessId = path.basename(file.originalname, '.zip');
        result.id = guessId;
        result.name = '';
        result.version = '';
        result.description = '';
        result.changelog = '';
        result.source = 'filename';
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'ZIP 解析失败: ' + error.message });
    }
});

// --- 插件推送 API（session认证）---
router.post('/api/publish', upload.single('file'), (req, res) => {
    try {
        const { type, id, version, changelog, name, description } = req.body;
        const file = req.file;

        if (!type || !['plugin', 'core'].includes(type)) return res.status(400).json({ error: 'type 必须是 "plugin" 或 "core"' });
        if (!id) return res.status(400).json({ error: '缺少 id 参数' });
        if (!version) return res.status(400).json({ error: '缺少 version 参数' });
        if (!file) return res.status(400).json({ error: '缺少上传文件' });

        const hash = `sha256:${crypto.createHash('sha256').update(file.buffer).digest('hex')}`;

        if (type === 'core') {
            // 核心组件推送到 archive，需管理员手动选择版本发布
            const archiveDir = path.join(ARCHIVE_DIR, 'core');
            if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

            const archiveName = `${id}-${version}.js`;
            const archivePath = path.join(archiveDir, archiveName);

            // 写入归档文件
            fs.writeFileSync(archivePath, file.buffer);

            // 写入推送元信息
            const metaPath = path.join(archiveDir, `${id}-${version}.meta.json`);
            const meta = {
                id,
                version,
                hash,
                changelog: changelog || '',
                pushedAt: new Date().toISOString(),
            };
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

            // 检查是否为新组件
            const coreKey = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const currentManifest = manifestService.readRef();
            const isNew = !currentManifest.core[coreKey];

            cleanupArchive(archiveDir, id, 10);

            console.log(`[Admin] 📤 核心组件已推送: ${id} v${version}，等待发布`);
            res.json({
                message: `核心组件 ${id} v${version} 已推送，请在插件管理页选择版本发布`,
                archive: archiveName,
                hash,
                isNew,
            });
        } else {
            // 插件推送：只存储到 archive，不更新 manifest
            const ext = path.extname(file.originalname).toLowerCase();
            const isZip = ext === '.zip';

            const archiveDir = path.join(ARCHIVE_DIR, 'plugins');
            if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

            const archiveExt = isZip ? '.zip' : '.js';
            const archiveName = `${id}-${version}${archiveExt}`;
            const archivePath = path.join(archiveDir, archiveName);

            fs.writeFileSync(archivePath, file.buffer);

            let fileList = [];
            if (isZip) {
                try { fileList = listZipContents(file.buffer).map(f => f.path); } catch (e) { /* ignore */ }
            }

            // 写入推送元信息
            const metaPath = path.join(archiveDir, `${id}-${version}.meta.json`);
            const meta = {
                id,
                name: name || id,
                version,
                hash,
                format: isZip ? 'zip' : 'js',
                description: description || '',
                changelog: changelog || '',
                files: fileList,
                pushedAt: new Date().toISOString(),
            };
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

            // 检查是否为新插件
            const existingManifest = manifestService.readRef();
            const isNew = !existingManifest.plugins.find(p => p.id === id);

            cleanupArchive(archiveDir, id, 10);

            console.log(`[Admin] 📤 插件已推送: ${id} v${version} (${isZip ? 'ZIP' : 'JS'})，等待发布`);
            res.json({
                message: `插件 ${id} v${version} 已推送，请在插件管理页选择版本发布`,
                archive: archiveName,
                hash,
                format: isZip ? 'zip' : 'js',
                files: fileList,
                isNew,
            });
        }
    } catch (error) {
        console.error('[Admin] 推送失败:', error);
        res.status(500).json({ error: '推送失败: ' + error.message });
    }
});

// --- 核心组件管理 API ---
router.get('/api/core/:id/archive', (req, res) => {
    try {
        const coreArchiveDir = path.join(ARCHIVE_DIR, 'core');
        if (!fs.existsSync(coreArchiveDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(coreArchiveDir)
            .filter(f => f.startsWith(`${req.params.id}-`) && f.endsWith('.js') && !f.endsWith('.meta.json'))
            .map(f => {
                const stat = fs.statSync(path.join(coreArchiveDir, f));
                const versionMatch = f.match(new RegExp(`^${req.params.id}-(.+)\\.js$`));
                const version = versionMatch ? versionMatch[1] : 'unknown';

                // 尝试读取 .meta.json
                const metaPath = path.join(coreArchiveDir, `${req.params.id}-${version}.meta.json`);
                let meta = {};
                if (fs.existsSync(metaPath)) {
                    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) { /* ignore */ }
                }

                return {
                    filename: f,
                    version,
                    size: stat.size,
                    modifiedAt: meta.pushedAt || stat.mtime.toISOString(),
                    changelog: meta.changelog || '',
                };
            })
            .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/core/:id/publish', async (req, res) => {
    try {
        const { version } = req.body;
        if (!version) {
            return res.status(400).json({ error: '缺少 version 参数' });
        }

        const coreArchiveDir = path.join(ARCHIVE_DIR, 'core');
        const archiveFile = path.join(coreArchiveDir, `${req.params.id}-${version}.js`);

        if (!fs.existsSync(archiveFile)) {
            return res.status(404).json({ error: `版本 ${version} 的归档文件不存在` });
        }

        // 复制归档文件到 core 目录
        const targetDir = path.join(PUBLIC_DIR, 'core');
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const targetFile = path.join(targetDir, `${req.params.id}.js`);
        fs.copyFileSync(archiveFile, targetFile);

        const coreKey = req.params.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const buf = fs.readFileSync(archiveFile);
        const hash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

        // 读取 meta 获取 changelog
        let changelog = '';
        const metaPath = path.join(coreArchiveDir, `${req.params.id}-${version}.meta.json`);
        if (fs.existsSync(metaPath)) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                changelog = meta.changelog || '';
            } catch (e) { /* ignore */ }
        }

        // 更新 manifest（内存 + 持久化）
        manifestService.update(m => {
            m.core[coreKey] = {
                version,
                file: `core/${req.params.id}.js`,
                hash,
                changelog,
            };
        });

        await audit.log({
            action: 'core_publish', target: req.params.id,
            operator: req.session.admin.username,
            detail: { version },
            ipAddress: req.ip,
        });

        console.log(`[Admin] ✅ 核心组件已发布: ${req.params.id} v${version}`);
        res.json({ ok: true, message: `核心组件 ${req.params.id} 已发布 v${version}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/core/:id', async (req, res) => {
    try {
        const currentManifest = manifestService.read();
        const coreKey = req.params.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

        if (!currentManifest.core[coreKey]) {
            return res.status(404).json({ error: `核心组件 ${req.params.id} 不存在` });
        }

        const removed = currentManifest.core[coreKey];
        delete currentManifest.core[coreKey];
        manifestService.write(currentManifest);

        await audit.log({
            action: 'core_delete', target: req.params.id,
            operator: req.session.admin.username,
            detail: { version: removed.version },
            ipAddress: req.ip,
        });

        console.log(`[Admin] ✅ 核心组件已移除: ${req.params.id}`);
        res.json({ message: `核心组件 ${req.params.id} 已从 manifest 移除`, removed });
    } catch (err) {
        res.status(500).json({ error: '操作失败: ' + err.message });
    }
});

// --- 插件管理 API ---
router.get('/api/plugins/:id/archive', (req, res) => {
    try {
        const pluginArchiveDir = path.join(ARCHIVE_DIR, 'plugins');
        if (!fs.existsSync(pluginArchiveDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(pluginArchiveDir)
            .filter(f => f.startsWith(`${req.params.id}-`) && !f.endsWith('.meta.json'))
            .map(f => {
                const stat = fs.statSync(path.join(pluginArchiveDir, f));
                // 支持 .js 和 .zip 两种归档格式
                const versionMatch = f.match(new RegExp(`^${req.params.id}-(.+)\\.(js|zip)$`));
                const ext = path.extname(f);
                const version = versionMatch ? versionMatch[1] : 'unknown';

                // 尝试读取 .meta.json 获取更丰富的信息
                const metaPath = path.join(pluginArchiveDir, `${req.params.id}-${version}.meta.json`);
                let meta = {};
                if (fs.existsSync(metaPath)) {
                    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) { /* ignore */ }
                }

                return {
                    filename: f,
                    version,
                    name: meta.name || '',
                    format: ext === '.zip' ? 'zip' : 'js',
                    size: stat.size,
                    modifiedAt: meta.pushedAt || stat.mtime.toISOString(),
                    changelog: meta.changelog || '',
                };
            })
            .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/plugins/:id/rollback', async (req, res) => {
    try {
        const { version } = req.body;
        if (!version) {
            return res.status(400).json({ error: '缺少 version 参数' });
        }

        const pluginArchiveDir = path.join(ARCHIVE_DIR, 'plugins');
        
        // 尝试 .zip 和 .js 两种格式
        let archiveFile = path.join(pluginArchiveDir, `${req.params.id}-${version}.zip`);
        let archiveExt = '.zip';
        if (!fs.existsSync(archiveFile)) {
            archiveFile = path.join(pluginArchiveDir, `${req.params.id}-${version}.js`);
            archiveExt = '.js';
        }

        if (!fs.existsSync(archiveFile)) {
            return res.status(404).json({ error: `版本 ${version} 的归档文件不存在` });
        }

        // 复制归档文件到 plugins 目录
        const fileName = `${req.params.id}${archiveExt}`;
        const targetFile = path.join(__dirname, '..', 'public', 'plugins', fileName);
        fs.copyFileSync(archiveFile, targetFile);

        // 如果格式变化，清理旧格式文件
        const oldFormatExt = archiveExt === '.zip' ? '.js' : '.zip';
        const oldFormatFile = path.join(__dirname, '..', 'public', 'plugins', `${req.params.id}${oldFormatExt}`);
        if (fs.existsSync(oldFormatFile)) {
            fs.unlinkSync(oldFormatFile);
        }

        // 更新 manifest
        manifestService.update(m => {
            const plugin = m.plugins.find(p => p.id === req.params.id);
            if (plugin) {
                plugin.version = version;
                plugin.file = `plugins/${fileName}`;
                if (archiveExt === '.zip') {
                    plugin.format = 'zip';
                    plugin.entry = plugin.entry || 'main.js';
                } else {
                    delete plugin.format;
                    delete plugin.entry;
                    delete plugin.files;
                }
                // 重新计算 hash
                const buf = fs.readFileSync(archiveFile);
                plugin.hash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
            }
        });

        await audit.log({
            action: 'rollback', target: req.params.id,
            operator: req.session.admin.username,
            detail: { version, format: archiveExt.slice(1) },
            ipAddress: req.ip,
        });

        res.json({ ok: true, message: `插件 ${req.params.id} 已回滚到 v${version}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/plugins/:id', async (req, res) => {
    try {
        const currentManifest = manifestService.read();
        const index = currentManifest.plugins.findIndex(p => p.id === req.params.id);

        if (index < 0) {
            return res.status(404).json({ error: `插件 ${req.params.id} 不存在` });
        }

        const removed = currentManifest.plugins.splice(index, 1)[0];
        manifestService.write(currentManifest);

        await audit.log({
            action: 'plugin_delete', target: req.params.id,
            operator: req.session.admin.username,
            detail: { version: removed.version },
            ipAddress: req.ip,
        });

        console.log(`[Admin] ✅ 插件已移除: ${req.params.id}`);
        res.json({ message: `插件 ${req.params.id} 已从 manifest 移除`, removed });
    } catch (err) {
        res.status(500).json({ error: '操作失败: ' + err.message });
    }
});


// --- 批量发布 API（扫描归档，发布最新版本） ---
router.post('/api/publish-all', async (req, res) => {
    try {
        const results = { core: [], plugins: [], errors: [] };

        // ---- 扫描并发布核心组件 ----
        const coreArchiveDir = path.join(ARCHIVE_DIR, 'core');
        if (fs.existsSync(coreArchiveDir)) {
            // 按组件 ID 分组，找最新版本
            const coreFiles = fs.readdirSync(coreArchiveDir)
                .filter(f => f.endsWith('.js') && !f.endsWith('.meta.json'));

            const coreLatest = {};
            for (const f of coreFiles) {
                const match = f.match(/^(.+)-([^-]+)\.js$/);
                if (!match) continue;
                const [, id, version] = match;

                const metaPath = path.join(coreArchiveDir, `${id}-${version}.meta.json`);
                let pushedAt = null;
                if (fs.existsSync(metaPath)) {
                    try {
                        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                        pushedAt = meta.pushedAt;
                    } catch (e) { /* ignore */ }
                }
                if (!pushedAt) {
                    pushedAt = fs.statSync(path.join(coreArchiveDir, f)).mtime.toISOString();
                }

                if (!coreLatest[id] || pushedAt > coreLatest[id].pushedAt) {
                    coreLatest[id] = { id, version, filename: f, pushedAt };
                }
            }

            // 逐个发布
            const targetDir = path.join(PUBLIC_DIR, 'core');
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

            for (const [id, info] of Object.entries(coreLatest)) {
                try {
                    const archiveFile = path.join(coreArchiveDir, info.filename);
                    const targetFile = path.join(targetDir, `${id}.js`);
                    fs.copyFileSync(archiveFile, targetFile);

                    const coreKey = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                    const buf = fs.readFileSync(archiveFile);
                    const hash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

                    let changelog = '';
                    const metaPath = path.join(coreArchiveDir, `${id}-${info.version}.meta.json`);
                    if (fs.existsSync(metaPath)) {
                        try { changelog = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).changelog || ''; } catch (e) { /* ignore */ }
                    }

                    manifestService.update(m => {
                        m.core[coreKey] = { version: info.version, file: `core/${id}.js`, hash, changelog };
                    });
                    results.core.push({ id, version: info.version });
                } catch (e) {
                    results.errors.push({ type: 'core', id, error: e.message });
                }
            }
        }

        // ---- 扫描并发布插件 ----
        const pluginArchiveDir = path.join(ARCHIVE_DIR, 'plugins');
        if (fs.existsSync(pluginArchiveDir)) {
            const pluginFiles = fs.readdirSync(pluginArchiveDir)
                .filter(f => (f.endsWith('.js') || f.endsWith('.zip')) && !f.endsWith('.meta.json'));

            const pluginLatest = {};
            for (const f of pluginFiles) {
                const match = f.match(/^(.+)-([^-]+)\.(js|zip)$/);
                if (!match) continue;
                const [, id, version, ext] = match;

                const metaPath = path.join(pluginArchiveDir, `${id}-${version}.meta.json`);
                let pushedAt = null;
                let meta = {};
                if (fs.existsSync(metaPath)) {
                    try {
                        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                        pushedAt = meta.pushedAt;
                    } catch (e) { /* ignore */ }
                }
                if (!pushedAt) {
                    pushedAt = fs.statSync(path.join(pluginArchiveDir, f)).mtime.toISOString();
                }

                if (!pluginLatest[id] || pushedAt > pluginLatest[id].pushedAt) {
                    pluginLatest[id] = { id, version, ext, filename: f, pushedAt, meta };
                }
            }

            // 逐个发布
            const pluginsDir = path.join(PUBLIC_DIR, 'plugins');
            if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });

            for (const [id, info] of Object.entries(pluginLatest)) {
                try {
                    const archiveFile = path.join(pluginArchiveDir, info.filename);
                    const fileName = `${id}.${info.ext}`;
                    const targetFile = path.join(pluginsDir, fileName);
                    fs.copyFileSync(archiveFile, targetFile);

                    // 清理旧格式文件
                    const oldExt = info.ext === 'zip' ? 'js' : 'zip';
                    const oldFile = path.join(pluginsDir, `${id}.${oldExt}`);
                    if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);

                    const buf = fs.readFileSync(archiveFile);
                    const hash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
                    const isZip = info.ext === 'zip';

                    manifestService.update(m => {
                        let plugin = m.plugins.find(p => p.id === id);
                        if (!plugin) {
                            plugin = { id };
                            m.plugins.push(plugin);
                        }
                        plugin.name = info.meta.name || id;
                        plugin.version = info.version;
                        plugin.file = `plugins/${fileName}`;
                        plugin.hash = hash;
                        plugin.description = info.meta.description || '';
                        plugin.changelog = info.meta.changelog || '';
                        if (isZip) {
                            plugin.format = 'zip';
                            plugin.entry = info.meta.entry || 'main.js';
                            plugin.files = info.meta.files || [];
                        } else {
                            delete plugin.format;
                            delete plugin.entry;
                            delete plugin.files;
                        }
                    });
                    results.plugins.push({ id, version: info.version, format: info.ext });
                } catch (e) {
                    results.errors.push({ type: 'plugin', id, error: e.message });
                }
            }
        }

        await audit.log({
            action: 'publish_all',
            operator: req.session.admin.username,
            detail: { core: results.core.length, plugins: results.plugins.length },
            ipAddress: req.ip,
        });

        console.log(`[Admin] ✅ 批量发布完成: ${results.core.length} 核心组件, ${results.plugins.length} 插件`);
        res.json({ ok: true, ...results });
    } catch (err) {
        console.error('[Admin] 批量发布失败:', err);
        res.status(500).json({ error: '批量发布失败: ' + err.message });
    }
});

// --- 审计日志 API ---
router.get('/api/audit-logs', async (req, res) => {
    const result = await audit.query(req.query);
    res.json(result);
});

module.exports = router;
