/**
 * 插件管理器核心 v2.0
 * 负责插件的加载、初始化、配置管理和生命周期控制
 * 
 * 此文件存放在 ~/Library/Application Support/EpointMsgPlugins/ (macOS)
 *                或 %APPDATA%\EpointMsgPlugins\ (Windows)
 */

(function () {
    'use strict';

    const fs = require('fs');
    const path = require('path');

    class PluginManager {
        constructor() {
            this.plugins = new Map();
            this.pluginConfigs = new Map();
            this.initialized = false;
            this.configPath = null;
            this.pluginsDir = null;
            this.baseDir = null;
            this.versionInfo = null;
            this.serverUrl = '';  // 服务器地址（由安装脚本写入 plugin-config.json，启动时自动加载）
            this.guideShown = false;  // 首次安装指引是否已展示过
            this.devMode = false;     // 开发模式标记（由 dev-link.js 写入 plugin-config.json）

            console.log('[PluginManager] 🚀 插件管理器 v2.0 创建');
        }

        /**
         * 初始化插件管理器
         */
        async init() {
            if (this.initialized) {
                console.warn('[PluginManager] 已经初始化，跳过');
                return;
            }

            try {
                // 获取基础目录 - 即 core 目录的上一级
                // 注意：开发模式下 core/ 是 symlink，__dirname 会被 Node.js 解析为源码真实路径
                // 因此必须先从磁盘获取 symlink 本身的路径，再向上取上级目录
                const realCoreDir = (() => {
                    try {
                        // fs.realpathSync 会解析 symlink；在生产环境下等同于 __dirname
                        // 但开发模式下 __dirname 已经是源码目录（Node 跟随 symlink 了），
                        // 所以我们改为通过固定平台路径来确定运行时目录
                        const os = require('os');
                        if (process.platform === 'darwin') {
                            const runtimeDir = path.join(os.homedir(), 'Library', 'Application Support', 'EpointMsgPlugins');
                            // 如果运行时目录里 core 子目录指向我们自己，则以运行时目录为准
                            if (require('fs').existsSync(runtimeDir)) {
                                return runtimeDir;
                            }
                        } else if (process.platform === 'win32') {
                            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
                            const runtimeDir = path.join(appData, 'EpointMsgPlugins');
                            if (require('fs').existsSync(runtimeDir)) {
                                return runtimeDir;
                            }
                        }
                    } catch (_) {}
                    // 兜底：原来的逻辑（生产环境 symlink 不存在时）
                    return path.dirname(__dirname);
                })();
                this.baseDir = realCoreDir;
                this.pluginsDir = path.join(this.baseDir, 'plugins');
                this.configPath = path.join(this.baseDir, 'plugin-config.json');

                console.log('[PluginManager] 核心目录:', __dirname);
                console.log('[PluginManager] 基础目录:', this.baseDir);
                console.log('[PluginManager] 插件目录:', this.pluginsDir);
                console.log('[PluginManager] 配置文件:', this.configPath);

                // 确保目录存在
                this.ensureDirectories();

                // 加载版本信息
                this.loadVersionInfo();

                // 加载配置
                this.loadConfig();

                // 加载同步器（在 DOM 就绪前加载，以便同步阶段可用）
                this.loadUpdater();

                // 等待 DOM 就绪后再初始化
                await this._waitForDOMReady();

                // 启动时先同步核心组件（静默，更新后标记需要重启）
                if (window.Updater) {
                    window.Updater.baseDir = this.baseDir;
                    await window.Updater.syncCore();
                }

                // 再全量同步插件（静默，失败则用本地组件）
                if (window.Updater) {
                    await window.Updater.syncPlugins();
                }

                // 先加载配置面板（注册导航栏图标），再加载插件
                // 确保插件 init 时 plugin-manager-nav-icon 已存在
                this.loadConfigPanel();

                // 加载心跳上报模块
                this.loadHeartbeat();

                // 加载所有插件（在配置面板之后，保证导航图标顺序正确）
                await this.loadPlugins();

                this.initialized = true;
                console.log('[PluginManager] ✅ 初始化完成');

            } catch (error) {
                console.error('[PluginManager] ❌ 初始化失败:', error);
            }
        }

        /**
         * 等待 DOM 就绪 + 额外延迟，确保 IM 应用页面完全渲染
         */
        _waitForDOMReady() {
            return new Promise((resolve) => {
                const EXTRA_DELAY_MS = 3000; // IM 应用渲染需要额外时间

                const onReady = () => {
                    console.log(`[PluginManager] ⏳ DOM 已就绪，等待 ${EXTRA_DELAY_MS}ms 让 IM 完成渲染...`);
                    setTimeout(() => {
                        console.log('[PluginManager] ✅ 页面就绪，开始加载插件');
                        resolve();
                    }, EXTRA_DELAY_MS);
                };

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', onReady, { once: true });
                } else {
                    onReady();
                }
            });
        }

        /**
         * 确保目录存在
         */
        ensureDirectories() {
            const dirs = [
                this.pluginsDir
            ];

            dirs.forEach(dir => {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                    console.log('[PluginManager] 创建目录:', dir);
                }
            });
        }

        /**
         * 加载版本信息
         */
        loadVersionInfo() {
            const versionPath = path.join(this.baseDir, '.version.json');
            try {
                if (fs.existsSync(versionPath)) {
                    const data = fs.readFileSync(versionPath, 'utf-8');
                    this.versionInfo = JSON.parse(data.trim());
                    console.log('[PluginManager] 版本信息:', this.versionInfo);
                } else {
                    this.versionInfo = {
                        coreVersion: '2.0.0',
                        installTime: new Date().toISOString(),
                        lastUpdate: new Date().toISOString()
                    };
                    fs.writeFileSync(versionPath, JSON.stringify(this.versionInfo), 'utf-8');
                }
            } catch (error) {
                console.error('[PluginManager] 加载版本信息失败:', error);
                this.versionInfo = { coreVersion: '2.0.0' };
            }
        }

        /**
         * 加载配置文件
         */
        loadConfig() {
            try {
                if (fs.existsSync(this.configPath)) {
                    let configData = fs.readFileSync(this.configPath, 'utf-8');
                    // 去掉 BOM 头（Windows PowerShell 写入的文件可能带 UTF-8 BOM）
                    if (configData.charCodeAt(0) === 0xFEFF) {
                        configData = configData.slice(1);
                    }
                    const config = JSON.parse(configData.trim());

                    // 支持从配置文件读取服务器地址
                    if (config.serverUrl) {
                        this.serverUrl = config.serverUrl;
                    }

                    // 读取首次安装指引状态
                    if (config.guideShown) {
                        this.guideShown = true;
                    }

                    // 读取开发模式标记
                    if (config.devMode) {
                        this.devMode = true;
                        console.log('[PluginManager] 🛠️  开发模式 (devMode: true)');
                    }

                    if (config.plugins && Array.isArray(config.plugins)) {
                        config.plugins.forEach(pluginConfig => {
                            this.pluginConfigs.set(pluginConfig.id, pluginConfig);
                        });
                    }

                    console.log('[PluginManager] ✅ 配置已加载，插件数:', this.pluginConfigs.size);
                    console.log('[PluginManager] 📡 服务器地址:', this.serverUrl || '未配置');
                } else {
                    // 配置文件不存在（安装脚本尚未运行或目录被清空）
                    // 不主动创建文件：plugin-config.json 由安装脚本负责写入（含 serverUrl）
                    // 运行时自行创建会产生缺少 serverUrl 的空文件，导致地址丢失
                    console.log('[PluginManager] 配置文件不存在，等待安装脚本写入，使用内存默认配置');
                }
            } catch (error) {
                console.error('[PluginManager] 配置加载失败:', error);
            }
        }

        /**
         * 保存配置文件
         * 注意：serverUrl 由安装脚本写入，此处不覆盖，保存前先从磁盘读取已有值做合并
         */
        saveConfig() {
            try {
                // 读取磁盘上现有配置，保留安装脚本写入的字段（如 serverUrl）
                let existingConfig = {};
                if (fs.existsSync(this.configPath)) {
                    try {
                        let raw = fs.readFileSync(this.configPath, 'utf-8');
                        // 去掉 BOM 头（Windows PowerShell 写入的文件可能带 UTF-8 BOM）
                        if (raw.charCodeAt(0) === 0xFEFF) {
                            raw = raw.slice(1);
                        }
                        existingConfig = JSON.parse(raw.trim());
                    } catch (e) {
                        console.warn('[PluginManager] ⚠️ 解析已有配置文件失败，将使用空配置:', e.message);
                    }
                }

                const config = {
                    ...existingConfig,             // 保留安装脚本写入的所有字段（含 serverUrl）
                    version: '2.0.0',
                    lastUpdate: new Date().toISOString(),
                    guideShown: this.guideShown,
                    plugins: Array.from(this.pluginConfigs.values())
                    // 不写 serverUrl：该字段由安装脚本独立管理，运行时不应覆盖
                };

                fs.writeFileSync(this.configPath, JSON.stringify(config), 'utf-8');
                console.log('[PluginManager] ✅ 配置已保存');
            } catch (error) {
                console.error('[PluginManager] 配置保存失败:', error);
            }
        }

        /**
         * 加载所有插件
         */
        async loadPlugins() {
            if (!fs.existsSync(this.pluginsDir)) {
                console.warn('[PluginManager] 插件目录不存在');
                return;
            }

            try {
                const files = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
                const pluginEntries = [];

                for (const dirent of files) {
                    if (dirent.isDirectory()) {
                        const mainPath = path.join(this.pluginsDir, dirent.name, 'main.js');
                        if (fs.existsSync(mainPath)) {
                            pluginEntries.push({
                                id: dirent.name,
                                entryPath: mainPath
                            });
                        }
                    } else if (dirent.isFile() && dirent.name.endsWith('.js')) {
                        pluginEntries.push({
                            id: path.basename(dirent.name, '.js'),
                            entryPath: path.join(this.pluginsDir, dirent.name)
                        });
                    }
                }

                pluginEntries.sort((a, b) => a.id.localeCompare(b.id));

                console.log(`[PluginManager] 发现 ${pluginEntries.length} 个插件:`, pluginEntries.map(p => p.id));

                for (const entry of pluginEntries) {
                    await this.loadPlugin(entry);
                }

                console.log(`[PluginManager] ✅ 已加载 ${this.plugins.size} 个插件`);
            } catch (error) {
                console.error('[PluginManager] 加载插件失败:', error);
            }
        }

        /**
         * 加载单个插件
         */
        async loadPlugin(entry) {
            let pluginId, filePath;
            if (typeof entry === 'string') {
                pluginId = path.basename(entry, '.js');
                const dirPath = path.join(this.pluginsDir, pluginId);
                const mainPath = path.join(dirPath, 'main.js');
                
                if (fs.existsSync(mainPath)) {
                    filePath = mainPath;
                } else {
                    filePath = path.join(this.pluginsDir, entry);
                }
            } else {
                pluginId = entry.id;
                filePath = entry.entryPath;
            }

            try {
                console.log(`[PluginManager] 加载插件: ${pluginId}`);

                // 清除 require 缓存以支持热重载
                delete require.cache[require.resolve(filePath)];

                const pluginModule = require(filePath);

                if (!pluginModule || typeof pluginModule.init !== 'function') {
                    console.error(`[PluginManager] ❌ 插件格式错误: ${pluginId} (缺少 init 方法)`);
                    return;
                }

                // 尝试从 manifest.json 读取打包时的版本号（优先于 main.js 中的 version 字段）
                let manifestVersion = null;
                try {
                    const manifestPath = path.join(path.dirname(filePath), 'manifest.json');
                    if (fs.existsSync(manifestPath)) {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                        if (manifest.version && manifest.version !== 'dev') {
                            manifestVersion = manifest.version;
                        }
                    }
                } catch (_) { /* manifest.json 不存在或解析失败，忽略 */ }

                // 开发模式下强制显示 'dev'，避免误以为是正式发布版本
                const resolvedVersion = this.devMode ? 'dev' : (manifestVersion || pluginModule.version || '1.0.0');

                let config = this.pluginConfigs.get(pluginId);
                if (!config) {
                    // 首次加载：使用插件模块的默认值
                    config = {
                        id: pluginId,
                        name: pluginModule.name || pluginId,
                        description: pluginModule.description || '',
                        version: resolvedVersion,
                        enabled: pluginModule.defaultEnabled !== false,
                        config: pluginModule.defaultConfig || {}
                    };
                    this.pluginConfigs.set(pluginId, config);
                } else {
                    // 重载/更新：同步元数据到最新版本，保留用户的 enabled 状态和自定义配置
                    config.name = pluginModule.name || pluginId;
                    config.description = pluginModule.description || '';
                    config.version = resolvedVersion;

                    // 合并 defaultConfig 中的新增配置项（不覆盖用户已设置的值）
                    const defaultConfig = pluginModule.defaultConfig || {};
                    const currentConfig = config.config || {};
                    for (const [key, value] of Object.entries(defaultConfig)) {
                        if (!(key in currentConfig)) {
                            currentConfig[key] = value;
                        }
                    }
                    // 移除新版本不再需要的配置项
                    for (const key of Object.keys(currentConfig)) {
                        if (!(key in defaultConfig)) {
                            delete currentConfig[key];
                        }
                    }
                    config.config = currentConfig;
                }

                this.plugins.set(pluginId, {
                    module: pluginModule,
                    config: config,
                    instance: null
                });

                if (config.enabled) {
                    await this.initPlugin(pluginId);
                }

                console.log(`[PluginManager] ✅ 插件已加载: ${config.name} (${config.enabled ? '已启用' : '已禁用'})`);
            } catch (error) {
                console.error(`[PluginManager] ❌ 加载插件失败: ${pluginId || entry}`, error);
            }
        }

        /**
         * 初始化插件
         * @returns {{ success: boolean, message?: string }} 初始化结果
         */
        async initPlugin(pluginId) {
            const plugin = this.plugins.get(pluginId);
            if (!plugin) return { success: false, message: '插件不存在' };

            try {
                if (plugin.instance) return { success: true };

                console.log(`[PluginManager] 初始化插件: ${pluginId}`);
                const result = await plugin.module.init(plugin.config.config, this);

                // 插件 init 可返回 { success: false, message: '...' } 表示启动失败
                if (result && result.success === false) {
                    console.error(`[PluginManager] ❌ 插件初始化失败: ${pluginId}`, result.message);
                    return { success: false, message: result.message || '插件初始化失败' };
                }

                plugin.instance = result;
                console.log(`[PluginManager] ✅ 插件已初始化: ${pluginId}`);
                return { success: true };
            } catch (error) {
                console.error(`[PluginManager] ❌ 插件初始化异常: ${pluginId}`, error);
                return { success: false, message: error.message || '插件初始化异常' };
            }
        }

        /**
         * 销毁插件
         */
        async destroyPlugin(pluginId) {
            const plugin = this.plugins.get(pluginId);
            if (!plugin || !plugin.instance) return;

            try {
                if (typeof plugin.module.destroy === 'function') {
                    await plugin.module.destroy(plugin.instance);
                }
                plugin.instance = null;
                console.log(`[PluginManager] ✅ 插件已销毁: ${pluginId}`);
            } catch (error) {
                console.error(`[PluginManager] ❌ 插件销毁失败: ${pluginId}`, error);
            }
        }

        /**
         * 显示页面加载动画遮罩层（防止连点）
         */
        showLoading(pluginId) {
            if (document.getElementById('plugin-manager-loading-overlay')) return;
            
            const config = this.pluginConfigs.get(pluginId);
            const pluginName = config ? config.name : pluginId;

            const overlay = document.createElement('div');
            overlay.id = 'plugin-manager-loading-overlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.4);
                backdrop-filter: blur(2px);
                z-index: 9999999;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            `;

            overlay.innerHTML = `
                <style>
                    @keyframes plugin-spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .plugin-loading-spinner {
                        width: 40px;
                        height: 40px;
                        border: 3px solid rgba(255, 255, 255, 0.3);
                        border-top: 3px solid #ffffff;
                        border-radius: 50%;
                        animation: plugin-spin 1s linear infinite;
                        margin-bottom: 16px;
                    }
                    .plugin-loading-text {
                        font-size: 16px;
                        font-weight: 500;
                        margin: 0 0 8px 0;
                        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
                    }
                    .plugin-loading-subtext {
                        font-size: 13px;
                        color: rgba(255, 255, 255, 0.8);
                        margin: 0;
                        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
                    }
                </style>
                <div class="plugin-loading-spinner"></div>
                <h3 class="plugin-loading-text">正在启用插件</h3>
                <p class="plugin-loading-subtext">${pluginName} 正在初始化，请稍候...</p>
            `;

            document.body.appendChild(overlay);
        }

        /**
         * 隐藏加载动画遮罩层
         */
        hideLoading() {
            const overlay = document.getElementById('plugin-manager-loading-overlay');
            if (overlay) {
                overlay.remove();
            }
        }

        /**
         * 启用插件
         * @returns {{ success: boolean, message?: string }} 启用结果
         */
        async enablePlugin(pluginId) {
            const config = this.pluginConfigs.get(pluginId);
            if (!config || config.enabled) return { success: true };

            this.showLoading(pluginId);
            try {
                config.enabled = true;
                const result = await this.initPlugin(pluginId);

                if (!result.success) {
                    // 初始化失败，回滚启用状态
                    config.enabled = false;
                    console.log(`[PluginManager] ⚠️ 插件启用失败，已回滚: ${pluginId}`);
                    return result;
                }

                this.saveConfig();
                console.log(`[PluginManager] ✅ 插件已启用: ${pluginId}`);
                return { success: true };
            } finally {
                this.hideLoading();
            }
        }

        /**
         * 禁用插件
         */
        async disablePlugin(pluginId) {
            const config = this.pluginConfigs.get(pluginId);
            if (!config || !config.enabled) return;

            config.enabled = false;
            await this.destroyPlugin(pluginId);
            this.saveConfig();
            console.log(`[PluginManager] ✅ 插件已禁用: ${pluginId}`);
        }

        /**
         * 更新插件配置
         */
        async updatePluginConfig(pluginId, newConfig) {
            const config = this.pluginConfigs.get(pluginId);
            if (!config) return;

            config.config = { ...config.config, ...newConfig };

            if (config.enabled) {
                await this.destroyPlugin(pluginId);
                await this.initPlugin(pluginId);
            }

            this.saveConfig();
            console.log(`[PluginManager] ✅ 插件配置已更新: ${pluginId}`);
        }

        /**
         * 检查插件文件是否存在于本地磁盘
         * @param {string} pluginId - 插件ID
         * @returns {boolean}
         */
        isPluginInstalled(pluginId) {
            // 目录型插件: plugins/{id}/main.js
            const dirMain = path.join(this.pluginsDir, pluginId, 'main.js');
            if (fs.existsSync(dirMain)) return true;
            // 单文件插件: plugins/{id}.js
            const singleFile = path.join(this.pluginsDir, `${pluginId}.js`);
            if (fs.existsSync(singleFile)) return true;
            return false;
        }

        /**
         * 获取所有插件信息
         */
        getAllPlugins() {
            return Array.from(this.pluginConfigs.values());
        }

        /**
         * 获取插件实例
         */
        getPlugin(pluginId) {
            const plugin = this.plugins.get(pluginId);
            return plugin ? plugin.instance : null;
        }

        /**
         * 获取插件模块定义（包含 configMeta 等元数据）
         */
        getPluginModule(pluginId) {
            const plugin = this.plugins.get(pluginId);
            return plugin ? plugin.module : null;
        }

        /**
         * 获取基础目录
         */
        getBaseDir() {
            return this.baseDir;
        }

        /**
         * 获取版本信息
         */
        getVersionInfo() {
            return this.versionInfo;
        }

        /**
         * 获取全局服务器地址
         * 所有模块（Updater、Heartbeat、插件）统一通过此方法获取
         */
        getServerUrl() {
            return this.serverUrl;
        }

        /**
         * 设置全局服务器地址（仅更新内存，不写入配置文件）
         * serverUrl 由安装脚本写入 plugin-config.json，运行时只读
         */
        setServerUrl(url) {
            this.serverUrl = url;
            // 不调用 saveConfig()：serverUrl 不允许被运行时覆盖
        }

        /**
         * 获取首次安装指引是否已展示
         */
        isGuideShown() {
            return this.guideShown;
        }

        /**
         * 标记首次安装指引已展示
         */
        setGuideShown(shown = true) {
            this.guideShown = shown;
            this.saveConfig();
        }

        /**
         * 重载所有插件
         */
        async reload() {
            console.log('[PluginManager] 🔄 重载所有插件...');

            for (const [pluginId] of this.plugins) {
                await this.destroyPlugin(pluginId);
            }

            this.plugins.clear();

            // 重新加载配置文件，确保获取最新的持久化配置
            this.pluginConfigs.clear();
            this.loadConfig();

            await this.loadPlugins();

            // 保存合并后的最新配置（含新版本的元数据）
            this.saveConfig();

            console.log('[PluginManager] ✅ 插件重载完成');
        }

        /**
         * 加载配置面板模块
         */
        loadConfigPanel() {
            const panelPath = path.join(__dirname, 'config-panel.js');
            if (fs.existsSync(panelPath)) {
                try {
                    delete require.cache[require.resolve(panelPath)];
                    require(panelPath);
                    console.log('[PluginManager] ✅ 配置面板已加载');
                } catch (error) {
                    console.error('[PluginManager] ❌ 配置面板加载失败:', error);
                }
            }
        }

        /**
         * 加载更新检查器
         */
        loadUpdater() {
            const updaterPath = path.join(__dirname, 'updater.js');
            if (fs.existsSync(updaterPath)) {
                try {
                    delete require.cache[require.resolve(updaterPath)];
                    require(updaterPath);
                    console.log('[PluginManager] ✅ 更新检查器已加载');
                } catch (error) {
                    console.error('[PluginManager] ❌ 更新检查器加载失败:', error);
                }
            }
        }

        /**
         * 加载心跳上报模块
         */
        loadHeartbeat() {
            const heartbeatPath = path.join(__dirname, 'heartbeat.js');
            if (fs.existsSync(heartbeatPath)) {
                try {
                    delete require.cache[require.resolve(heartbeatPath)];
                    require(heartbeatPath);
                    console.log('[PluginManager] ✅ 心跳模块已加载');
                } catch (error) {
                    console.error('[PluginManager] ❌ 心跳模块加载失败:', error);
                }
            }
        }

        /**
         * 插件写日志（同时输出到 console 和插件目录下的日志文件）
         * @param {string} pluginId - 插件ID
         * @param {string} message - 日志内容
         * @param {'log'|'warn'|'error'} [level='log'] - 日志级别
         */
        log(pluginId, message, level = 'log') {
            if (!pluginId || !message) {
                console.warn('[PluginManager] log 方法需要 pluginId 和 message 两个参数');
                return;
            }

            // 1. 输出到 console
            const consoleFn = console[level] || console.log;
            consoleFn.call(console, message);

            // 2. 输出到插件目录下的日志文件
            const pluginDir = path.join(this.pluginsDir, pluginId);
            if (!fs.existsSync(pluginDir)) {
                return;
            }

            const logDir = path.join(pluginDir, 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const today = new Date().toISOString().split('T')[0];
            const logFile = path.join(logDir, `${today}.log`);
            const timestamp = new Date().toISOString();
            const levelTag = level !== 'log' ? ` [${level.toUpperCase()}]` : '';
            const logLine = `[${timestamp}]${levelTag} ${message}\n`;

            try {
                fs.appendFileSync(logFile, logLine, 'utf-8');
            } catch (error) {
                console.error(`[PluginManager] 插件 ${pluginId} 写入日志失败:`, error);
            }
        }
    }

    // 创建全局单例
    window.PluginManager = new PluginManager();

    // 自动初始化
    window.PluginManager.init();

    console.log('[PluginManager] 📦 已注册到 window.PluginManager');
})();
