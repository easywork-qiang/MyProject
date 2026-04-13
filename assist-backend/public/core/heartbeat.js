/**
 * 心跳上报模块 (Heartbeat)
 * 定期向后端服务上报客户端状态，并处理服务端下发的指令
 *
 * 功能：
 * 1. 定时上报心跳（userInfo + 插件列表）
 * 2. 处理服务端响应：
 *    - 公告通知展示
 *    - 远程配置应用
 *    - 灰度更新触发
 * 3. 从 localStorage 读取 IM 用户信息
 */

(function () {
    'use strict';

    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');

    class Heartbeat {
        constructor() {
            this.timer = null;
            this.serverUrl = '';       // 后端服务地址（不含 /api/client/heartbeat）
            this.interval = 5 * 60 * 1000;   // 默认 5 分钟
            this.initialDelay = 10 * 1000;   // 首次心跳延迟 10 秒
            this.isRunning = false;
            this.lastResponse = null;        // 最近一次心跳响应

            // 公告展示状态
            this._announcementContainer = null;

            console.log('[Heartbeat] 💓 心跳模块创建');
        }

        /**
         * 初始化
         */
        init() {
            if (!window.PluginManager) {
                console.error('[Heartbeat] PluginManager 未就绪');
                return;
            }

            // 从 updater 配置中获取后端地址
            this._loadServerUrl();

            if (!this.serverUrl) {
                console.log('[Heartbeat] ⚠️ 服务器地址未配置，心跳功能暂不启用');
                return;
            }

            // 启动定时心跳
            this._scheduleHeartbeat();
            this.isRunning = true;

            console.log('[Heartbeat] ✅ 初始化完成');
            console.log('[Heartbeat] 服务器地址:', this.serverUrl);
        }

        /**
         * 从 PluginManager 全局配置获取后端服务器地址
         */
        _loadServerUrl() {
            try {
                const serverUrl = window.PluginManager.getServerUrl();
                if (serverUrl) {
                    this.serverUrl = serverUrl.replace(/\/+$/, '');
                    console.log('[Heartbeat] 服务器地址:', this.serverUrl);
                }
            } catch (err) {
                console.error('[Heartbeat] 获取服务器地址失败:', err);
            }
        }

        /**
         * 调度心跳定时器
         */
        _scheduleHeartbeat() {
            // 首次心跳：延迟 initialDelay + 随机抖动
            const initialJitter = Math.floor(Math.random() * 5000);
            setTimeout(() => {
                this._doHeartbeat();
                // 后续定时
                this._scheduleNextHeartbeat();
            }, this.initialDelay + initialJitter);
        }

        /**
         * 调度下一次心跳（带抖动）
         */
        _scheduleNextHeartbeat() {
            const jitter = (Math.random() - 0.5) * 0.2 * this.interval;
            this.timer = setTimeout(() => {
                this._doHeartbeat();
                this._scheduleNextHeartbeat();
            }, this.interval + jitter);
        }

        /**
         * 执行一次心跳上报
         */
        async _doHeartbeat() {
            try {
                const payload = this._buildPayload();
                console.log('[Heartbeat] 📡 发送心跳...');

                const response = await fetch(`${this.serverUrl}/api/client/heartbeat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();
                this.lastResponse = data;
                console.log('[Heartbeat] ✅ 心跳响应:', JSON.stringify(data).substring(0, 200));

                // 处理响应
                this._handleResponse(data);
            } catch (err) {
                console.error('[Heartbeat] ❌ 心跳失败:', err.message);
            }
        }

        /**
         * 构建心跳请求体
         */
        _buildPayload() {
            const userInfo = this._getUserInfoFromStorage();
            const versionInfo = window.PluginManager.getVersionInfo() || {};
            const plugins = this._getPluginList();
            const coreComponents = this._getCoreComponents(versionInfo);

            return {
                userInfo: userInfo,
                platform: process.platform || 'unknown',
                appVersion: this._getAppVersion(),
                coreVersion: versionInfo.coreVersion || '2.0.0',
                coreComponents: coreComponents,
                plugins: plugins,
            };
        }

        /**
         * 从 localStorage 中读取当前 IM 用户信息
         * key 格式: {appId}auth，遍历查找以 'auth' 结尾的 key
         * 安全要求：不上报 token、code、rceToken 等敏感鉴权信息
         */
        _getUserInfoFromStorage() {
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.endsWith('auth') && key.length > 4) {
                        const raw = localStorage.getItem(key);
                        const parsed = JSON.parse(raw);
                        if (parsed && parsed.data && parsed.data.id) {
                            const d = parsed.data;
                            const orgInfo = d.orgsInfo && d.orgsInfo[0];
                            const companyNode = orgInfo?.path?.find(p => p.type === 2);
                            return {
                                id: d.id,
                                name: d.name,
                                portrait: d.portrait || '',
                                companyId: d.companyId || '',
                                companyName: companyNode?.name || '',
                                deptId: d.deptId || '',
                                deptName: orgInfo?.name || '',
                                isStaff: d.isStaff || false,
                            };
                        }
                    }
                }
            } catch (e) {
                console.error('[Heartbeat] 读取 localStorage 用户信息失败:', e);
            }

            // Fallback: 从 RongIM 运行时对象获取基础信息
            try {
                const auth = window.RongIM?.instance?.auth;
                if (auth && auth.id) {
                    return { id: auth.id, name: auth.name || auth.id };
                }
            } catch (e) { /* ignore */ }

            return null;
        }

        /**
         * 获取宿主 IM 应用版本号
         */
        _getAppVersion() {
            try {
                const remote = this._getElectronRemote();
                return remote.app.getVersion();
            } catch (e) {
                return 'unknown';
            }
        }

        /**
         * 获取 @electron/remote 模块（兼容插件系统的模块解析路径）
         */
        _getElectronRemote() {
            try { return require('@electron/remote'); } catch (e) { /* ignore */ }

            let parentModule = module.parent;
            while (parentModule) {
                try { return parentModule.require('@electron/remote'); } catch (e) { parentModule = parentModule.parent; }
            }

            if (process.mainModule) {
                try { return process.mainModule.require('@electron/remote'); } catch (e) { /* ignore */ }
            }

            throw new Error('无法加载 @electron/remote 模块');
        }

        /**
         * 获取当前已安装的插件列表（脱敏后）
         */
        _getPluginList() {
            try {
                const allPlugins = window.PluginManager.getAllPlugins();
                return allPlugins.map(p => ({
                    id: p.id,
                    version: p.version || '1.0.0',
                    enabled: p.enabled !== false,
                    config: this._sanitizeConfig(p.config || {}),
                }));
            } catch (e) {
                return [];
            }
        }

        /**
         * 获取核心组件信息列表
         * 从 versionInfo.coreVersions 中读取，转换为 [{id, version}] 数组
         */
        _getCoreComponents(versionInfo) {
            try {
                const coreVersions = versionInfo.coreVersions || {};
                const components = Object.entries(coreVersions).map(([id, version]) => ({
                    id: id,
                    version: version || 'unknown',
                }));
                return components.length > 0 ? components : [];
            } catch (e) {
                console.error('[Heartbeat] 获取核心组件信息失败:', e);
                return [];
            }
        }

        /**
         * 插件配置脱敏 — 将 password 等敏感字段替换为 '***'
         */
        _sanitizeConfig(config) {
            const sanitized = {};
            const sensitiveKeys = ['password', 'secret', 'token', 'apiKey', 'api_key'];
            for (const [key, value] of Object.entries(config)) {
                if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
                    sanitized[key] = '***';
                } else {
                    sanitized[key] = value;
                }
            }
            return sanitized;
        }

        // =============================================
        // 心跳响应处理
        // =============================================

        /**
         * 处理心跳响应
         */
        _handleResponse(data) {
            if (!data || !data.ok) return;

            // 1. 处理公告通知
            if (data.announcements && data.announcements.length > 0) {
                this._handleAnnouncements(data.announcements);
            }

            // 2. 处理远程配置
            if (data.remoteConfig && Object.keys(data.remoteConfig).length > 0) {
                this._handleRemoteConfig(data.remoteConfig);
            }

            // 3. 处理灰度更新指令
            if (data.update && Object.keys(data.update).length > 0) {
                this._handleGrayscaleUpdate(data.update);
            }
        }

        /**
         * 处理公告通知 — 在页面上展示公告弹窗
         */
        _handleAnnouncements(announcements) {
            console.log(`[Heartbeat] 📢 收到 ${announcements.length} 条未读公告`);

            // 逐条展示公告
            announcements.forEach((announcement, index) => {
                setTimeout(() => {
                    this._showAnnouncement(announcement);
                }, index * 500); // 间隔 500ms 依次展示
            });
        }

        /**
         * 展示单条公告
         */
        _showAnnouncement(announcement) {
            const typeConfig = {
                info: { icon: 'ℹ️', color: '#3498db', bg: '#ebf5fb' },
                warning: { icon: '⚠️', color: '#f39c12', bg: '#fef9e7' },
                critical: { icon: '🚨', color: '#e74c3c', bg: '#fdedec' },
            };

            const cfg = typeConfig[announcement.type] || typeConfig.info;

            // 创建公告容器（如果不存在）
            if (!this._announcementContainer) {
                this._announcementContainer = document.createElement('div');
                Object.assign(this._announcementContainer.style, {
                    position: 'fixed',
                    top: '16px',
                    right: '16px',
                    zIndex: '99999',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    maxWidth: '380px',
                    pointerEvents: 'none',
                });
                document.body.appendChild(this._announcementContainer);
            }

            const el = document.createElement('div');
            el.style.pointerEvents = 'auto';
            el.innerHTML = `
                <div style="
                    background: ${cfg.bg};
                    border-left: 4px solid ${cfg.color};
                    border-radius: 8px;
                    padding: 14px 16px;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    animation: heartbeatSlideIn 0.3s ease-out;
                    position: relative;
                ">
                    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                        <span style="font-size:16px">${cfg.icon}</span>
                        <strong style="font-size:14px; color:#333;">${announcement.title}</strong>
                    </div>
                    <div style="font-size:13px; color:#555; line-height:1.5;">${announcement.content}</div>
                    <button onclick="this.parentElement.parentElement.remove()" style="
                        position:absolute; top:8px; right:8px;
                        background:none; border:none; cursor:pointer;
                        font-size:16px; color:#999; line-height:1;
                    ">×</button>
                </div>
            `;

            this._announcementContainer.appendChild(el);

            // 注入动画样式（仅一次）
            if (!document.getElementById('heartbeat-announce-style')) {
                const style = document.createElement('style');
                style.id = 'heartbeat-announce-style';
                style.textContent = `
                    @keyframes heartbeatSlideIn {
                        from { opacity: 0; transform: translateX(40px); }
                        to   { opacity: 1; transform: translateX(0); }
                    }
                `;
                document.head.appendChild(style);
            }

            // 标记已读
            this._markAnnouncementRead(announcement.id);

            // 10 秒后自动消失
            setTimeout(() => {
                if (el.parentNode) {
                    el.style.transition = 'opacity 0.3s, transform 0.3s';
                    el.style.opacity = '0';
                    el.style.transform = 'translateX(40px)';
                    setTimeout(() => el.remove(), 300);
                }
            }, 10000);
        }

        /**
         * 标记公告已读
         */
        async _markAnnouncementRead(announcementId) {
            try {
                await fetch(`${this.serverUrl}/api/client/announcements/${announcementId}/read`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
            } catch (err) {
                console.error('[Heartbeat] 标记公告已读失败:', err.message);
            }
        }

        /**
         * 处理远程配置
         * 将服务端下发的配置合并到本地插件配置中，远程优先
         */
        _handleRemoteConfig(remoteConfig) {
            console.log('[Heartbeat] 🔧 收到远程配置:', Object.keys(remoteConfig));

            for (const [configKey, configValue] of Object.entries(remoteConfig)) {
                try {
                    if (configKey.startsWith('plugin:')) {
                        // 格式: plugin:<pluginId>:enabled 或 plugin:<pluginId>:config:<key>
                        const parts = configKey.split(':');
                        const pluginId = parts[1];

                        if (parts[2] === 'enabled') {
                            // 远程启用/禁用插件
                            const shouldEnable = configValue === true || configValue === 'true';
                            const allPlugins = window.PluginManager.getAllPlugins();
                            const pluginConfig = allPlugins.find(p => p.id === pluginId);

                            if (pluginConfig) {
                                if (shouldEnable && !pluginConfig.enabled) {
                                    window.PluginManager.enablePlugin(pluginId);
                                    console.log(`[Heartbeat] 🔧 远程启用插件: ${pluginId}`);
                                } else if (!shouldEnable && pluginConfig.enabled) {
                                    window.PluginManager.disablePlugin(pluginId);
                                    console.log(`[Heartbeat] 🔧 远程禁用插件: ${pluginId}`);
                                }
                            }
                        } else if (parts[2] === 'config' && parts[3]) {
                            // 远程覆盖插件配置项
                            const configItemKey = parts[3];
                            window.PluginManager.updatePluginConfig(pluginId, { [configItemKey]: configValue });
                            console.log(`[Heartbeat] 🔧 远程配置插件 ${pluginId}.${configItemKey} = ${configValue}`);
                        }
                    } else if (configKey.startsWith('global:')) {
                        // 全局配置 — 存储到 window 供插件读取
                        const globalKey = configKey.replace('global:', '');
                        window.__remoteGlobalConfig = window.__remoteGlobalConfig || {};
                        window.__remoteGlobalConfig[globalKey] = configValue;
                        console.log(`[Heartbeat] 🔧 全局配置: ${globalKey} = ${configValue}`);
                    }
                } catch (err) {
                    console.error(`[Heartbeat] 远程配置应用失败 [${configKey}]:`, err);
                }
            }
        }

        /**
         * 处理灰度更新指令
         * 服务端在心跳响应中通过 update 字段下发灰度版本信息
         */
        _handleGrayscaleUpdate(updates) {
            console.log('[Heartbeat] 🔄 收到灰度更新指令:', Object.keys(updates));

            if (!window.Updater) {
                console.warn('[Heartbeat] Updater 未就绪，无法处理灰度更新');
                return;
            }

            // updates 格式: { "pluginId": { version, file, hash } }
            for (const [pluginId, updateInfo] of Object.entries(updates)) {
                try {
                    console.log(`[Heartbeat] 🔄 灰度更新: ${pluginId} → v${updateInfo.version}`);

                    const remotePlugin = {
                        id: pluginId,
                        version: updateInfo.version,
                        file: updateInfo.file,
                        hash: updateInfo.hash,
                        format: updateInfo.format || 'zip',
                    };

                    // 直接调用 Updater 的下载安装方法（静默）
                    window.Updater._downloadAndInstall(remotePlugin).then(async () => {
                        console.log(`[Heartbeat] ✅ 灰度更新完成: ${pluginId} v${updateInfo.version}`);
                        // 重新加载插件
                        try {
                            await window.PluginManager.destroyPlugin(pluginId);
                            await window.PluginManager.loadPlugin(pluginId);
                        } catch (e) {
                            console.warn(`[Heartbeat] 插件重载跳过: ${pluginId}`);
                        }
                    }).catch(err => {
                        console.error(`[Heartbeat] ❌ 灰度更新失败: ${pluginId}`, err.message);
                    });
                } catch (err) {
                    console.error(`[Heartbeat] 灰度更新处理失败 [${pluginId}]:`, err);
                }
            }
        }

        // =============================================
        // 公共方法
        // =============================================

        /**
         * 手动触发一次心跳
         */
        async sendHeartbeat() {
            await this._doHeartbeat();
        }

        /**
         * 获取最近一次心跳响应
         */
        getLastResponse() {
            return this.lastResponse;
        }

        /**
         * 设置服务器地址
         */
        setServerUrl(url) {
            this.serverUrl = url;
            console.log('[Heartbeat] 服务器地址已设置:', url);
        }

        /**
         * 销毁
         */
        destroy() {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            if (this._announcementContainer) {
                this._announcementContainer.remove();
                this._announcementContainer = null;
            }
            this.isRunning = false;
            console.log('[Heartbeat] 💔 已销毁');
        }
    }

    // 创建全局实例
    window.Heartbeat = new Heartbeat();
    window.Heartbeat.init();

    console.log('[Heartbeat] 💓 心跳模块已注册到 window.Heartbeat');
})();
