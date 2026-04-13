/**
 * 插件同步器 (Updater)
 * 启动时从服务端拉取 manifest.json，全量同步本地插件和核心组件
 * 
 * 插件同步策略：
 * - 远程有、本地无 → 自动下载安装
 * - 远程有、本地版本低 → 自动下载更新
 * - 远程有、本地版本一致 → 跳过
 * - 远程无、本地有 → 自动卸载移除
 * - 同步失败（网络等） → 静默跳过，用本地现有插件继续运行
 * 
 * 核心组件同步策略：
 * - 对比 manifest.core 与本地 .version.json 中记录的版本
 * - 版本更新 → 下载替换本地 core/*.js 文件，标记需要重启
 * - 核心组件更新后需要重启应用才能生效
 */

(function () {
    'use strict';

    const fs = require('fs');
    const path = require('path');

    class Updater {
        constructor() {
            this.baseDir = null;
            console.log('[Updater] 🔄 插件同步器创建');
        }

        /**
         * 获取全局服务器地址（委托给 PluginManager）
         */
        _getServerUrl() {
            return (window.PluginManager && window.PluginManager.getServerUrl()) || '';
        }

        /**
         * 拉取远程 manifest（缓存，避免多次请求）
         * @returns {Promise<Object|null>}
         */
        async _fetchManifest() {
            if (this._cachedManifest) return this._cachedManifest;

            const serverUrl = this._getServerUrl();
            if (!serverUrl) return null;

            const manifestUrl = serverUrl.replace(/\/+$/, '') + '/api/client/manifest';
            const response = await fetch(manifestUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            this._cachedManifest = await response.json();
            return this._cachedManifest;
        }

        /**
         * 同步核心组件（启动时调用，在 syncPlugins 之前）
         * 对比 manifest.core 与本地 .version.json，下载更新的核心文件
         * @returns {Promise<{updated: string[], errors: string[]}>}
         */
        async syncCore() {
            // 开发模式：跳过远程同步，直接使用本地文件
            if (this._isDevMode()) {
                console.log('[Updater] 🛠️ 开发模式，跳过核心组件远程同步');
                return { updated: [], errors: [] };
            }

            const serverUrl = this._getServerUrl();
            if (!serverUrl) {
                console.log('[Updater] 服务器地址未配置，跳过核心组件同步');
                return { updated: [], errors: [] };
            }

            console.log('[Updater] 🔧 开始同步核心组件...');
            const result = { updated: [], errors: [] };

            try {
                const manifest = await this._fetchManifest();
                if (!manifest || !manifest.core) {
                    console.log('[Updater] manifest 中无 core 字段，跳过核心同步');
                    return result;
                }

                // 读取本地版本信息
                const versionPath = path.join(this.baseDir, '.version.json');
                let versionInfo = {};
                try {
                    if (fs.existsSync(versionPath)) {
                        versionInfo = JSON.parse(fs.readFileSync(versionPath, 'utf-8'));
                    }
                } catch (e) {
                    console.warn('[Updater] 读取 .version.json 失败:', e.message);
                }

                // 确保 coreVersions 对象存在
                if (!versionInfo.coreVersions) {
                    versionInfo.coreVersions = {};
                }

                const coreDir = path.join(this.baseDir, 'core');
                const baseUrl = serverUrl.replace(/\/+$/, '');

                // 遍历 manifest.core 中的每个组件
                for (const [coreKey, coreInfo] of Object.entries(manifest.core)) {
                    try {
                        const localVersion = versionInfo.coreVersions[coreKey] || '0.0.0';
                        const remoteVersion = coreInfo.version;

                        if (!this._isNewerVersion(remoteVersion, localVersion)) {
                            console.log(`[Updater] 🔧 核心组件 ${coreKey} 版本一致 (v${localVersion})，跳过`);
                            continue;
                        }

                        console.log(`[Updater] ⬆️  更新核心组件: ${coreKey} ${localVersion} → ${remoteVersion}`);

                        // 下载文件
                        const downloadUrl = `${baseUrl}/${coreInfo.file}`;
                        const response = await fetch(downloadUrl);
                        if (!response.ok) {
                            throw new Error(`下载失败: HTTP ${response.status}`);
                        }

                        const arrayBuffer = await response.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);

                        // Hash 校验
                        if (coreInfo.hash) {
                            const crypto = require('crypto');
                            const hash = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
                            if (hash !== coreInfo.hash) {
                                throw new Error(`Hash 校验失败！预期: ${coreInfo.hash} 实际: ${hash}`);
                            }
                        }

                        // 确保 core 目录存在
                        if (!fs.existsSync(coreDir)) {
                            fs.mkdirSync(coreDir, { recursive: true });
                        }

                        // 写入文件 — 从 coreInfo.file 提取文件名 (如 "core/plugin-manager.js" → "plugin-manager.js")
                        const fileName = path.basename(coreInfo.file);
                        const targetPath = path.join(coreDir, fileName);

                        // 备份旧文件
                        if (fs.existsSync(targetPath)) {
                            const backupPath = targetPath + '.bak';
                            fs.copyFileSync(targetPath, backupPath);
                            console.log(`[Updater] 📋 已备份: ${fileName} → ${fileName}.bak`);
                        }

                        fs.writeFileSync(targetPath, buffer);
                        console.log(`[Updater] ✅ 核心组件 ${coreKey} v${remoteVersion} 写入完成: ${targetPath}`);

                        // 更新本地版本记录
                        versionInfo.coreVersions[coreKey] = remoteVersion;
                        result.updated.push(coreKey);

                    } catch (err) {
                        const msg = `核心组件 ${coreKey}: ${err.message}`;
                        console.error(`[Updater] ❌ ${msg}`);
                        result.errors.push(msg);
                    }
                }

                // 如果有更新，写回 .version.json 并标记需要重启
                if (result.updated.length > 0) {
                    versionInfo.lastCoreUpdate = new Date().toISOString();
                    // 更新 coreVersion 为最新的 pluginManager 版本（如果有）
                    if (versionInfo.coreVersions.pluginManager) {
                        versionInfo.coreVersion = versionInfo.coreVersions.pluginManager;
                    }
                    fs.writeFileSync(versionPath, JSON.stringify(versionInfo), 'utf-8');
                    console.log(`[Updater] 📝 .version.json 已更新`);

                    console.log(`[Updater] 🔧 核心组件同步完成 — 已更新: ${result.updated.join(', ')}`);
                } else {
                    console.log('[Updater] 🔧 核心组件均为最新，无需更新');
                }

            } catch (error) {
                console.warn('[Updater] ⚠️ 核心组件同步失败:', error.message);
            }

            return result;
        }

        /**
         * 全量同步插件（启动时调用一次）
         * @returns {Promise<{synced: number, installed: number, updated: number, removed: number, errors: string[]}>}
         */
        async syncPlugins() {
            // 开发模式：跳过远程同步，直接使用本地文件
            if (this._isDevMode()) {
                console.log('[Updater] 🛠️ 开发模式，跳过插件远程同步');
                return { synced: 0, installed: 0, updated: 0, removed: 0, errors: [] };
            }

            const serverUrl = this._getServerUrl();
            if (!serverUrl) {
                console.log('[Updater] 服务器地址未配置，跳过同步');
                return { synced: 0, installed: 0, updated: 0, removed: 0, errors: [] };
            }

            console.log('[Updater] 🔄 开始全量同步插件...');

            const result = { synced: 0, installed: 0, updated: 0, removed: 0, errors: [] };

            try {
                // 1. 拉取远程 manifest（复用缓存）
                const manifest = await this._fetchManifest();
                if (!manifest) throw new Error('manifest 获取失败');
                const remotePlugins = manifest.plugins || [];

                // 2. 收集本地已安装的插件 ID
                const pluginsDir = path.join(this.baseDir, 'plugins');
                const localPluginIds = this._getLocalPluginIds(pluginsDir);

                // 3. 构建远程插件 ID 集合
                const remotePluginIds = new Set(remotePlugins.map(p => p.id));

                // 4. 遍历远程插件：安装或更新
                for (const remotePlugin of remotePlugins) {
                    try {
                        const localVersion = this._getLocalPluginVersion(remotePlugin.id);
                        const pluginDir = path.join(pluginsDir, remotePlugin.id);
                        const pluginMainFile = path.join(pluginDir, 'main.js');
                        const isInstalled = fs.existsSync(pluginDir) && fs.existsSync(pluginMainFile);

                        if (!isInstalled) {
                            // 本地没有 → 下载安装
                            console.log(`[Updater] 📥 安装新插件: ${remotePlugin.id} v${remotePlugin.version}`);
                            await this._downloadAndInstall(remotePlugin);
                            result.installed++;
                        } else if (this._isNewerVersion(remotePlugin.version, localVersion)) {
                            // 本地版本低 → 下载更新
                            console.log(`[Updater] ⬆️  更新插件: ${remotePlugin.id} ${localVersion} → ${remotePlugin.version}`);
                            await this._downloadAndInstall(remotePlugin);
                            result.updated++;
                        } else {
                            // 版本一致 → 跳过
                            result.synced++;
                        }
                    } catch (err) {
                        const msg = `${remotePlugin.id}: ${err.message}`;
                        console.error(`[Updater] ❌ 同步失败: ${msg}`);
                        result.errors.push(msg);
                    }
                }

                // 5. 遍历本地插件：移除远程已不存在的
                for (const localId of localPluginIds) {
                    if (!remotePluginIds.has(localId)) {
                        // 如果是本地开发版本的插件，跳过移除
                        const localPluginVersion = this._getLocalPluginVersion(localId);
                        if (localPluginVersion === 'dev') {
                            console.log(`[Updater] 🛠️ 本地开发插件保留，跳过移除: ${localId}`);
                            continue;
                        }

                        try {
                            console.log(`[Updater] 🗑️ 移除插件: ${localId}（服务端已下架）`);
                            await this._removePlugin(localId);
                            result.removed++;
                        } catch (err) {
                            const msg = `移除 ${localId}: ${err.message}`;
                            console.error(`[Updater] ❌ ${msg}`);
                            result.errors.push(msg);
                        }
                    }
                }

                console.log(`[Updater] ✅ 同步完成 — 安装:${result.installed} 更新:${result.updated} 移除:${result.removed} 跳过:${result.synced} 失败:${result.errors.length}`);

            } catch (error) {
                console.warn('[Updater] ⚠️ 同步失败，使用本地插件继续运行:', error.message);
            }

            // 清除 manifest 缓存
            this._cachedManifest = null;

            return result;
        }

        /**
         * 获取本地所有已安装的插件 ID
         */
        _getLocalPluginIds(pluginsDir) {
            const ids = [];
            if (!fs.existsSync(pluginsDir)) return ids;

            const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const mainPath = path.join(pluginsDir, entry.name, 'main.js');
                    if (fs.existsSync(mainPath)) {
                        ids.push(entry.name);
                    }
                }
            }
            return ids;
        }

        /**
         * 获取本地插件版本号
         */
        _getLocalPluginVersion(pluginId) {
            const config = window.PluginManager.pluginConfigs.get(pluginId);
            return config?.version || '0.0.0';
        }

        /**
         * 版本比较：remote 是否比 local 更新
         */
        _isNewerVersion(remote, local) {
            // 本地是 dev 版本，认为它是最新的开发态，不允许被远程版本覆盖
            if (local === 'dev') {
                return false;
            }

            const parseVersion = (v) => (v || '0.0.0').split('.').map(Number);
            const r = parseVersion(remote);
            const l = parseVersion(local);

            for (let i = 0; i < Math.max(r.length, l.length); i++) {
                const rv = r[i] || 0;
                const lv = l[i] || 0;
                if (rv > lv) return true;
                if (rv < lv) return false;
            }
            return false;
        }

        /**
         * 下载并安装/更新一个插件
         */
        async _downloadAndInstall(remotePlugin) {
            const serverUrl = this._getServerUrl();
            const baseUrl = serverUrl.replace(/\/+$/, '');
            const downloadUrl = `${baseUrl}/${remotePlugin.file}`;

            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(`下载失败: HTTP ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Hash 校验
            if (remotePlugin.hash) {
                const crypto = require('crypto');
                const hash = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
                if (hash !== remotePlugin.hash) {
                    throw new Error(`Hash 校验失败！预期: ${remotePlugin.hash} 实际: ${hash}`);
                }
            }

            const pluginsDir = path.join(this.baseDir, 'plugins');
            const pluginDir = path.join(pluginsDir, remotePlugin.id);
            if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });

            const format = remotePlugin.format || 'js';
            if (format === 'zip') {
                // ZIP 格式：先清理再解压
                this._cleanPluginDir(pluginDir);
                this._extractZip(buffer, pluginDir);
            } else {
                // 单文件格式
                const targetPath = path.join(pluginDir, 'main.js');
                fs.writeFileSync(targetPath, buffer);
            }

            console.log(`[Updater] ✅ ${remotePlugin.id} v${remotePlugin.version} 写入完成`);
        }

        /**
         * 移除一个本地插件（删除目录 + 清理配置）
         */
        async _removePlugin(pluginId) {
            // 如果插件正在运行，先销毁
            await window.PluginManager.destroyPlugin(pluginId);

            // 删除插件目录
            const pluginDir = path.join(this.baseDir, 'plugins', pluginId);
            if (fs.existsSync(pluginDir)) {
                this._removeDirSync(pluginDir);
            }

            // 从配置中移除
            window.PluginManager.pluginConfigs.delete(pluginId);
            window.PluginManager.plugins.delete(pluginId);

            console.log(`[Updater] ✅ 插件 ${pluginId} 已移除`);
        }

        /**
         * 使用 Node.js 内置 zlib 解压 ZIP buffer 到目录
         */
        _extractZip(zipBuffer, targetDir) {
            const zlib = require('zlib');
            const LOCAL_FILE_HEADER_SIG = 0x04034b50;
            let offset = 0;
            let fileCount = 0;

            while (offset < zipBuffer.length - 4) {
                const sig = zipBuffer.readUInt32LE(offset);
                if (sig !== LOCAL_FILE_HEADER_SIG) break;

                const compression = zipBuffer.readUInt16LE(offset + 8);
                const compressedSize = zipBuffer.readUInt32LE(offset + 18);
                const fileNameLen = zipBuffer.readUInt16LE(offset + 26);
                const extraLen = zipBuffer.readUInt16LE(offset + 28);

                const fileName = zipBuffer.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
                const dataStart = offset + 30 + fileNameLen + extraLen;
                const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

                // 跳过目录条目
                if (!fileName.endsWith('/')) {
                    // 安全检查：防止路径穿越
                    const targetPath = path.join(targetDir, fileName);
                    const resolvedPath = path.resolve(targetPath);
                    const resolvedDir = path.resolve(targetDir);
                    if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
                        console.warn(`[Updater] ⚠️ 跳过危险路径: ${fileName}`);
                        offset = dataStart + compressedSize;
                        continue;
                    }

                    let data;
                    if (compression === 8) {
                        data = zlib.inflateRawSync(compressedData);
                    } else if (compression === 0) {
                        data = compressedData;
                    } else {
                        console.warn(`[Updater] ⚠️ 不支持的压缩方式 ${compression}，跳过: ${fileName}`);
                        offset = dataStart + compressedSize;
                        continue;
                    }

                    const fileDir = path.dirname(targetPath);
                    if (!fs.existsSync(fileDir)) {
                        fs.mkdirSync(fileDir, { recursive: true });
                    }
                    fs.writeFileSync(targetPath, data);
                    fileCount++;
                }

                offset = dataStart + compressedSize;
            }

            console.log(`[Updater] 📦 解压完成，共 ${fileCount} 个文件`);
        }

        /**
         * 清理插件目录（保留 cache 和 logs 目录）
         */
        _cleanPluginDir(dirPath) {
            if (!fs.existsSync(dirPath)) return;
            const preserve = ['cache', 'logs'];
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (preserve.includes(entry.name)) continue;
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    this._removeDirSync(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
        }

        /**
         * 递归删除目录
         */
        _removeDirSync(dirPath) {
            if (!fs.existsSync(dirPath)) return;
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    this._removeDirSync(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }
            fs.rmdirSync(dirPath);
        }

        /**
         * 检查是否为开发模式
         * 读取 plugin-config.json 中的 devMode 字段
         * @returns {boolean}
         */
        _isDevMode() {
            try {
                const configPath = path.join(
                    this.baseDir || path.dirname(__dirname),
                    'plugin-config.json'
                );
                if (fs.existsSync(configPath)) {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    return config.devMode === true;
                }
            } catch (e) {
                // 读取失败时视为非开发模式
            }
            return false;
        }
    }

    // 创建全局实例（不自动初始化，由 PluginManager 调用 syncPlugins）
    window.Updater = new Updater();

    console.log('[Updater] 📦 插件同步器已注册到 window.Updater');
})();
