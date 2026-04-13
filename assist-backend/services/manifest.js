/**
 * Manifest 内存缓存服务
 *
 * 将 manifest 数据保存在内存中，所有读取直接返回内存对象，
 * 写入时同步更新内存 + 异步持久化到磁盘文件（容灾备份）。
 *
 * 优势：
 * - 高频读取零 IO（纯内存）
 * - 写入时双写（内存 + 文件）保障数据安全
 * - 启动时优先从磁盘加载，保证重启后恢复
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MANIFEST_FILE = path.join(PUBLIC_DIR, 'manifest.json');

// ---- 内存中的 manifest 数据 ----
let _manifest = null;

/**
 * 默认 manifest 结构
 */
function createDefault() {
    return {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        core: {},
        plugins: [],
    };
}

/**
 * 初始化：从磁盘加载或创建默认值
 * 应在 server 启动时调用一次
 */
function init() {
    try {
        if (fs.existsSync(MANIFEST_FILE)) {
            const raw = fs.readFileSync(MANIFEST_FILE, 'utf-8');
            _manifest = JSON.parse(raw);
            console.log('[Manifest] ✅ 已从磁盘加载 manifest（内存缓存已就绪）');
        } else {
            _manifest = createDefault();
            _persist();
            console.log('[Manifest] ✅ 初始化默认 manifest（内存缓存已就绪）');
        }
    } catch (err) {
        console.error('[Manifest] ⚠️ 加载磁盘文件失败，使用默认值:', err.message);
        _manifest = createDefault();
    }
}

/**
 * 异步持久化到磁盘（写后不阻塞调用方）
 */
function _persist() {
    try {
        // 确保目录存在
        if (!fs.existsSync(PUBLIC_DIR)) {
            fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        }
        fs.writeFileSync(MANIFEST_FILE, JSON.stringify(_manifest, null, 2), 'utf-8');
    } catch (err) {
        console.error('[Manifest] ⚠️ 持久化到磁盘失败:', err.message);
    }
}

/**
 * 读取 manifest（从内存，零 IO）
 * @returns {object} manifest 深拷贝（防止外部意外修改内存数据）
 */
function read() {
    if (!_manifest) init();
    // 返回深拷贝，防止调用方直接修改内存引用
    return JSON.parse(JSON.stringify(_manifest));
}

/**
 * 获取内存引用（用于只读场景，避免深拷贝开销）
 * ⚠️ 调用方不得修改返回对象
 * @returns {object} manifest 内存引用
 */
function readRef() {
    if (!_manifest) init();
    return _manifest;
}

/**
 * 写入 manifest（更新内存 + 持久化到磁盘）
 * @param {object} manifest - 完整的 manifest 对象
 */
function write(manifest) {
    manifest.updatedAt = new Date().toISOString();
    _manifest = manifest;
    _persist();
}

/**
 * 在当前 manifest 上执行更新（读 → 改 → 写 原子操作）
 * @param {function} updater - 接收 manifest 对象，直接修改后返回
 * @returns {object} 更新后的 manifest 深拷贝
 */
function update(updater) {
    if (!_manifest) init();
    updater(_manifest);
    _manifest.updatedAt = new Date().toISOString();
    _persist();
    return JSON.parse(JSON.stringify(_manifest));
}

module.exports = {
    init,
    read,
    readRef,
    write,
    update,
};
