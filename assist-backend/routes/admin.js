/**
 * 管理接口
 *
 * POST /api/admin/push          - 推送插件到服务端暂存（不直接更新 manifest，需管理员手动发布）
 * GET  /api/admin/manifest      - 查看当前 manifest
 * DELETE /api/admin/plugins/:id - 从 manifest 中移除插件
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { listZipContents, parseZipBuffer } = require('../utils/zip');

const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ARCHIVE_DIR = path.join(PUBLIC_DIR, 'archive');
const manifest = require('../services/manifest');

// 文件上传配置
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 单个插件最大 5MB（ZIP 包可能更大）
});



/**
 * 计算文件 SHA256
 */
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * --- 清理旧版本归档，防止服务端磁盘堆积 ---
 * 保留最近的 maxRetain 个版本，多余的数据文件和 .meta.json 一并删除
 */
function cleanupArchive(archiveDir, id, maxRetain = 10) {
    if (!fs.existsSync(archiveDir)) return;
    try {
        // 只取主文件（.js / .zip），排除 .meta.json
        const files = fs.readdirSync(archiveDir)
            .filter(f => f.startsWith(`${id}-`) && !f.endsWith('.meta.json'))
            .map(f => ({
                name: f,
                path: path.join(archiveDir, f),
                stat: fs.statSync(path.join(archiveDir, f))
            }))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // 按时间倒序

        if (files.length > maxRetain) {
            const toDelete = files.slice(maxRetain);
            toDelete.forEach(file => {
                // 删除数据文件
                fs.unlinkSync(file.path);
                console.log(`[Admin] 🗑️ 已清理过期归档: ${file.name}`);

                // 删除对应的 .meta.json（如果存在）
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

/**
 * POST /api/admin/parse-zip
 *
 * 解析上传的 ZIP 包，从中读取 manifest.json 或 package.json 的基本信息
 * 返回: { id, name, version, description, changelog, files }
 */
router.post('/parse-zip', upload.single('file'), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: '缺少上传文件' });
        }

        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.zip') {
            return res.status(400).json({ error: '仅支持 .zip 文件' });
        }

        // 解析 ZIP 内容
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
            } catch (e) {
                console.warn('[Admin] manifest.json 解析失败:', e.message);
            }
        }

        // fallback: 查找 package.json
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
            } catch (e) {
                console.warn('[Admin] package.json 解析失败:', e.message);
            }
        }

        // 都没找到，返回文件列表和来自文件名的猜测 ID
        const guessId = path.basename(file.originalname, '.zip');
        result.id = guessId;
        result.name = '';
        result.version = '';
        result.description = '';
        result.changelog = '';
        result.source = 'filename';
        res.json(result);

    } catch (error) {
        console.error('[Admin] ZIP 解析失败:', error);
        res.status(500).json({ error: 'ZIP 解析失败: ' + error.message });
    }
});

/**
 * POST /api/admin/publish
 *
 * 推送插件到服务端暂存区（不直接更新 manifest，需管理员在后台手动选择版本发布）
 *
 * Form 字段：
 * - type:        "plugin" | "core"
 * - id:          组件 ID（如 "group-ai-summary" 或 "plugin-manager"）
 * - version:     版本号（如 "2026.0317.2212"）
 * - changelog:   更新日志（可选）
 * - name:        显示名称（可选, 仅插件）
 * - description: 描述（可选, 仅插件）
 * - file:        .zip 文件（插件）或 .js 文件（核心组件）（multipart 上传）
 */
router.post('/publish', upload.single('file'), (req, res) => {
    try {
        const { type, id, version, changelog, name, description } = req.body;
        const file = req.file;

        // --- 参数校验 ---
        if (!type || !['plugin', 'core'].includes(type)) {
            return res.status(400).json({ error: 'type 必须是 "plugin" 或 "core"' });
        }
        if (!id) {
            return res.status(400).json({ error: '缺少 id 参数' });
        }
        if (!version) {
            return res.status(400).json({ error: '缺少 version 参数' });
        }
        if (!file) {
            return res.status(400).json({ error: '缺少上传文件' });
        }

        const hash = `sha256:${sha256(file.buffer)}`;

        if (type === 'core') {
            // --- 核心组件：推送到 archive，需管理员手动选择版本发布 ---
            const archiveDir = path.join(ARCHIVE_DIR, 'core');
            ensureDir(archiveDir);

            const archiveName = `${id}-${version}.js`;
            const archivePath = path.join(archiveDir, archiveName);

            // 写入归档文件
            fs.writeFileSync(archivePath, file.buffer);

            // 写入推送元信息（方便后台展示）
            const metaPath = path.join(archiveDir, `${id}-${version}.meta.json`);
            const meta = {
                id,
                version,
                hash,
                changelog: changelog || '',
                pushedAt: new Date().toISOString(),
            };
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

            // 检查是否为新组件（manifest 中不存在）
            const currentManifest = manifest.read();
            const coreKey = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const isNew = !currentManifest.core[coreKey];

            cleanupArchive(archiveDir, id, 10);

            console.log(`[Admin] 📤 核心组件已推送: ${id} v${version}，等待管理员发布`);
            res.json({
                message: `核心组件 ${id} v${version} 已推送到服务端，请在管理后台选择版本发布`,
                archive: archiveName,
                hash,
                isNew,
            });

        } else {
            // --- 插件推送：只存储到 archive，不更新 manifest ---
            const ext = path.extname(file.originalname).toLowerCase();
            const isZip = ext === '.zip';

            // 存储到 archive/plugins/ 目录
            const archiveDir = path.join(ARCHIVE_DIR, 'plugins');
            ensureDir(archiveDir);

            const archiveExt = isZip ? '.zip' : '.js';
            const archiveName = `${id}-${version}${archiveExt}`;
            const archivePath = path.join(archiveDir, archiveName);

            // 写入归档文件
            fs.writeFileSync(archivePath, file.buffer);

            // 如果是 ZIP，列出包含的文件
            let fileList = [];
            if (isZip) {
                try {
                    fileList = listZipContents(file.buffer).map(f => f.path);
                } catch (e) {
                    console.warn(`[Admin] 解析 ZIP 内容列表失败:`, e.message);
                }
            }

            // 写入推送元信息（方便后台展示）
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

            // 检查是否为新插件（manifest 中不存在）
            const currentManifest = manifest.read();
            const isNew = !currentManifest.plugins.find(p => p.id === id);

            cleanupArchive(archiveDir, id, 10);

            console.log(`[Admin] 📤 插件已推送: ${id} v${version} (${isZip ? 'ZIP' : 'JS'})，等待管理员发布`);
            res.json({
                message: `插件 ${id} v${version} 已推送到服务端，请在管理后台选择版本发布`,
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

/**
 * GET /api/admin/manifest
 * 查看当前 manifest 内容
 */
router.get('/manifest', (req, res) => {
    res.json(manifest.read());
});

/**
 * DELETE /api/admin/plugins/:id
 * 从 manifest 中移除一个插件（不删除文件）
 */
router.delete('/plugins/:id', (req, res) => {
    try {
        const currentManifest = manifest.read();
        const index = currentManifest.plugins.findIndex(p => p.id === req.params.id);

        if (index < 0) {
            return res.status(404).json({ error: `插件 ${req.params.id} 不存在` });
        }

        const removed = currentManifest.plugins.splice(index, 1)[0];
        manifest.write(currentManifest);

        console.log(`[Admin] ✅ 插件已移除: ${req.params.id}`);
        res.json({ message: `插件 ${req.params.id} 已从 manifest 移除`, removed });

    } catch (error) {
        res.status(500).json({ error: '操作失败: ' + error.message });
    }
});

module.exports = router;
