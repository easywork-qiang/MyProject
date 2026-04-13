/**
 * 插件配置面板 v2.0
 * 提供可视化的插件管理和配置界面
 */

(function () {
    'use strict';

    // ========================================
    // 全局主题色检测工具（供所有插件使用）
    // ========================================
    const PluginTheme = {
        // 已知主题映射：nav 背景色 -> 图标默认色
        // 依据截图视觉对齐的常量配置
        _themeMap: {
            silver: '#808CA4',
            purple: 'rgba(255, 255, 255, 0.6)',
            blue:   'rgba(255, 255, 255, 0.6)',
            red:    'rgba(255, 255, 255, 0.8)',
        },
        _hoverMap: {
            silver: '#3A6EE7',
            purple: '#FFFFFF',
            blue:   '#FFFFFF',
            red:    '#FFFFFF',
        },
        _hoverColor: '#3A6EE7',
        _currentTheme: 'silver', // 默认银色
        _observers: [],          // 主题变更回调

        /**
         * 检测当前面板主题色
         * 融云官方使用 LocalStorage 存储当前主题标识（银色: theme1, 紫色: theme2, 蓝色: theme3, 红色: newyear）
         */
        detectTheme() {
            // 如果我们已经通过拦截 setItem 确定了真正的 key 和 value，优先使用
            if (this._exactThemeValue) {
                if (this._exactThemeValue === 'theme1') this._currentTheme = 'silver';
                else if (this._exactThemeValue === 'theme2') this._currentTheme = 'purple';
                else if (this._exactThemeValue === 'theme3') this._currentTheme = 'blue';
                else if (this._exactThemeValue === 'newyear') this._currentTheme = 'red';
                return this._currentTheme;
            }

            try {
                let foundTheme = null;
                // 遍历 localStorage 查找（作为启动时的 Fallback）
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key) continue;
                    try {
                        const val = localStorage.getItem(key);
                        if (val === 'theme1' || val === 'theme2' || val === 'theme3' || val === 'newyear') {
                            // 如果有多个健名，为了避开干扰项，优先信任包含 theme 或皮肤关键字的
                            if (key.toLowerCase().includes('theme') || key.toLowerCase().includes('skin')) {
                                foundTheme = val;
                                break;
                            }
                            // 如果实在没有关键字，先记录下来当替补
                            if (!foundTheme) foundTheme = val;
                        }
                    } catch(e) {}
                }

                if (foundTheme) {
                    if (foundTheme === 'theme1') this._currentTheme = 'silver';
                    else if (foundTheme === 'theme2') this._currentTheme = 'purple';
                    else if (foundTheme === 'theme3') this._currentTheme = 'blue';
                    else if (foundTheme === 'newyear') this._currentTheme = 'red';
                }
            } catch (e) {
                console.warn('[PluginTheme] 检测主题失败:', e);
            }
            return this._currentTheme;
        },

        /**
         * 获取当前主题对应的导航图标默认颜色
         */
        getNavIconColor() {
            this.detectTheme();
            return this._themeMap[this._currentTheme] || this._themeMap.silver;
        },

        /**
         * 获取当前主题对应的导航图标 hover 颜色
         */
        getNavIconHoverColor() {
            return this._hoverMap[this._currentTheme] || this._hoverColor;
        },

        /**
         * 注册主题变化回调
         * @param {Function} callback - 回调函数，参数: (iconColor, hoverColor)
         */
        onChange(callback) {
            if (typeof callback === 'function') {
                this._observers.push(callback);
            }
        },

        /**
         * 移除主题变化回调
         */
        offChange(callback) {
            this._observers = this._observers.filter(cb => cb !== callback);
        },

        /**
         * 通知所有观察者主题已变化
         */
        _notifyObservers() {
            const iconColor = this.getNavIconColor();
            const hoverColor = this.getNavIconHoverColor();
            this._observers.forEach(cb => {
                try { cb(iconColor, hoverColor); } catch (e) {
                    console.warn('[PluginTheme] 回调执行失败:', e);
                }
            });
        },

        /**
         * 更新所有导航栏图标的颜色（通过 CSS 变量 + 重新生成 SVG）
         */
        updateAllNavIcons() {
            const iconColor = this.getNavIconColor();
            const hoverColor = this.getNavIconHoverColor();

            console.log(`[PluginTheme] 正在重绘所有图标 -> 填充颜色: ${iconColor}`);

            // 查找所有插件导航图标或工具栏图标并做全局 SVG 替换
            const navIcons = document.querySelectorAll('.rong-nav-tab-item .rong-nav-icon, .rong-tools-icon');
            navIcons.forEach(iconEl => {
                const currentBg = iconEl.style.backgroundImage || '';
                if (!currentBg.includes('data:image/svg+xml;base64,')) return;

                // 从 base64 中提取 SVG，替换 fill 颜色
                try {
                    const base64Match = currentBg.match(/base64,([^'"\)]+)/);
                    if (!base64Match) return;

                    let svgStr = '';
                    try {
                        // 包含非拉丁字符时兼容的解码方式
                        svgStr = decodeURIComponent(escape(atob(base64Match[1])));
                    } catch (e) {
                        svgStr = atob(base64Match[1]);
                    }

                    const isHoverIcon = iconEl.classList.contains('hover');
                    const targetColor = isHoverIcon ? hoverColor : iconColor;

                    // 严谨替换所有的 fill="..."，避免破坏属性
                    let newSvg = svgStr.replace(/fill="[^"]*"/g, `fill="${targetColor}"`);
                    
                    // 如果原本没有 fill，我们在外层强行插入
                    if (!newSvg.includes(`fill="${targetColor}"`)) {
                        newSvg = newSvg.replace('<svg ', `<svg fill="${targetColor}" `);
                    }
                    
                    let newBase64 = '';
                    try {
                        newBase64 = btoa(unescape(encodeURIComponent(newSvg)));
                    } catch (e) {
                        newBase64 = btoa(newSvg);
                    }
                    iconEl.style.backgroundImage = `url('data:image/svg+xml;base64,${newBase64}')`;
                } catch (e) {
                    // 静默忽略解析失败
                    console.warn('[PluginTheme] 图标重绘失败:', e);
                }
            });

            this._notifyObservers();
        },

        /**
         * 启动主题变更监听
         */
        startWatching() {
            let lastTheme = this._currentTheme;

            // ---- Hook LocalStorage 的 setItem 作为最快最准的拦截触发器 ----
            if (!this._storageIntercepted) {
                const originalSetItem = localStorage.setItem;
                const self = this;
                localStorage.setItem = function(key, value) {
                    originalSetItem.apply(this, arguments);
                    if (value === 'theme1' || value === 'theme2' || value === 'theme3' || value === 'newyear') {
                        console.log('[PluginTheme] 💡 直接拦截到主题更改行为:', key, value);
                        self._exactThemeValue = value; // 存储真正的准确值，防止被旧键干扰
                    }
                };
                this._storageIntercepted = true;
            }

            const checkThemeChange = () => {
                const newTheme = this.detectTheme();
                if (newTheme !== lastTheme) {
                    console.log(`[PluginTheme] 🔥 主题正式判定变更: ${lastTheme} -> ${newTheme}`);
                    lastTheme = newTheme;
                    this.updateAllNavIcons();
                }
            };

            // 每 1000 毫秒轮询检查一次 (防止错过初始状态或其他非点击触发的情况)
            if (this._watcherInterval) clearInterval(this._watcherInterval);
            this._watcherInterval = setInterval(checkThemeChange, 1000);

            // 同时绑定到 click 事件上加速响应
            if (!this._hasClickWatcher) {
                document.body.addEventListener('click', () => {
                    setTimeout(checkThemeChange, 50);
                });
                this._hasClickWatcher = true;
            }

            // 首次检测
            checkThemeChange();
        },
    };

    // 暴露到全局
    window.PluginTheme = PluginTheme;

    const fs = require('fs');
    const path = require('path');

    class ConfigPanel {
        constructor() {
            this.panel = null;
            this.isVisible = false;
            console.log('[ConfigPanel] 配置面板 v2.0 已创建');
        }

        /**
         * 显示配置面板
         */
        show() {
            if (this.isVisible) {
                this.hide();
                return;
            }

            if (!this.panel) {
                this.createPanel();
            }

            this.panel.style.display = 'block';
            this.isVisible = true;
            this.refresh();
        }

        /**
         * 隐藏配置面板
         */
        hide() {
            if (this.panel) {
                this.panel.style.display = 'none';
                this.isVisible = false;
            }
        }

        /**
         * 创建配置面板
         */
        createPanel() {
            const panel = document.createElement('div');
            panel.id = 'plugin-config-panel';
            panel.innerHTML = `
                <div class="config-panel-overlay"></div>
                <div class="config-panel-container">
                    <div class="config-panel-titlebar">
                        <span class="config-panel-title">系统设置</span>
                        <button class="close-btn" id="close-config-panel">✕</button>
                    </div>
                    <div class="config-panel-main">
                        <div class="config-panel-sidebar">
                            <ul class="sidebar-nav">
                                <li class="sidebar-nav-item active" data-tab="plugins">
                                    <span class="sidebar-icon">📦</span>
                                    <span class="sidebar-label">插件管理</span>
                                </li>
                                <li class="sidebar-nav-item" data-tab="settings">
                                    <span class="sidebar-icon">⚙️</span>
                                    <span class="sidebar-label">设置</span>
                                </li>
                                <li class="sidebar-nav-item" data-tab="about">
                                    <span class="sidebar-icon">ℹ️</span>
                                    <span class="sidebar-label">关于</span>
                                </li>
                            </ul>
                        </div>
                        <div class="config-panel-body">
                            <!-- 插件标签页 -->
                            <div class="tab-content active" id="tab-plugins">
                                <div class="content-section-header">
                                    <h3 class="content-section-title">插件管理</h3>
                                </div>
                                <div class="config-panel-toolbar" style="display:none">
                                    <button class="btn-primary" id="toggle-all-plugins">🔄 取消全部</button>
                                    <button class="btn-secondary" id="open-plugins-dir">📁 打开插件目录</button>
                                </div>
                                <div class="plugins-list" id="plugins-list"></div>
                            </div>

                            <!-- 设置标签页 -->
                            <div class="tab-content" id="tab-settings">
                                <div class="content-section-header">
                                    <h3 class="content-section-title">设置</h3>
                                </div>
                                <div class="settings-info">
                                    <div class="settings-group">
                                        <h4 class="settings-group-title">🔧 基础设置</h4>
                                        <div class="settings-group-content">
                                            <div class="config-item config-row">
                                                <label class="config-label">服务器地址</label>
                                                <input type="text" id="global-server-url" class="config-input config-input-readonly" readonly tabindex="-1" placeholder="由安装脚本配置">
                                            </div>
                                            <p class="server-url-hint">⚠️ 服务器地址由安装脚本写入，不可手动修改。</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- 关于标签页 -->
                            <div class="tab-content" id="tab-about">
                                <div class="content-section-header">
                                    <h3 class="content-section-title">关于</h3>
                                </div>
                                <div class="settings-info">
                                    <div class="settings-group">
                                        <h4 class="settings-group-title">📋 系统信息</h4>
                                        <div class="settings-group-content" id="system-info"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="plugin-demo-shared-popover" id="plugin-demo-shared-popover">
                    <div id="plugin-demo-content"></div>
                    <div class="plugin-demo-text">✨ 效果演示</div>
                </div>
            `;

            this.addStyles();
            document.body.appendChild(panel);
            this.panel = panel;
            this.bindEvents();
        }

        /**
         * 添加样式
         */
        addStyles() {
            if (document.getElementById('config-panel-styles-v2')) return;

            const style = document.createElement('style');
            style.id = 'config-panel-styles-v2';
            style.textContent = `
                #plugin-config-panel {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    z-index: 999999;
                    display: none;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif;
                }

                .config-panel-overlay {
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0, 0, 0, 0.45);
                    backdrop-filter: blur(6px);
                    z-index: 0;
                }

                .config-panel-container {
                    position: absolute;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                    width: 92%; max-width: 860px; height: 75vh; max-height: 620px;
                    background: #f5f5f7;
                    border-radius: 14px;
                    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(0,0,0,0.08);
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    animation: panel-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                    z-index: 1;
                }

                @keyframes panel-in {
                    from { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
                    to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                }

                /* ====== 标题栏 ====== */
                .config-panel-titlebar {
                    display: flex; justify-content: space-between; align-items: center;
                    padding: 14px 20px;
                    background: #fff;
                    border-bottom: 1px solid #e5e5e7;
                    flex-shrink: 0;
                    -webkit-app-region: drag;
                }
                .config-panel-title {
                    font-size: 16px; font-weight: 600; color: #1d1d1f;
                    letter-spacing: -0.2px;
                }
                .close-btn {
                    width: 28px; height: 28px; border: none;
                    background: #e8e8ed;
                    color: #86868b; border-radius: 50%;
                    font-size: 14px; cursor: pointer;
                    transition: all 0.2s;
                    display: flex; align-items: center; justify-content: center;
                    -webkit-app-region: no-drag;
                    line-height: 1;
                }
                .close-btn:hover { background: #d1d1d6; color: #1d1d1f; }

                /* ====== 主体左右布局 ====== */
                .config-panel-main {
                    display: flex; flex: 1; overflow: hidden;
                }

                /* ====== 左侧边栏 ====== */
                .config-panel-sidebar {
                    width: 200px; flex-shrink: 0;
                    background: rgba(255,255,255,0.65);
                    border-right: 1px solid #e5e5e7;
                    padding: 12px 10px;
                    overflow-y: auto;
                }
                .sidebar-nav {
                    list-style: none; margin: 0; padding: 0;
                    display: flex; flex-direction: column; gap: 2px;
                }
                .sidebar-nav-item {
                    display: flex; align-items: center; gap: 10px;
                    padding: 9px 14px;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: all 0.15s ease;
                    font-size: 14px; color: #3c3c43;
                    user-select: none;
                }
                .sidebar-nav-item:hover {
                    background: rgba(0,0,0,0.04);
                }
                .sidebar-nav-item.active {
                    background: #3478F6;
                    color: #fff;
                }
                .sidebar-icon {
                    font-size: 16px; width: 22px; text-align: center;
                    flex-shrink: 0;
                }
                .sidebar-label {
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                /* ====== 右侧内容区 ====== */
                .config-panel-body {
                    flex: 1; overflow-y: auto; padding: 24px 28px;
                    background: #f5f5f7;
                }

                .tab-content { display: none; }
                .tab-content.active { display: block; }

                .content-section-header {
                    margin-bottom: 20px;
                }
                .content-section-title {
                    margin: 0; font-size: 22px; font-weight: 700;
                    color: #1d1d1f; letter-spacing: -0.3px;
                }

                /* ====== 工具栏 ====== */
                .config-panel-toolbar {
                    display: flex; gap: 10px; margin-bottom: 20px;
                }
                .config-panel-toolbar button, .config-actions button {
                    padding: 8px 16px; border: none; border-radius: 8px;
                    font-size: 13px; cursor: pointer; transition: all 0.2s;
                    font-weight: 500;
                }

                .btn-primary { background: #3478F6; color: white; }
                .btn-primary:hover { background: #2563EB; transform: translateY(-1px); }
                .btn-secondary { background: #e8e8ed; color: #1d1d1f; }
                .btn-secondary:hover { background: #d1d1d6; transform: translateY(-1px); }
                .btn-warning { background: #FF9500; color: white; }
                .btn-warning:hover { background: #e68a00; transform: translateY(-1px); }
                .btn-danger { background: #FF3B30; color: white; }
                .btn-danger:hover { background: #d32f2f; transform: translateY(-1px); }

                /* ====== 插件卡片 ====== */
                .plugins-list { display: flex; flex-direction: column; gap: 10px; }

                .plugin-card {
                    background: #fff; border-radius: 12px; padding: 16px 20px;
                    transition: all 0.2s ease; border: 1px solid #e5e5e7;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
                }
                .plugin-card:hover {
                    border-color: #3478F6;
                    box-shadow: 0 2px 10px rgba(52,120,246,0.12);
                }
                .plugin-card.disabled { opacity: 0.55; }

                .plugin-header {
                    display: flex; justify-content: space-between; align-items: center;
                    margin-bottom: 8px;
                }
                .plugin-info { flex: 1; }
                .plugin-name { font-size: 15px; font-weight: 600; color: #1d1d1f; margin: 0 0 2px 0; }
                .plugin-version { font-size: 12px; color: #86868b; }

                .plugin-toggle {
                    position: relative; width: 46px; height: 26px;
                    background: #d1d1d6; border-radius: 13px;
                    cursor: pointer; transition: background 0.3s;
                    flex-shrink: 0;
                }
                .plugin-toggle.enabled { background: #34C759; }
                .plugin-toggle::after {
                    content: ''; position: absolute; top: 2px; left: 2px;
                    width: 22px; height: 22px; background: white;
                    border-radius: 50%; transition: transform 0.3s;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                }
                .plugin-toggle.enabled::after { transform: translateX(20px); }

                .plugin-toggle.loading {
                    pointer-events: none;
                    animation: plugin-toggle-pulse 1.2s infinite;
                }
                @keyframes plugin-toggle-pulse {
                    0% { opacity: 0.8; }
                    50% { opacity: 0.4; }
                    100% { opacity: 0.8; }
                }

                .plugin-description { color: #6e6e73; font-size: 13px; line-height: 1.5; }

                .plugin-config { margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f2; }

                .config-item { margin-bottom: 12px; }
                .config-row {
                    display: flex; align-items: center; gap: 12px;
                }
                .config-row .config-label {
                    margin-bottom: 0; white-space: nowrap; flex-shrink: 0; min-width: 80px;
                }
                .config-row .config-input {
                    flex: 1;
                }
                .config-label {
                    display: block; font-size: 13px; font-weight: 500;
                    color: #48484a; margin-bottom: 6px;
                }
                .config-input {
                    width: 100%; padding: 8px 12px;
                    border: 1px solid #d1d1d6; border-radius: 8px;
                    font-size: 14px; box-sizing: border-box;
                    transition: all 0.2s;
                    background: #fff;
                }
                .config-input:focus { outline: none; border-color: #3478F6; box-shadow: 0 0 0 3px rgba(52,120,246,0.15); }
                .config-input-readonly {
                    background: #f0f0f5 !important;
                    color: #6e6e73 !important;
                    cursor: default !important;
                    border-color: #e0e0e5 !important;
                    user-select: text;
                }
                .config-input-readonly:focus { outline: none !important; border-color: #e0e0e5 !important; box-shadow: none !important; }
                .server-url-hint {
                    margin: 10px 0 0 0; font-size: 12px; color: #a1a1a6; line-height: 1.5;
                }
                select.config-input {
                    -webkit-appearance: menulist;
                    appearance: menulist;
                    cursor: pointer;
                    background: white;
                    height: 38px;
                    color: #1d1d1f;
                }
                .config-actions { display: flex; gap: 8px; margin-top: 12px; }

                /* ====== 设置分组 ====== */
                .settings-group {
                    margin-bottom: 24px;
                }
                .settings-group-title {
                    margin: 0 0 10px 0; font-size: 14px; font-weight: 600;
                    color: #48484a;
                }
                .settings-group-content {
                    background: #fff; border-radius: 12px;
                    padding: 16px 20px;
                    border: 1px solid #e5e5e7;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
                }
                .settings-info p {
                    margin: 6px 0; font-size: 13px; color: #6e6e73;
                    line-height: 1.6;
                }
                .settings-info p strong {
                    color: #1d1d1f; font-weight: 600;
                }

                /* ====== 滚动条 ====== */
                .config-panel-body::-webkit-scrollbar {
                    width: 6px;
                }
                .config-panel-body::-webkit-scrollbar-track {
                    background: transparent;
                }
                .config-panel-body::-webkit-scrollbar-thumb {
                    background: #c7c7cc;
                    border-radius: 3px;
                }
                .config-panel-body::-webkit-scrollbar-thumb:hover {
                    background: #a1a1a6;
                }

                /* ========================================
                   夜间模式样式 - 跟随 data-theme="dark"
                   ======================================== */
                html[data-theme="dark"] .config-panel-overlay {
                    background: rgba(0, 0, 0, 0.65);
                }

                html[data-theme="dark"] .config-panel-container {
                    background: #1c1c1e;
                    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
                }

                html[data-theme="dark"] .config-panel-titlebar {
                    background: #2c2c2e;
                    border-bottom-color: #3a3a3c;
                }
                html[data-theme="dark"] .config-panel-title {
                    color: #f5f5f7;
                }
                html[data-theme="dark"] .close-btn {
                    background: #3a3a3c; color: #86868b;
                }
                html[data-theme="dark"] .close-btn:hover {
                    background: #48484a; color: #f5f5f7;
                }

                /* 侧边栏 */
                html[data-theme="dark"] .config-panel-sidebar {
                    background: rgba(44,44,46,0.65);
                    border-right-color: #3a3a3c;
                }
                html[data-theme="dark"] .sidebar-nav-item {
                    color: #e5e5ea;
                }
                html[data-theme="dark"] .sidebar-nav-item:hover {
                    background: rgba(255,255,255,0.06);
                }
                html[data-theme="dark"] .sidebar-nav-item.active {
                    background: #3478F6;
                    color: #fff;
                }

                /* 面板主体 */
                html[data-theme="dark"] .config-panel-body {
                    background: #1c1c1e;
                }

                html[data-theme="dark"] .content-section-title {
                    color: #f5f5f7;
                }

                /* 插件卡片 */
                html[data-theme="dark"] .plugin-card,
                html[data-theme="dark"] .update-card {
                    background: #2c2c2e;
                    border-color: #3a3a3c;
                }
                html[data-theme="dark"] .plugin-card:hover,
                html[data-theme="dark"] .update-card:hover {
                    border-color: #5a9aff;
                    box-shadow: 0 2px 10px rgba(52,120,246,0.2);
                }
                html[data-theme="dark"] .plugin-card.disabled {
                    opacity: 0.45;
                }
                html[data-theme="dark"] .plugin-name {
                    color: #f5f5f7 !important;
                }
                html[data-theme="dark"] .plugin-version,
                html[data-theme="dark"] .update-version {
                    color: #86868b;
                }
                html[data-theme="dark"] .plugin-description {
                    color: #a1a1a6;
                }

                /* 插件配置区域 */
                html[data-theme="dark"] .plugin-config {
                    border-top-color: #3a3a3c;
                }
                html[data-theme="dark"] .config-label {
                    color: #a1a1a6;
                }
                html[data-theme="dark"] .config-input {
                    background: #1c1c1e;
                    border-color: #3a3a3c;
                    color: #f5f5f7;
                }
                html[data-theme="dark"] .config-input:focus {
                    border-color: #5a9aff;
                    box-shadow: 0 0 0 3px rgba(52,120,246,0.25);
                }
                html[data-theme="dark"] select.config-input {
                    background: #1c1c1e;
                    color: #f5f5f7;
                }

                /* 按钮 */
                html[data-theme="dark"] .btn-primary {
                    background: #3478F6;
                }
                html[data-theme="dark"] .btn-primary:hover {
                    background: #5a9aff;
                }
                html[data-theme="dark"] .btn-secondary {
                    background: #3a3a3c; color: #e5e5ea;
                }
                html[data-theme="dark"] .btn-secondary:hover {
                    background: #48484a;
                }
                html[data-theme="dark"] .btn-warning {
                    background: #e68a00;
                }
                html[data-theme="dark"] .btn-warning:hover {
                    background: #FF9500;
                }
                html[data-theme="dark"] .btn-danger {
                    background: #c62828;
                }
                html[data-theme="dark"] .btn-danger:hover {
                    background: #FF3B30;
                }

                /* 开关 */
                html[data-theme="dark"] .plugin-toggle {
                    background: #48484a;
                }
                html[data-theme="dark"] .plugin-toggle.enabled {
                    background: #30D158;
                }

                /* 设置分组 */
                html[data-theme="dark"] .settings-group-title {
                    color: #a1a1a6;
                }
                html[data-theme="dark"] .settings-group-content {
                    background: #2c2c2e;
                    border-color: #3a3a3c;
                }
                html[data-theme="dark"] .settings-info p {
                    color: #a1a1a6;
                }
                html[data-theme="dark"] .settings-info p strong {
                    color: #f5f5f7;
                }
                /* 可点击的数据目录路径 */
                .data-dir-link {
                    color: #3478F6;
                    cursor: pointer;
                    text-decoration: none;
                    border-bottom: 1px dashed #3478F6;
                    transition: all 0.2s ease;
                    padding-bottom: 1px;
                }
                .data-dir-link:hover {
                    color: #2563EB;
                    border-bottom-style: solid;
                }
                html[data-theme="dark"] .data-dir-link {
                    color: #5ac8fa;
                    border-bottom-color: #5ac8fa;
                }
                html[data-theme="dark"] .data-dir-link:hover {
                    color: #70d7ff;
                    border-bottom-color: #70d7ff;
                }
                html[data-theme="dark"] .config-input-readonly {
                    background: #2a2a2c !important;
                    color: #636366 !important;
                    border-color: #3a3a3c !important;
                }
                html[data-theme="dark"] .server-url-hint {
                    color: #636366;
                }

                html[data-theme="dark"] .config-divider {
                    border-top-color: #3a3a3c !important;
                }

                /* 滚动条 */
                html[data-theme="dark"] .config-panel-body::-webkit-scrollbar-track {
                    background: transparent;
                }
                html[data-theme="dark"] .config-panel-body::-webkit-scrollbar-thumb {
                    background: #48484a;
                }
                html[data-theme="dark"] .config-panel-body::-webkit-scrollbar-thumb:hover {
                    background: #636366;
                }

                /* ====== 插件使用演示（悬浮动画） ====== */
                .plugin-demo-shared-popover {
                    position: fixed;
                    background: #fff;
                    padding: 8px;
                    border-radius: 12px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                    border: 1px solid #e5e5e7;
                    z-index: 9999999;
                    opacity: 0;
                    visibility: hidden;
                    transition: opacity 0.2s, transform 0.2s;
                    pointer-events: none;
                    width: 640px;
                    max-width: 85vw;
                    transform: translateY(10px);
                }
                .plugin-demo-shared-popover.visible {
                    opacity: 1;
                    visibility: visible;
                    transform: translateY(0);
                }
                html[data-theme="dark"] .plugin-demo-shared-popover {
                    background: #2c2c2e;
                    border-color: #3a3a3c;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                }
                .plugin-demo-media {
                    width: 100%;
                    border-radius: 6px;
                    display: block;
                }
                .plugin-demo-text {
                    font-size: 12px;
                    color: #86868b;
                    text-align: center;
                    margin-top: 6px;
                    margin-bottom: 2px;
                }

                .plugin-demo-icon {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 22px;
                    height: 22px;
                    border-radius: 50%;
                    background: #e8e8ed;
                    color: #3478F6;
                    font-size: 13px;
                    margin-left: 8px;
                    cursor: help;
                    vertical-align: middle;
                    transition: all 0.2s;
                }
                .plugin-demo-icon:hover {
                    background: #d1d1d6;
                    transform: scale(1.05);
                }
                html[data-theme="dark"] .plugin-demo-icon {
                    background: #3a3a3c;
                    color: #5a9aff;
                }
                html[data-theme="dark"] .plugin-demo-icon:hover {
                    background: #48484a;
                }

                /* ====== 插件错误弹窗 ====== */
                .plugin-error-dialog-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0, 0, 0, 0.45);
                    z-index: 1000010;
                    display: flex; align-items: center; justify-content: center;
                    animation: plugin-err-fadein 0.2s ease;
                }
                @keyframes plugin-err-fadein {
                    from { opacity: 0; }
                    to   { opacity: 1; }
                }
                .plugin-error-dialog {
                    background: #fff; border-radius: 14px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
                    max-width: 460px; width: 90%;
                    overflow: hidden;
                    animation: plugin-err-slidein 0.25s ease;
                }
                @keyframes plugin-err-slidein {
                    from { transform: translateY(20px) scale(0.97); opacity: 0; }
                    to   { transform: translateY(0) scale(1); opacity: 1; }
                }
                .plugin-error-dialog .ped-header {
                    background: linear-gradient(135deg, #ff6b6b, #ee5a24);
                    padding: 18px 24px;
                    color: #fff;
                }
                .plugin-error-dialog .ped-header h3 {
                    margin: 0; font-size: 16px; font-weight: 600;
                }
                .plugin-error-dialog .ped-body {
                    padding: 20px 24px;
                    font-size: 14px; line-height: 1.7; color: #444;
                }
                .plugin-error-dialog .ped-body .ped-msg {
                    margin-bottom: 16px;
                }
                .plugin-error-dialog .ped-cmd-block {
                    position: relative;
                    background: #1e1e2e; color: #a6e3a1;
                    font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
                    font-size: 13px; line-height: 1.6;
                    padding: 14px 48px 14px 16px;
                    border-radius: 8px; margin: 8px 0;
                    word-break: break-all;
                    cursor: pointer;
                    transition: box-shadow 0.2s;
                }
                .plugin-error-dialog .ped-cmd-block:hover {
                    box-shadow: 0 0 0 2px #a6e3a1;
                }
                .plugin-error-dialog .ped-cmd-block .ped-copy-btn {
                    position: absolute; top: 8px; right: 8px;
                    background: rgba(255,255,255,0.12);
                    border: none; color: #cdd6f4;
                    font-size: 13px; padding: 4px 8px;
                    border-radius: 6px; cursor: pointer;
                    transition: background 0.2s;
                }
                .plugin-error-dialog .ped-cmd-block .ped-copy-btn:hover {
                    background: rgba(255,255,255,0.25);
                }
                .plugin-error-dialog .ped-cmd-block .ped-copy-tip {
                    display: none;
                    position: absolute; top: -28px; right: 8px;
                    background: #45a049; color: #fff;
                    font-size: 12px; padding: 2px 10px;
                    border-radius: 4px; white-space: nowrap;
                    font-family: -apple-system, sans-serif;
                }
                .plugin-error-dialog .ped-footer {
                    padding: 12px 24px 18px;
                    text-align: right;
                }
                .plugin-error-dialog .ped-close-btn {
                    background: #3478F6; color: #fff;
                    border: none; padding: 10px 28px;
                    border-radius: 8px; font-size: 14px;
                    font-weight: 500; cursor: pointer;
                    transition: background 0.2s, transform 0.15s;
                }
                .plugin-error-dialog .ped-close-btn:hover {
                    background: #2563EB; transform: translateY(-1px);
                }

                /* 夜间模式 */
                html[data-theme="dark"] .plugin-error-dialog {
                    background: #2c2c2e;
                }
                html[data-theme="dark"] .plugin-error-dialog .ped-body {
                    color: #ccc;
                }
                html[data-theme="dark"] .plugin-error-dialog .ped-cmd-block {
                    background: #1a1a2e;
                }


            `;
            document.head.appendChild(style);
        }

        /**
         * 绑定事件
         */
        bindEvents() {
            const self = this;

            // 关闭
            document.getElementById('close-config-panel').addEventListener('click', () => this.hide());
            this.panel.querySelector('.config-panel-overlay').addEventListener('click', () => this.hide());

            // 侧边栏导航切换
            this.panel.querySelectorAll('.sidebar-nav-item').forEach(item => {
                item.addEventListener('click', function () {
                    self.panel.querySelectorAll('.sidebar-nav-item').forEach(i => i.classList.remove('active'));
                    self.panel.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    this.classList.add('active');
                    const tabId = 'tab-' + this.getAttribute('data-tab');
                    document.getElementById(tabId).classList.add('active');

                    if (tabId === 'tab-plugins') self.refresh();
                    if (tabId === 'tab-settings') self.refreshSettings();
                    if (tabId === 'tab-about') self.refreshAbout();
                });
            });

            // 取消全部 / 启用全部 切换
            document.getElementById('toggle-all-plugins').addEventListener('click', async () => {
                const plugins = window.PluginManager.getAllPlugins().filter(p => window.PluginManager.isPluginInstalled(p.id));
                const allEnabled = plugins.length > 0 && plugins.every(p => p.enabled);

                for (const plugin of plugins) {
                    if (allEnabled) {
                        await window.PluginManager.disablePlugin(plugin.id);
                    } else {
                        await window.PluginManager.enablePlugin(plugin.id);
                    }
                }

                this.refresh();
                this.updateToggleAllButton();
            });

            // 打开插件目录
            document.getElementById('open-plugins-dir').addEventListener('click', () => {
                const { shell } = require('electron');
                const pluginsDir = path.join(window.PluginManager.getBaseDir(), 'plugins');
                shell.openPath(pluginsDir);
            });




        }



        /**
         * 更新"取消全部/启用全部"按钮文案
         */
        updateToggleAllButton() {
            const btn = document.getElementById('toggle-all-plugins');
            if (!btn) return;
            const plugins = window.PluginManager.getAllPlugins().filter(p => window.PluginManager.isPluginInstalled(p.id));
            const allEnabled = plugins.length > 0 && plugins.every(p => p.enabled);
            btn.textContent = allEnabled ? '❌ 取消全部' : '✅ 启用全部';
        }

        /**
         * 刷新插件列表
         */
        refresh() {
            const listContainer = document.getElementById('plugins-list');
            if (!listContainer) return;



            const allPlugins = window.PluginManager.getAllPlugins();

            // 先检查本地是否存在插件文件，只显示实际安装的插件
            const plugins = allPlugins.filter(plugin => {
                return window.PluginManager.isPluginInstalled(plugin.id);
            });

            if (plugins.length === 0) {
                listContainer.innerHTML = '<p style="text-align:center;color:#999;">暂无插件 — 请将插件文件放入 plugins 目录</p>';
                return;
            }

            listContainer.innerHTML = '';
            plugins.forEach(plugin => {
                const card = this.createPluginCard(plugin);
                listContainer.appendChild(card);
            });

            this.updateToggleAllButton();
        }

        /**
         * 获取插件模块的 configMeta（如果有）
         * configMeta 格式: { keyName: { label: '显示名', options: [{value, label}] } }
         */
        _getPluginConfigMeta(pluginId) {
            const pluginModule = window.PluginManager.getPluginModule(pluginId);
            return pluginModule?.configMeta || {};
        }

        /**
         * 创建插件卡片
         */
        createPluginCard(plugin) {
            const card = document.createElement('div');
            card.className = `plugin-card ${plugin.enabled ? 'enabled' : 'disabled'}`;
            card.setAttribute('data-plugin-id', plugin.id);

            const configMeta = this._getPluginConfigMeta(plugin.id);

            let configHtml = '';
            if (plugin.config && Object.keys(plugin.config).length > 0) {
                configHtml = '<div class="plugin-config">';
                for (const [key, value] of Object.entries(plugin.config)) {
                    const meta = configMeta[key];
                    const label = (meta && meta.label) || key;

                    // 如果 meta 中定义了 options，渲染为 select 下拉框
                    if (meta && meta.options && Array.isArray(meta.options)) {
                        const optionsHtml = meta.options.map(opt => {
                            const selected = opt.value === value ? 'selected' : '';
                            return `<option value="${opt.value}" ${selected}>${opt.label || opt.value}</option>`;
                        }).join('');
                        configHtml += `
                            <div class="config-item">
                                <label class="config-label">${label}</label>
                                <select class="config-input config-select" data-key="${key}">
                                    ${optionsHtml}
                                </select>
                            </div>`;
                    } else {
                        const type = typeof value === 'boolean' ? 'checkbox' :
                            typeof value === 'number' ? 'number' : 'text';

                        if (type === 'checkbox') {
                            configHtml += `
                                <div class="config-item">
                                    <label class="config-label">
                                        <input type="checkbox" class="config-checkbox" 
                                               data-key="${key}" ${value ? 'checked' : ''}>
                                        ${label}
                                    </label>
                                </div>`;
                        } else {
                            configHtml += `
                                <div class="config-item">
                                    <label class="config-label">${label}</label>
                                    <input type="${type}" class="config-input" 
                                           data-key="${key}" value="${value}">
                                </div>`;
                        }
                    }
                }
                configHtml += '</div>';
            }

            card.innerHTML = `
                <div class="plugin-header">
                    <div class="plugin-info">
                        <h3 class="plugin-name" style="display:flex;align-items:center;">
                            ${plugin.name}
                            <span class="plugin-demo-placeholder"></span>
                        </h3>
                    </div>
                    <div class="plugin-toggle ${plugin.enabled ? 'enabled' : ''}" 
                         data-action="toggle"></div>
                </div>
                <div class="plugin-description">${plugin.description || '暂无描述'}</div>
                ${configHtml}
            `;

            // 查找并注入演示动图
            const pluginDir = path.join(window.PluginManager.getBaseDir(), 'plugins', plugin.id);
            const supportedDemos = [
                { file: 'demo.webp', type: 'image/webp' },
                { file: 'demo.webm', type: 'video/webm' },
                { file: 'demo.mp4',  type: 'video/mp4' },
                { file: 'demo.gif',  type: 'image/gif' }
            ];

            let demoFile = null;
            for (const d of supportedDemos) {
                const demoPath = path.join(pluginDir, d.file);
                if (fs.existsSync(demoPath)) {
                    try {
                        const base64Data = fs.readFileSync(demoPath).toString('base64');
                        demoFile = {
                            url: `data:${d.type};base64,${base64Data}`,
                            isVideo: d.type.startsWith('video')
                        };
                        break;
                    } catch (e) {
                        console.error(`[ConfigPanel] 读取演示文件失败: ${demoPath}`, e);
                    }
                }
            }

            if (demoFile) {
                const placeholder = card.querySelector('.plugin-demo-placeholder');
                placeholder.outerHTML = `<span class="plugin-demo-icon" title="悬浮查看使用演示">💡</span>`;
                
                const iconNode = card.querySelector('.plugin-demo-icon');
                iconNode.addEventListener('mouseenter', (e) => {
                    const popover = document.getElementById('plugin-demo-shared-popover');
                    const content = document.getElementById('plugin-demo-content');
                    if (!popover || !content) return;

                    // 填充媒体内容
                    content.innerHTML = demoFile.isVideo 
                        ? `<video class="plugin-demo-media" src="${demoFile.url}" autoplay loop muted playsinline></video>`
                        : `<img class="plugin-demo-media" src="${demoFile.url}" />`;
                    
                    // 定位
                    const rect = iconNode.getBoundingClientRect();
                    
                    // 显示在图标上方
                    let top = rect.top - popover.offsetHeight - 12; // 12px 间隙
                    if (top < 10) top = rect.bottom + 12; // 空间不够显示在下方
                    
                    // 水平居中，但防止超出屏幕左右边界
                    let left = rect.left + rect.width / 2 - popover.offsetWidth / 2;
                    if (left < 10) left = 10;
                    if (left + popover.offsetWidth > window.innerWidth - 10) {
                        left = window.innerWidth - popover.offsetWidth - 10;
                    }

                    popover.style.top = `${top}px`;
                    popover.style.left = `${left}px`;
                    popover.classList.add('visible');
                });

                iconNode.addEventListener('mouseleave', () => {
                    const popover = document.getElementById('plugin-demo-shared-popover');
                    if (popover) {
                        popover.classList.remove('visible');
                        // 移除内容以释放内存并停止视频播放
                        setTimeout(() => {
                            if (!popover.classList.contains('visible')) {
                                document.getElementById('plugin-demo-content').innerHTML = '';
                            }
                        }, 200);
                    }
                });
            }

            // 切换启用/禁用
            const toggleBtn = card.querySelector('[data-action="toggle"]');
            toggleBtn.addEventListener('click', async () => {
                if (toggleBtn.classList.contains('loading')) return;
                toggleBtn.classList.add('loading');
                
                try {
                    if (plugin.enabled) {
                        await window.PluginManager.disablePlugin(plugin.id);
                    } else {
                        const result = await window.PluginManager.enablePlugin(plugin.id);
                        if (!result.success) {
                            this._showPluginErrorDialog(plugin.name, result.message || '未知错误');
                        }
                    }
                } finally {
                    toggleBtn.classList.remove('loading');
                    this.refresh();
                }
            });

            // 实时保存配置：收集当前所有配置值并保存
            const autoSave = async () => {
                const newConfig = {};
                card.querySelectorAll('.config-input, .config-checkbox, .config-select').forEach(input => {
                    const key = input.getAttribute('data-key');
                    if (!key) return;
                    if (input.type === 'checkbox') newConfig[key] = input.checked;
                    else if (input.type === 'number') newConfig[key] = parseFloat(input.value);
                    else newConfig[key] = input.value;
                });
                await window.PluginManager.updatePluginConfig(plugin.id, newConfig);
                console.log(`[ConfigPanel] ✅ 插件 ${plugin.id} 配置已自动保存`);
            };

            // select 和 checkbox 变化时立即保存
            card.querySelectorAll('.config-select, .config-checkbox').forEach(el => {
                el.addEventListener('change', autoSave);
            });

            // text 和 number 输入在失焦时保存
            card.querySelectorAll('.config-input:not(.config-select)').forEach(el => {
                if (el.tagName === 'SELECT') return;
                el.addEventListener('change', autoSave);
            });

            return card;
        }

        /**
         * 刷新设置页面
         */
        refreshSettings() {
            // 服务器地址由安装脚本写入，仅作展示，不可修改
            const urlInput = document.getElementById('global-server-url');
            if (urlInput && window.PluginManager) {
                urlInput.value = window.PluginManager.getServerUrl() || '';
            }
        }

        /**
         * 计算目录大小（递归）
         */
        _calcDirSize(dirPath) {
            let totalSize = 0;
            try {
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    try {
                        if (entry.isDirectory()) {
                            totalSize += this._calcDirSize(fullPath);
                        } else if (entry.isFile()) {
                            totalSize += fs.statSync(fullPath).size;
                        }
                    } catch (e) {
                        // 跳过无法访问的文件
                    }
                }
            } catch (e) {
                // 目录不可读
            }
            return totalSize;
        }

        /**
         * 格式化文件大小
         */
        _formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        }

        /**
         * 刷新关于页面
         */
        refreshAbout() {
            const infoEl = document.getElementById('system-info');
            if (infoEl && window.PluginManager) {
                const vi = window.PluginManager.getVersionInfo();
                const baseDir = window.PluginManager.getBaseDir();
                const installedPlugins = window.PluginManager.getAllPlugins().filter(p => window.PluginManager.isPluginInstalled(p.id));
                const pluginCount = installedPlugins.length;

                // 构建核心组件版本列表
                const coreVersions = vi?.coreVersions || {};
                const coreNameMap = {
                    pluginManager: '插件管理器',
                    configPanel: '配置面板',
                    updater: '同步器',
                    heartbeat: '心跳模块',
                };
                let coreComponentsHtml = '';
                const coreKeys = Object.keys(coreVersions);
                if (coreKeys.length > 0) {
                    coreComponentsHtml = coreKeys.map(key => {
                        const displayName = coreNameMap[key] || key;
                        const ver = coreVersions[key] || '未知';
                        return `<p style="padding-left:12px;">• <strong>${displayName}:</strong> v${ver}</p>`;
                    }).join('');
                } else {
                    coreComponentsHtml = '<p style="padding-left:12px;color:#999;">暂无核心组件版本信息</p>';
                }

                // 构建业务组件（插件）版本列表
                let bizComponentsHtml = '';
                if (installedPlugins.length > 0) {
                    bizComponentsHtml = installedPlugins.map(p => {
                        const ver = p.version || '未知';
                        return `<p style="padding-left:12px;">• <strong>${p.name}:</strong> v${ver}</p>`;
                    }).join('');
                } else {
                    bizComponentsHtml = '<p style="padding-left:12px;color:#999;">暂无业务组件</p>';
                }

                // 计算数据目录占用空间
                let dirSizeText = '计算中...';
                try {
                    const dirSize = this._calcDirSize(baseDir);
                    dirSizeText = this._formatSize(dirSize);
                } catch (e) {
                    dirSizeText = '无法计算';
                }

                infoEl.innerHTML = `
                    <p><strong>核心组件版本:</strong></p>
                    ${coreComponentsHtml}
                    <p style="margin-top:16px;"><strong>业务组件版本:</strong></p>
                    ${bizComponentsHtml}
                    <p><strong>安装时间:</strong> ${vi?.installTime || '未知'}</p>
                    <p><strong>插件数量:</strong> ${pluginCount}</p>
                    <p><strong>数据目录:</strong> <span class="data-dir-link" id="data-dir-path" title="点击打开目录">${baseDir}</span>（占用空间：${dirSizeText}）</p>
                `;

                // 绑定数据目录点击事件
                const dirLink = document.getElementById('data-dir-path');
                if (dirLink) {
                    dirLink.addEventListener('click', () => {
                        const { shell } = require('electron');
                        shell.openPath(baseDir);
                    });
                }
            }
        }





        /**
         * 注册导航栏图标
         */
        registerNavIcon() {
            const NAV_ICON_ID = 'plugin-manager-nav-icon';
            const CHECK_INTERVAL = 1000;
            const MAX_ATTEMPTS = 60;
            let attempts = 0;

            const checkAndAddIcon = () => {
                if (document.getElementById(NAV_ICON_ID)) return;

                const navTab = document.querySelector('body > div.rong-im > div > div.rong-nav > ul.rong-nav-tab');

                if (navTab) {
                    if (!document.getElementById('plugin-nav-icon-style')) {
                        const iconStyle = document.createElement('style');
                        iconStyle.id = 'plugin-nav-icon-style';
                        iconStyle.textContent = `
                            /* ====== 导航栏滚动支持（窗口缩小时防止图标被遮挡） ====== */
                            body > div.rong-im > div > div.rong-nav {
                                position: relative !important;
                            }
                            body > div.rong-im > div > div.rong-nav > ul.rong-nav-tab {
                                overflow-y: auto !important;
                                overflow-x: hidden !important;
                                scrollbar-width: none;
                            }
                            body > div.rong-im > div > div.rong-nav > ul.rong-nav-tab::-webkit-scrollbar {
                                width: 0 !important;
                            }

                            /* ====== 滚动指示器 ====== */
                            .nav-scroll-indicator {
                                position: absolute;
                                left: 0; right: 0;
                                height: 32px;
                                pointer-events: none;
                                z-index: 10;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                opacity: 0;
                                transition: opacity 0.3s ease;
                            }
                            .nav-scroll-indicator.visible {
                                opacity: 1;
                                pointer-events: auto;
                                cursor: pointer;
                            }
                            .nav-scroll-indicator.top {
                                top: 0;
                                background: linear-gradient(to bottom, var(--nav-bg, #23252b) 30%, transparent);
                            }
                            .nav-scroll-indicator.bottom {
                                bottom: 0;
                                background: linear-gradient(to top, var(--nav-bg, #23252b) 30%, transparent);
                            }
                            .nav-scroll-indicator .nav-scroll-arrow {
                                font-size: 10px;
                                color: #808CA4;
                                animation: nav-scroll-bounce 1.5s infinite ease-in-out;
                            }
                            .nav-scroll-indicator.top .nav-scroll-arrow {
                                animation-name: nav-scroll-bounce-up;
                            }
                            @keyframes nav-scroll-bounce {
                                0%, 100% { transform: translateY(0); }
                                50% { transform: translateY(3px); }
                            }
                            @keyframes nav-scroll-bounce-up {
                                0%, 100% { transform: translateY(0); }
                                50% { transform: translateY(-3px); }
                            }

                            #${NAV_ICON_ID} .rong-nav-icon.hover { display: none; }
                            #${NAV_ICON_ID} .rong-nav-icon:not(.hover) { display: block; }
                            #${NAV_ICON_ID}:hover .rong-nav-icon.hover { display: block; }
                            #${NAV_ICON_ID}:hover .rong-nav-icon:not(.hover) { display: none; }

                            /* ====== 首次安装指引动画 ====== */
                            @keyframes plugin-guide-pulse {
                                0% { box-shadow: 0 0 0 0 rgba(59, 95, 255, 0.6); }
                                70% { box-shadow: 0 0 0 12px rgba(59, 95, 255, 0); }
                                100% { box-shadow: 0 0 0 0 rgba(59, 95, 255, 0); }
                            }
                            @keyframes plugin-guide-glow {
                                0%, 100% { filter: drop-shadow(0 0 4px rgba(59, 95, 255, 0.5)); }
                                50% { filter: drop-shadow(0 0 10px rgba(59, 95, 255, 0.8)); }
                            }
                            @keyframes plugin-guide-tooltip-in {
                                0% { opacity: 0; transform: translateX(8px); }
                                100% { opacity: 1; transform: translateX(0); }
                            }
                            @keyframes plugin-guide-bounce {
                                0%, 100% { transform: translateY(0); }
                                50% { transform: translateY(-3px); }
                            }
                            #${NAV_ICON_ID}.plugin-guide-active {
                                animation: plugin-guide-pulse 1.8s infinite ease-out;
                                border-radius: 10px;
                            }
                            #${NAV_ICON_ID}.plugin-guide-active .rong-nav-icon:not(.hover) {
                                animation: plugin-guide-glow 2s infinite ease-in-out;
                            }
                            .plugin-guide-tooltip {
                                position: fixed;
                                background: linear-gradient(135deg, #4466FF 0%, #3347E0 100%);
                                color: #fff;
                                padding: 10px 16px;
                                border-radius: 10px;
                                font-size: 14px;
                                font-weight: 500;
                                white-space: nowrap;
                                box-shadow: 0 6px 24px rgba(59, 95, 255, 0.45);
                                z-index: 999990;
                                animation: plugin-guide-tooltip-in 0.5s ease-out, plugin-guide-bounce 2.5s 0.5s infinite ease-in-out;
                                pointer-events: auto;
                                cursor: pointer;
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif;
                            }
                            .plugin-guide-tooltip::before {
                                content: '';
                                position: absolute;
                                left: -6px;
                                top: 50%;
                                transform: translateY(-50%);
                                border: 6px solid transparent;
                                border-right-color: #4466FF;
                                border-left: none;
                            }
                            .plugin-guide-tooltip .guide-close-btn {
                                background: rgba(255,255,255,0.25);
                                border: none;
                                color: #fff;
                                width: 20px; height: 20px;
                                border-radius: 50%;
                                font-size: 12px;
                                cursor: pointer;
                                display: flex; align-items: center; justify-content: center;
                                transition: background 0.2s;
                                flex-shrink: 0;
                            }
                            .plugin-guide-tooltip .guide-close-btn:hover {
                                background: rgba(255,255,255,0.4);
                            }
                        `;
                        document.head.appendChild(iconStyle);
                    }

                    const navItem = document.createElement('li');
                    navItem.id = NAV_ICON_ID;
                    navItem.className = 'rong-nav-tab-item';
                    navItem.style.position = 'relative';

                    const iconColor = window.PluginTheme ? window.PluginTheme.getNavIconColor() : '#808CA4';
                    navItem.innerHTML = `
                        <em class="item-content" style="cursor: pointer;">
                            <span class="rong-nav-icon" style="
                                background-image: url('data:image/svg+xml;base64,${this.getPluginIconBase64(iconColor)}');
                            "></span>
                            <span class="rong-nav-icon hover" style="
                                background-image: url('data:image/svg+xml;base64,${this.getPluginIconActiveBase64()}');
                            "></span>
                            <span class="rong-nav-text">插件</span>
                        </em>
                    `;

                    navItem.addEventListener('click', () => {
                        this._dismissOnboardingGuide();
                        this.show();
                    });
                    navTab.appendChild(navItem);
                    console.log('[ConfigPanel] ✅ 导航图标已添加');

                    // 初始化滚动指示器
                    this._setupNavScrollIndicators(navTab);

                    // 启动主题色监听
                    if (window.PluginTheme) {
                        window.PluginTheme.startWatching();
                    }

                    // 首次安装指引
                    this._showOnboardingGuide(navItem);
                    return;
                }

                attempts++;
                if (attempts < MAX_ATTEMPTS) {
                    setTimeout(checkAndAddIcon, CHECK_INTERVAL);
                }
            };

            checkAndAddIcon();
        }

        /**
         * 为导航栏添加滚动指示器（上/下箭头）
         */
        _setupNavScrollIndicators(navTab) {
            const navContainer = navTab.parentElement; // .rong-nav
            if (!navContainer || navContainer.querySelector('.nav-scroll-indicator')) return;

            // 尝试从导航栏获取真实背景色
            const navBg = getComputedStyle(navContainer).backgroundColor;
            if (navBg && navBg !== 'rgba(0, 0, 0, 0)') {
                navContainer.style.setProperty('--nav-bg', navBg);
            }

            // 创建上/下指示器
            const topIndicator = document.createElement('div');
            topIndicator.className = 'nav-scroll-indicator top';
            topIndicator.innerHTML = '<span class="nav-scroll-arrow">▲</span>';

            const bottomIndicator = document.createElement('div');
            bottomIndicator.className = 'nav-scroll-indicator bottom';
            bottomIndicator.innerHTML = '<span class="nav-scroll-arrow">▼</span>';

            navContainer.appendChild(topIndicator);
            navContainer.appendChild(bottomIndicator);

            // 点击指示器平滑滚动
            topIndicator.addEventListener('click', () => {
                navTab.scrollBy({ top: -80, behavior: 'smooth' });
            });
            bottomIndicator.addEventListener('click', () => {
                navTab.scrollBy({ top: 80, behavior: 'smooth' });
            });

            // 更新指示器可见性
            const updateIndicators = () => {
                const { scrollTop, scrollHeight, clientHeight } = navTab;
                const isScrollable = scrollHeight > clientHeight + 2;
                const atTop = scrollTop <= 2;
                const atBottom = scrollTop + clientHeight >= scrollHeight - 2;

                topIndicator.classList.toggle('visible', isScrollable && !atTop);
                bottomIndicator.classList.toggle('visible', isScrollable && !atBottom);
            };

            navTab.addEventListener('scroll', updateIndicators, { passive: true });
            window.addEventListener('resize', updateIndicators);

            // 延迟首次检测，等待其他插件图标也加入
            setTimeout(updateIndicators, 2000);
            // 定期检测（插件可能异步注入图标）
            const checkInterval = setInterval(updateIndicators, 3000);
            setTimeout(() => clearInterval(checkInterval), 30000);
        }

        /**
         * 显示首次安装指引
         */
        _showOnboardingGuide(navItem) {
            if (window.PluginManager && window.PluginManager.isGuideShown()) return;

            // 给图标添加脉冲光晕
            navItem.classList.add('plugin-guide-active');

            // 创建提示气泡
            const tooltip = document.createElement('div');
            tooltip.className = 'plugin-guide-tooltip';
            tooltip.id = 'plugin-guide-tooltip';
            tooltip.innerHTML = `
                <span>✨ 点击这里管理你的插件 🎉</span>
                <button class="guide-close-btn" title="关闭">✕</button>
            `;
            document.body.appendChild(tooltip);

            // 定位到图标右侧
            const positionTooltip = () => {
                const rect = navItem.getBoundingClientRect();
                tooltip.style.left = (rect.right + 10) + 'px';
                tooltip.style.top = (rect.top + rect.height / 2) + 'px';
                tooltip.style.transform = 'translateY(-50%)';
            };
            // 延迟一帧保证布局已完成
            requestAnimationFrame(positionTooltip);
            // 窗口变化时重新定位
            window.addEventListener('resize', positionTooltip);

            // 关闭按钮
            tooltip.querySelector('.guide-close-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this._dismissOnboardingGuide();
            });
            // 点击气泡文字也可以打开面板
            tooltip.addEventListener('click', () => {
                this._dismissOnboardingGuide();
                this.show();
            });

            // 15 秒后自动关闭
            this._guideAutoCloseTimer = setTimeout(() => {
                this._dismissOnboardingGuide();
            }, 15000);

            this._guideResizeHandler = positionTooltip;
        }

        /**
         * 关闭首次安装指引
         */
        _dismissOnboardingGuide() {
            const tooltip = document.getElementById('plugin-guide-tooltip');
            if (tooltip) {
                tooltip.style.animation = 'none';
                tooltip.style.opacity = '0';
                tooltip.style.transition = 'opacity 0.3s ease';
                setTimeout(() => tooltip.remove(), 300);
            }
            const navItem = document.getElementById('plugin-manager-nav-icon');
            if (navItem) {
                navItem.classList.remove('plugin-guide-active');
            }
            if (window.PluginManager) {
                window.PluginManager.setGuideShown(true);
            }
            if (this._guideAutoCloseTimer) {
                clearTimeout(this._guideAutoCloseTimer);
                this._guideAutoCloseTimer = null;
            }
            if (this._guideResizeHandler) {
                window.removeEventListener('resize', this._guideResizeHandler);
                this._guideResizeHandler = null;
            }
        }

        /**
         * 显示插件错误弹窗（支持命令可点击复制）
         * message 中 <code>...</code> 标签内的内容会渲染为可复制的命令块
         */
        _showPluginErrorDialog(pluginName, message) {
            // 移除已有弹窗
            const existing = document.getElementById('plugin-error-dialog-overlay');
            if (existing) existing.remove();

            // 将 message 按 <code>...</code> 拆分，渲染为命令块
            const bodyHTML = message.replace(
                /<code>([\s\S]*?)<\/code>/g,
                (_, cmd) => {
                    const escaped = cmd.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `
                        <div class="ped-cmd-block" data-cmd="${cmd.replace(/"/g, '&quot;')}">
                            <span class="ped-copy-tip">✅ 已复制</span>
                            ${escaped}
                            <button class="ped-copy-btn" title="点击复制">📋</button>
                        </div>`;
                }
            );

            const overlay = document.createElement('div');
            overlay.className = 'plugin-error-dialog-overlay';
            overlay.id = 'plugin-error-dialog-overlay';
            overlay.innerHTML = `
                <div class="plugin-error-dialog">
                    <div class="ped-header">
                        <h3>⚠️ 插件「${pluginName}」启用失败</h3>
                    </div>
                    <div class="ped-body">
                        <div class="ped-msg">${bodyHTML}</div>
                    </div>
                    <div class="ped-footer">
                        <button class="ped-close-btn">我知道了</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            // 绑定关闭
            const close = () => {
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.2s';
                setTimeout(() => overlay.remove(), 200);
            };
            overlay.querySelector('.ped-close-btn').addEventListener('click', close);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close();
            });

            // 绑定复制
            overlay.querySelectorAll('.ped-cmd-block').forEach(block => {
                const copyHandler = () => {
                    const cmd = block.getAttribute('data-cmd');
                    navigator.clipboard.writeText(cmd).then(() => {
                        const tip = block.querySelector('.ped-copy-tip');
                        tip.style.display = 'block';
                        setTimeout(() => { tip.style.display = 'none'; }, 1500);
                    }).catch(() => {
                        // fallback
                        const ta = document.createElement('textarea');
                        ta.value = cmd;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        ta.remove();
                        const tip = block.querySelector('.ped-copy-tip');
                        tip.style.display = 'block';
                        setTimeout(() => { tip.style.display = 'none'; }, 1500);
                    });
                };
                block.addEventListener('click', copyHandler);
                const copyBtn = block.querySelector('.ped-copy-btn');
                if (copyBtn) {
                    copyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        copyHandler();
                    });
                }
            });
        }

        getPluginIconBase64(color) {
            const fillColor = color || (window.PluginTheme ? window.PluginTheme.getNavIconColor() : '#808CA4');
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="${fillColor}"><path d="M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z"/></svg>`;
            return btoa(svg);
        }

        getPluginIconActiveBase64() {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="#3A6EE7"><path d="M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z"/></svg>`;
            return btoa(svg);
        }
    }

    // 创建全局实例
    window.ConfigPanel = new ConfigPanel();
    window.ConfigPanel.registerNavIcon();

    console.log('[ConfigPanel] 📦 配置面板 v2.0 已加载');
})();
