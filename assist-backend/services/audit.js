/**
 * 审计日志服务
 *
 * 提供统一的审计日志写入接口，记录所有管理操作
 */

const db = require('../database');

const audit = {
    /**
     * 写入审计日志
     * @param {Object} options
     * @param {string} options.action - 操作类型: login / logout / publish / rollback / core_publish / core_delete
     * @param {string} [options.target] - 操作对象（插件 ID 等）
     * @param {string} [options.operator='admin'] - 操作者
     * @param {Object} [options.detail] - 操作详情（会序列化为 JSON）
     * @param {string} [options.ipAddress] - 操作来源 IP
     */
    async log({ action, target, operator = 'admin', detail, ipAddress }) {
        try {
            db.run(
                `INSERT INTO audit_logs (action, target, operator, detail, ip_address) VALUES (?, ?, ?, ?, ?)`,
                [
                    action,
                    target || null,
                    operator,
                    detail ? JSON.stringify(detail) : null,
                    ipAddress || null,
                ]
            );
        } catch (err) {
            console.error('[Audit] 写入审计日志失败:', err.message);
        }
    },

    /**
     * 查询审计日志
     * @param {Object} options
     * @param {number} [options.page=1] - 页码
     * @param {number} [options.pageSize=20] - 每页条数
     * @param {string} [options.action] - 按操作类型筛选
     * @param {string} [options.startDate] - 开始日期
     * @param {string} [options.endDate] - 结束日期
     */
    async query({ page = 1, pageSize = 20, action, startDate, endDate } = {}) {
        let where = 'WHERE 1=1';
        const params = [];

        if (action) {
            where += ' AND action = ?';
            params.push(action);
        }
        if (startDate) {
            where += ' AND created_at >= ?';
            params.push(startDate);
        }
        if (endDate) {
            where += ' AND created_at <= ?';
            params.push(endDate + ' 23:59:59');
        }

        const countRow = db.getOne(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);
        const total = countRow.total;

        const offset = (page - 1) * pageSize;
        const rows = db.getAll(
            `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, Number(pageSize), offset]
        );

        return {
            items: rows.map(row => ({
                ...row,
                detail: row.detail ? JSON.parse(row.detail) : null,
            })),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    },
};

module.exports = audit;
