/**
 * 统计数据计算服务
 *
 * 提供 Dashboard 所需的各项统计数据
 */

const db = require('../database');
const config = require('../config');
const manifest = require('./manifest');

const stats = {
    /**
     * 概览数据
     */
    async getOverview() {
        const totalRow = db.getOne('SELECT COUNT(*) as count FROM client_user');
        const totalUsers = totalRow.count;

        const thresholdSeconds = config.clientOfflineThreshold || 7200;
        const onlineRow = db.getOne(
            'SELECT COUNT(*) as count FROM client_user WHERE last_heartbeat > datetime("now", "-" || ? || " seconds")',
            [thresholdSeconds]
        );
        const onlineUsers = onlineRow.count;

        const currentManifest = manifest.readRef();
        const pluginCount = (currentManifest.plugins || []).length;

        const todayRow = db.getOne("SELECT COUNT(*) as count FROM api_usage WHERE date(created_at) = date('now')");
        const todayApiCalls = todayRow.count;

        return {
            totalUsers,
            onlineUsers,
            pluginCount,
            todayApiCalls,
        };
    },

    /**
     * 插件使用统计
     */
    async getPluginStats() {
        const clients = db.getAll('SELECT plugin_config FROM client_user WHERE plugin_config IS NOT NULL');
        const pluginMap = {};

        const thresholdSeconds = config.clientOfflineThreshold || 7200;
        const onlineClients = db.getAll(
            'SELECT plugin_config FROM client_user WHERE plugin_config IS NOT NULL AND last_heartbeat > datetime("now", "-" || ? || " seconds")',
            [thresholdSeconds]
        );

        // 统计总启用人数
        for (const client of clients) {
            try {
                const plugins = JSON.parse(client.plugin_config);
                if (Array.isArray(plugins)) {
                    plugins.forEach(p => {
                        if (p.enabled) {
                            if (!pluginMap[p.id]) pluginMap[p.id] = { total: 0, active: 0, name: p.id };
                            pluginMap[p.id].total++;
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        // 统计活跃启用人数
        for (const client of onlineClients) {
            try {
                const plugins = JSON.parse(client.plugin_config);
                if (Array.isArray(plugins)) {
                    plugins.forEach(p => {
                        if (p.enabled && pluginMap[p.id]) {
                            pluginMap[p.id].active++;
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        return Object.values(pluginMap).sort((a, b) => b.total - a.total);
    },

    /**
     * 用户活跃趋势
     * @param {number} days - 查询天数（7 或 30）
     */
    async getActivityTrend(days = 7) {
        const results = db.getAll(
            `SELECT date(last_heartbeat) as date, COUNT(DISTINCT user_id) as count
             FROM client_user
             WHERE last_heartbeat >= date('now', '-' || ? || ' days')
             GROUP BY date(last_heartbeat)
             ORDER BY date ASC`,
            [days]
        );

        // 填充空白日期
        const trend = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const found = results.find(r => {
                const rDate = r.date instanceof Date
                    ? r.date.toISOString().split('T')[0]
                    : String(r.date);
                return rDate === dateStr;
            });
            trend.push({
                date: dateStr,
                count: found ? found.count : 0,
            });
        }

        return trend;
    },

    /**
     * 平台分布
     */
    async getPlatformDistribution() {
        return db.getAll(`
            SELECT platform, COUNT(*) as count
            FROM client_user
            WHERE platform IS NOT NULL
            GROUP BY platform
        `);
    },

    /**
     * 版本分布
     */
    async getVersionDistribution() {
        // core_components 存储的是 JSON 数组，暂时返回空列表
        return [];
    },

    /**
     * 最近上线用户
     * @param {number} limit - 返回条数
     */
    async getRecentOnline(limit = 10) {
        return db.getAll(
            'SELECT user_id, user_name, portrait, platform, last_heartbeat, ip_address FROM client_user ORDER BY last_heartbeat DESC LIMIT ?',
            [Number(limit)]
        );
    },

    /**
     * 用户增长趋势
     * @param {number} days - 查询天数
     */
    async getUserGrowthTrend(days = 30) {
        // 每日新增用户
        const dailyNew = db.getAll(
            `SELECT date(first_seen) as date, COUNT(*) as count
             FROM client_user
             WHERE first_seen >= date('now', '-' || ? || ' days')
             GROUP BY date(first_seen)
             ORDER BY date ASC`,
            [days]
        );

        // 总用户数（用于计算累计）
        const beforeCount = db.getOne(
            'SELECT COUNT(*) as count FROM client_user WHERE first_seen < date("now", "-" || ? || " days")',
            [days]
        );
        let cumulative = beforeCount ? beforeCount.count : 0;

        // 填充空白日期
        const trend = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const found = dailyNew.find(r => {
                const rDate = r.date instanceof Date
                    ? r.date.toISOString().split('T')[0]
                    : String(r.date);
                return rDate === dateStr;
            });
            const newCount = found ? found.count : 0;
            cumulative += newCount;
            trend.push({
                date: dateStr,
                newUsers: newCount,
                totalUsers: cumulative,
            });
        }

        return trend;
    },

    /**
     * API 调用量趋势
     * @param {number} days - 查询天数
     */
    async getApiCallTrend(days = 30) {
        const daily = db.getAll(
            `SELECT date(created_at) as date,
                    endpoint,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
                    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
             FROM api_usage
             WHERE created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY date(created_at), endpoint
             ORDER BY date ASC`,
            [days]
        );

        const endpoints = [...new Set(daily.map(r => r.endpoint))];

        const trend = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const dayRows = daily.filter(r => {
                const rDate = r.date instanceof Date
                    ? r.date.toISOString().split('T')[0]
                    : String(r.date);
                return rDate === dateStr;
            });
            const totalCalls = dayRows.reduce((s, r) => s + r.total, 0);
            const successCalls = dayRows.reduce((s, r) => s + r.success_count, 0);
            const errorCalls = dayRows.reduce((s, r) => s + r.error_count, 0);

            const byEndpoint = {};
            for (const ep of endpoints) {
                const row = dayRows.find(r => r.endpoint === ep);
                byEndpoint[ep] = row ? row.total : 0;
            }

            trend.push({
                date: dateStr,
                total: totalCalls,
                success: successCalls,
                error: errorCalls,
                byEndpoint,
            });
        }

        return { trend, endpoints };
    },

    /**
     * AI 调用统计数据
     */
    async getApiUsageStats({ period = 'today', endpoint } = {}) {
        let dateFilter;
        switch (period) {
            case 'today':
                dateFilter = "date(created_at) = date('now')";
                break;
            case 'week':
                dateFilter = "created_at >= datetime('now', '-7 days')";
                break;
            case 'month':
                dateFilter = "created_at >= datetime('now', '-30 days')";
                break;
            default:
                dateFilter = "1=1";
        }

        const params = [];
        let endpointFilter = '';
        if (endpoint) {
            endpointFilter = ' AND endpoint = ?';
            params.push(endpoint);
        }

        const where = `WHERE ${dateFilter}${endpointFilter}`;

        const totalRow = db.getOne(`SELECT COUNT(*) as count FROM api_usage ${where}`, params);
        const totalCalls = totalRow.count;

        const byEndpoint = db.getAll(`
            SELECT endpoint, COUNT(*) as count,
                   AVG(duration_ms) as avg_duration,
                   SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
            FROM api_usage ${where}
            GROUP BY endpoint
        `, params);

        const byUser = db.getAll(`
            SELECT user_id, COUNT(*) as count
            FROM api_usage ${where} AND user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY count DESC
            LIMIT 10
        `, params);

        const trend = db.getAll(`
            SELECT date(created_at) as date, COUNT(*) as count
            FROM api_usage ${where}
            GROUP BY date(created_at)
            ORDER BY date ASC
        `, params);

        const errorRow = db.getOne(
            `SELECT COUNT(*) as count FROM api_usage ${where} AND status = 'error'`,
            params
        );
        const errorCount = errorRow.count;

        return {
            totalCalls,
            errorCount,
            errorRate: totalCalls > 0 ? ((errorCount / totalCalls) * 100).toFixed(1) : '0.0',
            avgDuration: byEndpoint.reduce((sum, e) => sum + (parseFloat(e.avg_duration) || 0), 0) / (byEndpoint.length || 1),
            byEndpoint,
            byUser,
            trend,
        };
    },
};

module.exports = stats;
