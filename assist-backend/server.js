/**
 * rongcloud-assist 后端服务
 *
 * 提供以下能力：
 * 1. AI 群聊总结 API（POST /api/ai/summary）
 * 2. AI 备忘录 API（POST /api/ai/memo）
 * 3. AI 工作日志 API（POST /api/ai/work-log）
 * 4. 插件更新分发（静态文件 + manifest.json）
 * 5. 插件发布管理（POST /api/admin/publish）
 * 6. 健康检查（GET /api/health）
 * 7. 管理后台（/admin/*）— SSR 页面
 * 8. 客户端心跳 API（POST /api/client/heartbeat）
 */

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const fs = require('fs');

const config = require('./config');
const manifest = require('./services/manifest');

// 初始化数据库（MySQL 连接池 + 建表）
const db = require('./database');
const { initializeTables } = require('./database');

const { apiAuth, adminAuth } = require('./middleware/auth');
const errorHandler = require('./middleware/error-handler');
const { sessionMiddleware } = require('./middleware/session');
const apiTracker = require('./middleware/api-tracker');

const aiSummaryRoutes = require('./routes/ai-summary');
const aiMemoRoutes = require('./routes/ai-memo');
const aiWorkLogRoutes = require('./routes/ai-work-log');
const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health');
const dashboardRoutes = require('./routes/dashboard');
const clientRoutes = require('./routes/client');

const app = express();

// ======================== 视图引擎 ========================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ======================== 中间件 ========================

// 信任代理（获取真实 IP）
app.set('trust proxy', 1);

// 日志
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// CORS — 允许 Electron 客户端跨域访问
app.use(cors());

// 请求体解析
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session（管理后台使用）
app.use(sessionMiddleware);

// ======================== 静态文件 ========================

// 动态渲染安装脚本 — 根据请求 Host 自动填充 SERVER_URL
app.get('/scripts/:scriptName', (req, res, next) => {
    const scriptName = req.params.scriptName;
    // 仅对 install 脚本做动态渲染
    if (!['install.sh', 'install.ps1'].includes(scriptName)) {
        return next();
    }
    const scriptPath = path.join(__dirname, 'static', 'scripts', scriptName);
    if (!fs.existsSync(scriptPath)) {
        return res.status(404).send('Script not found');
    }
    // 推断服务器地址: 优先用 X-Forwarded-Proto/Host，回退到 req.protocol/req.headers.host
    const protocol = req.get('X-Forwarded-Proto') || req.protocol || 'http';
    const host = req.get('X-Forwarded-Host') || req.get('Host') || `localhost:${config.port}`;
    const serverUrl = `${protocol}://${host}`;

    let content = fs.readFileSync(scriptPath, 'utf-8');
    content = content.replace(/__SERVER_URL__/g, serverUrl);

    const contentType = scriptName.endsWith('.ps1')
        ? 'text/plain; charset=utf-8'
        : 'application/x-sh; charset=utf-8';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache');
    res.send(content);
});

// 管理后台静态资源（CSS/JS/字体，随镜像发布，不受外挂卷影响）
app.use(express.static(path.join(__dirname, 'static'), {
    maxAge: config.nodeEnv === 'production' ? '1d' : 0,
    etag: true,
}));

// manifest.json — 从内存返回（高频请求零 IO）
app.get('/manifest.json', (req, res) => {
    res.json(manifest.readRef());
});

// 动态数据目录（插件包 + 核心组件，外挂卷挂载）
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: config.nodeEnv === 'production' ? '5m' : 0,
    etag: true,
}));

// ======================== API 路由 ========================

// AI 总结接口 — 带限流 + 鉴权 + 调用追踪
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,    // 1 分钟窗口
    max: config.rateLimit.max,                // 每个 IP 每分钟最多请求数
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED' },
});

const aiMiddlewares = [apiAuth, apiTracker];
if (config.rateLimit.enabled) {
    aiMiddlewares.unshift(aiLimiter);
}

app.use('/api/ai', ...aiMiddlewares);
app.use('/api/ai', aiSummaryRoutes);
app.use('/api/ai', aiMemoRoutes);
app.use('/api/ai', aiWorkLogRoutes);

// 管理 API 接口 — 需要管理员 Key 鉴权
app.use('/api/admin', adminAuth, adminRoutes);

// 客户端心跳 API — 无鉴权（客户端自由上报）
app.use('/api/client', clientRoutes);

// 健康检查 — 无鉴权
app.use('/api/health', healthRoutes);

// ======================== 管理后台页面 ========================

// 管理后台 SSR 页面路由
app.use('/admin', dashboardRoutes);

// ======================== 错误处理 ========================

app.use(errorHandler);

// ======================== 启动服务 ========================

async function startServer() {
    try {
        // 初始化数据库表结构
        await initializeTables();

        // 初始化 manifest 内存缓存
        manifest.init();

        // 定时任务：离线检查（每 30 分钟执行一次）
        setInterval(() => {
            try {
                const threshold = new Date(Date.now() - (config.clientOfflineThreshold || 7200) * 1000)
                    .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
                console.log(`[Scheduler] 离线检查完成 (阈值: ${threshold})`);
            } catch (err) {
                console.error('[Scheduler] 离线检查失败:', err);
            }
        }, 30 * 60 * 1000);

        // 启动 HTTP 服务
        app.listen(config.port, () => {
            console.log('');
            console.log('╔══════════════════════════════════════════════╗');
            console.log('║   rongcloud-assist 后端服务                  ║');
            console.log('╚══════════════════════════════════════════════╝');
            console.log('');
            console.log(`  🌐 服务地址:    http://localhost:${config.port}`);
            console.log(`  📦 更新地址:    http://localhost:${config.port}/manifest.json`);
            console.log(`  🤖 AI 接口:     http://localhost:${config.port}/api/ai/summary`);
            console.log(`  📋 备忘接口:    http://localhost:${config.port}/api/ai/memo`);
            console.log(`  📝 日志接口:    http://localhost:${config.port}/api/ai/work-log`);
            console.log(`  🔧 健康检查:    http://localhost:${config.port}/api/health`);
            console.log(`  🖥️  管理后台:    http://localhost:${config.port}/admin`);
            console.log(`  💓 心跳上报:    http://localhost:${config.port}/api/client/heartbeat`);
            console.log(`  📡 LLM 模型:    ${config.llm.model} (${config.llm.baseURL})`);
            console.log(`  🔑 API 鉴权:    ${config.apiKey ? '已启用' : '未启用（开发模式）'}`);
            console.log(`  💾 数据库:      SQLite (sql.js) @ data/assist.db`);
            console.log('');
        });
    } catch (err) {
        console.error('❌ 启动失败:', err);
        process.exit(1);
    }
}

startServer();

module.exports = app;
