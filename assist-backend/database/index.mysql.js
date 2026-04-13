/**
 * 数据库基础设施（MySQL 8）
 *
 * - 服务启动时自动初始化 MySQL 连接池
 * - 自动创建所有表结构（IF NOT EXISTS）
 * - 导出 db 实例供各模块使用
 * - 提供与原 better-sqlite3 兼容的同步风格 API（基于 mysql2 sync wrapper）
 */

const mysql = require('mysql2');

// MySQL 连接配置
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'rongcloud-assist',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+00:00',
});

// 获取 promise 版连接池（用于 async/await）
const promisePool = pool.promise();

/**
 * 初始化所有表结构
 */
async function initializeTables() {
    // 2.1 client_user — 客户端注册信息（以 user_id 为主键）
    await promisePool.execute(`
        CREATE TABLE IF NOT EXISTS client_user (
            user_id         VARCHAR(255) PRIMARY KEY,
            user_name       VARCHAR(255),
            portrait        TEXT,
            dept_name       VARCHAR(255),
            company_id      VARCHAR(255),
            company_name    VARCHAR(255),
            platform        VARCHAR(50),
            core_components LONGTEXT,
            plugin_config   LONGTEXT,
            user_extra      TEXT,
            first_seen      DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_heartbeat  DATETIME,
            ip_address      VARCHAR(50),
            extra           TEXT,
            INDEX idx_client_user_last_heartbeat (last_heartbeat),
            INDEX idx_client_user_company_id (company_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2.2 plugin_stats — 插件使用统计（按日快照）
    await promisePool.execute(`
        CREATE TABLE IF NOT EXISTS plugin_stats (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            plugin_id     VARCHAR(255) NOT NULL,
            date          DATE NOT NULL,
            active_users  INT DEFAULT 0,
            total_users   INT DEFAULT 0,
            UNIQUE KEY uk_plugin_date (plugin_id, date),
            INDEX idx_plugin_stats_date (date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2.3 audit_logs — 操作审计日志
    await promisePool.execute(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            action      VARCHAR(100) NOT NULL,
            target      VARCHAR(255),
            operator    VARCHAR(100) DEFAULT 'admin',
            detail      TEXT,
            ip_address  VARCHAR(50),
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_audit_logs_action (action),
            INDEX idx_audit_logs_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);


    // 2.4 api_usage — AI 接口调用统计
    await promisePool.execute(`
        CREATE TABLE IF NOT EXISTS api_usage (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            endpoint      VARCHAR(255) NOT NULL,
            client_id     VARCHAR(255),
            user_id       VARCHAR(255),
            status        VARCHAR(50) DEFAULT 'success',
            duration_ms   INT,
            tokens_used   INT,
            error_message TEXT,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_api_usage_endpoint (endpoint),
            INDEX idx_api_usage_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ---- 数据库迁移：clients → client_user 表重命名 ----
    try {
        const [tables] = await promisePool.query(
            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clients'"
        );
        if (tables.length > 0) {
            await promisePool.execute('RENAME TABLE clients TO client_user');
            console.log('[Database] ✅ 已将 clients 表重命名为 client_user');
            // 迁移主键：去掉 id 列，改用 user_id 作为主键
            try {
                const [idCols] = await promisePool.query(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'id'"
                );
                if (idCols.length > 0) {
                    await promisePool.execute('ALTER TABLE client_user DROP PRIMARY KEY, DROP COLUMN id, ADD PRIMARY KEY (user_id)');
                    console.log('[Database] ✅ 已将 client_user 主键从 id 改为 user_id');
                }
            } catch (e2) {
                console.warn('[Database] 迁移 client_user 主键时出错:', e2.message);
            }
        }
    } catch (e) {
        console.warn('[Database] 重命名 clients 表时出错:', e.message);
    }

    // ---- 数据库迁移：client_user 表结构演进 ----
    // 添加 core_components 列（如果不存在）
    try {
        const [cols] = await promisePool.query(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME = 'core_components'"
        );
        if (cols.length === 0) {
            await promisePool.execute('ALTER TABLE client_user ADD COLUMN core_components LONGTEXT AFTER platform');
            console.log('[Database] ✅ 已添加 core_components 列');
        }
    } catch (e) {
        console.warn('[Database] 迁移 core_components 列时出错:', e.message);
    }

    // 移除已废弃的 app_version / core_version 列
    try {
        const [cols] = await promisePool.query(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_user' AND COLUMN_NAME IN ('app_version', 'core_version')"
        );
        for (const col of cols) {
            await promisePool.execute(`ALTER TABLE client_user DROP COLUMN ${col.COLUMN_NAME}`);
            console.log(`[Database] ✅ 已移除 ${col.COLUMN_NAME} 列`);
        }
    } catch (e) {
        console.warn('[Database] 移除旧列时出错:', e.message);
    }

    console.log('[Database] ✅ 所有表结构已初始化（MySQL 8）');
}

/**
 * 兼容层：提供类似 better-sqlite3 的 API
 * 让原有业务代码尽量少改动
 */
const db = {
    pool,
    promisePool,

    /**
     * 预编译 SQL（返回兼容对象）
     * 注意：MySQL 的占位符用 ? ，与 SQLite 一致
     */
    prepare(sql) {
        return {
            /**
             * 执行并返回第一行结果（同步风格，使用 pool.execute 同步版本）
             */
            get(...params) {
                const [rows] = pool.promise().execute(sql, params);
                // 注意：这是 Promise，调用方需要 await
                return rows;
            },

            /**
             * 执行并返回所有行
             */
            all(...params) {
                const [rows] = pool.promise().execute(sql, params);
                return rows;
            },

            /**
             * 执行写入操作
             */
            run(...params) {
                const [result] = pool.promise().execute(sql, params);
                return result;
            },
        };
    },

    /**
     * 直接执行 SQL（用于建表等 DDL）
     */
    async exec(sql) {
        await promisePool.query(sql);
    },

    /**
     * 执行查询并返回第一行
     */
    async getOne(sql, params = []) {
        const [rows] = await promisePool.query(sql, params);
        return rows[0] || null;
    },

    /**
     * 执行查询并返回所有行
     */
    async getAll(sql, params = []) {
        const [rows] = await promisePool.query(sql, params);
        return rows;
    },

    /**
     * 执行写入操作
     */
    async run(sql, params = []) {
        const [result] = await promisePool.query(sql, params);
        return result;
    },
};

// 导出初始化函数和 db 实例
module.exports = db;
module.exports.initializeTables = initializeTables;
