'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// 数据库文件路径（放 data/ 目录下，与源码分离）
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'assist.db');

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// sql.js 实例（延迟初始化）
let SQL = null;
let db = null;          // sql.js Database 对象
let saveTimer = null;   // 延迟写回定时器

// 每次写入后延迟 1 秒再写磁盘（防频繁 IO）
function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const data = db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(DB_PATH, buffer);
        } catch (err) {
            console.error('[DB] 写盘失败:', err.message);
        }
    }, 1000);
}

// ====================== 对外 API ======================

/**
 * 执行 INSERT/UPDATE/DELETE
 * 返回 { changes, lastInsertRowid }
 */
const run = (sql, params = []) => {
    if (!db) throw new Error('数据库未初始化');
    try {
        db.run(sql, params);
        scheduleSave();
        return { changes: db.getRowsModified(), lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] || 0 };
    } catch (err) {
        console.error('[DB.run]', err.message, sql);
        throw err;
    }
};

/**
 * 查询单行
 */
const getOne = (sql, params = []) => {
    if (!db) throw new Error('数据库未初始化');
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
        }
        stmt.free();
        return null;
    } catch (err) {
        console.error('[DB.getOne]', err.message, sql);
        throw err;
    }
};

/**
 * 查询多行
 */
const getAll = (sql, params = []) => {
    if (!db) throw new Error('数据库未初始化');
    try {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
    } catch (err) {
        console.error('[DB.getAll]', err.message, sql);
        throw err;
    }
};

/**
 * 同步 prepare（供 session store 使用）
 */
const prepare = (sql) => {
    return db.prepare(sql);
};

// ====================== 初始化（启动时调用） ======================

const initSchema = () => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS client_user (
            user_id          TEXT PRIMARY KEY,
            user_name        TEXT,
            portrait         TEXT,
            dept_name        TEXT,
            company_id       TEXT,
            company_name     TEXT,
            platform         TEXT,
            core_components  TEXT,
            plugin_config    TEXT,
            last_heartbeat   TEXT DEFAULT (datetime('now')),
            ip_address       TEXT,
            first_seen       TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS plugin_stats (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id TEXT NOT NULL,
            stat_date DATE NOT NULL DEFAULT (date('now')),
            call_count INTEGER DEFAULT 0,
            UNIQUE(plugin_id, stat_date)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            action     TEXT NOT NULL,
            target     TEXT,
            operator   TEXT NOT NULL DEFAULT 'admin',
            detail     TEXT,
            ip_address TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS api_usage (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint      TEXT NOT NULL,
            client_id     TEXT,
            user_id       TEXT,
            status        TEXT DEFAULT 'success',
            duration_ms   INTEGER,
            error_message TEXT,
            created_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            expires    INTEGER NOT NULL,
            data       TEXT
        );
    `);

    // 创建索引（ignore 掉已存在的错误）
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_client_heartbeat ON client_user(last_heartbeat)'); } catch (_) {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at)'); } catch (_) {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage(endpoint)'); } catch (_) {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)'); } catch (_) {}
};

/**
 * 初始化数据库（异步，必须在 server.start() 前调用）
 */
async function initializeTables() {
    SQL = await initSqlJs();

    // 加载已有数据或创建新库
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log(`[DB] Loaded existing database: ${DB_PATH}`);
    } else {
        db = new SQL.Database();
        console.log(`[DB] Created new database: ${DB_PATH}`);
    }

    initSchema();
    scheduleSave();
    console.log('[DB] SQLite ready (sql.js + WASM)');
}

// 关闭时确保写盘
process.on('exit', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (db) {
        try {
            fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
        } catch (_) {}
    }
});

module.exports = { run, getOne, getAll, prepare, db: { run, getOne, getAll, prepare }, initializeTables };
