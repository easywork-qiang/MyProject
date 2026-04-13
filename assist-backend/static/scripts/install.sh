#!/bin/bash
# ============================================
# 新点即时通讯 - 插件系统安装/卸载脚本
# 零依赖版本 (使用 Python3 处理 ASAR，无需 Node.js)
#
# 用法:
#   安装: curl -kfsSL http://<服务器地址>/scripts/install.sh | bash
#   卸载: curl -kfsSL http://<服务器地址>/scripts/install.sh | bash -s -- uninstall
# ============================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

print_log()  { printf "${CYAN}[$(date '+%H:%M:%S')]${NC} %s\n" "$1"; }
print_ok()   { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
print_warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
print_err()  { printf "${RED}[✗]${NC} %s\n" "$1"; }
print_step() { printf "${MAGENTA}[STEP]${NC} %s\n" "$1"; }

# 服务器地址
SERVER_URL="__SERVER_URL__"
SCRIPTS_URL="$SERVER_URL/scripts"

# 配置
APP_PATH="/Applications/新点即时通讯.app"
ASAR_FILE="$APP_PATH/Contents/Resources/app.asar"
APP_PROCESS_NAME="新点即时通讯"

# 插件数据目录 (~/Library/Application Support/EpointMsgPlugins)
PLUGIN_DATA_DIR="$HOME/Library/Application Support/EpointMsgPlugins"

# 解析参数: install (默认) 或 uninstall
ACTION="${1:-install}"

# 注入代码内容
INJECT_CODE='
// >>> EPOINT_PLUGIN_INJECT_START <<<
// 插件引导系统 - 由脚本注入
(function() {
    const fs = require("fs");
    const path = require("path");
    const { app } = require("@electron/remote");
    const pluginDir = path.join(app.getPath("appData"), "EpointMsgPlugins");
    const entryFile = path.join(pluginDir, "core", "plugin-manager.js");
    if (fs.existsSync(entryFile)) {
        try { console.log("[Bootstrap] Loading:", entryFile); require(entryFile); }
        catch(e) { console.error("[Bootstrap] Failed:", e); }
    } else {
        console.log("[Bootstrap] Not found:", entryFile);
    }
})();
// >>> EPOINT_PLUGIN_INJECT_END <<<'

# ============================================================
# 公共函数
# ============================================================

check_app() {
    if [ ! -f "$ASAR_FILE" ]; then
        print_err "未找到新点即时通讯应用的 app.asar 文件: $ASAR_FILE"
        print_err "请先安装新点即时通讯应用"
        exit 1
    fi
    print_ok "找到应用 ASAR: $ASAR_FILE"
}

kill_app() {
    if pgrep -f "$APP_PROCESS_NAME" > /dev/null 2>&1; then
        print_warn "检测到 \"$APP_PROCESS_NAME\" 正在运行，正在终止进程..."
        pkill -f "$APP_PROCESS_NAME" 2>/dev/null || true
        WAIT_COUNT=0
        while pgrep -f "$APP_PROCESS_NAME" > /dev/null 2>&1; do
            sleep 1
            WAIT_COUNT=$((WAIT_COUNT + 1))
            if [ $WAIT_COUNT -ge 10 ]; then
                print_warn "进程未能正常退出，尝试强制终止..."
                pkill -9 -f "$APP_PROCESS_NAME" 2>/dev/null || true
                sleep 1
                break
            fi
        done
        if pgrep -f "$APP_PROCESS_NAME" > /dev/null 2>&1; then
            print_err "无法终止 \"$APP_PROCESS_NAME\" 进程，请手动关闭后重试"
            exit 1
        fi
        print_ok "应用进程已终止"
    else
        print_ok "应用未在运行中，可以继续操作"
    fi
}

start_app() {
    print_log "正在重新启动 \"$APP_PROCESS_NAME\"..."
    open "$APP_PATH"
    print_ok "应用已启动"
}

# ============================================================
# 安装流程
# ============================================================

do_install() {
    echo "========================================="
    echo "  📦 插件系统安装工具 (零依赖版)"
    echo "========================================="
    echo ""

    # 创建临时工作目录
    WORK_DIR=$(mktemp -d /tmp/rc_assist_install.XXXXXX)
    ASAR_UTILS="$WORK_DIR/asar_utils.py"
    EXTRACT_DIR="$WORK_DIR/extract_app"
    cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
    trap cleanup EXIT

    # ---- 步骤 1: 检查应用 ----
    print_step "步骤 1/8: 检查应用包"
    check_app
    print_log "ASAR 大小: $(ls -lh "$ASAR_FILE" | awk '{print $5}')"

    # ---- 步骤 2: 检查前置工具 ----
    print_step "步骤 2/8: 检查前置工具 (Python3)"
    if ! command -v python3 &> /dev/null; then
        print_err "未找到 python3 命令！"
        print_err "macOS Ventura 及以上版本应自带 Python3。"
        print_err "如有需要，请通过 Xcode 命令行工具安装: xcode-select --install"
        exit 1
    fi
    PYTHON_VER=$(python3 --version 2>&1)
    print_ok "找到 $PYTHON_VER"

    print_log "正在从服务器下载 ASAR 工具..."
    if curl -kfsSL "$SCRIPTS_URL/asar_utils.py" -o "$ASAR_UTILS"; then
        print_ok "ASAR 工具下载完成"
    else
        print_err "下载 asar_utils.py 失败，请检查网络连接"
        exit 1
    fi

    # ---- 步骤 3: 终止应用进程 ----
    print_step "步骤 3/8: 终止应用进程"
    kill_app

    # ---- 步骤 4: 解包 ASAR 并注入引导代码 ----
    print_step "步骤 4/8: 解包 ASAR 并注入引导代码"
    mkdir -p "$EXTRACT_DIR"
    print_log "正在从 app.asar 中提取文件，请稍候..."
    python3 "$ASAR_UTILS" extract "$ASAR_FILE" "$EXTRACT_DIR"
    print_ok "提取完成！"

    PRELOAD_FILE="$EXTRACT_DIR/src/inject/preload.js"

    if [ ! -f "$PRELOAD_FILE" ]; then
        print_err "未找到 preload.js: $PRELOAD_FILE"
        print_err "注入失败，无法继续安装（应用结构不匹配）"
        exit 1
    fi

    # 清理旧的注入
    if grep -q "EPOINT_PLUGIN_INJECT_START" "$PRELOAD_FILE"; then
        print_warn "发现旧注入代码，正在清理..."
        sed -i '' '/\/\/ >>> EPOINT_PLUGIN_INJECT_START <<</,/\/\/ >>> EPOINT_PLUGIN_INJECT_END <<</d' "$PRELOAD_FILE"
        print_ok "旧注入代码已清理"
    fi

    # 注入引导代码
    echo "$INJECT_CODE" >> "$PRELOAD_FILE"
    print_ok "引导代码注入完成"

    # ---- 步骤 5: 重新打包并替换原生应用包 ----
    print_step "步骤 5/8: 重新打包并替换原生应用包"

    # 备份原文件
    BACKUP_FILE="$ASAR_FILE.backup.$(date +%Y%m%d_%H%M%S)"
    print_log "备份原应用包到: $BACKUP_FILE"
    sudo cp "$ASAR_FILE" "$BACKUP_FILE"

    # 重新打包
    print_log "正在重新打包 asar，这可能需要一些时间..."
    sudo python3 "$ASAR_UTILS" pack "$EXTRACT_DIR" "$ASAR_FILE" "$BACKUP_FILE"
    print_ok "打包替换完成"

    # 绕过签名校验
    print_log "正在绕过签名机制 (移除系统安全隔离属性)..."
    sudo xattr -cr "$APP_PATH" 2>/dev/null || true
    sudo codesign --remove-signature "$APP_PATH" 2>/dev/null || true
    print_ok "已成功绕过 macOS 签名校验机制！注入成功 ✓"

    # ---- 步骤 6: 拉取组件清单 ----
    print_step "步骤 6/8: 拉取组件清单 (manifest.json)"
    MANIFEST_FILE="$WORK_DIR/manifest.json"
    if curl -kfsSL "$SERVER_URL/manifest.json" -o "$MANIFEST_FILE"; then
        print_ok "组件清单下载完成"
    else
        print_err "下载 manifest.json 失败，请检查网络连接"
        exit 1
    fi

    # ---- 清理旧插件数据 ----
    print_log "正在清理旧的插件数据: $PLUGIN_DATA_DIR"
    if [ -d "$PLUGIN_DATA_DIR" ]; then
        rm -rf "$PLUGIN_DATA_DIR"/*  "$PLUGIN_DATA_DIR"/.[!.]* 2>/dev/null || true
        print_ok "已清理旧的插件数据目录内容"
    else
        mkdir -p "$PLUGIN_DATA_DIR"
        print_ok "已创建插件数据目录"
    fi

    # ---- 步骤 7: 安装核心组件 ----
    print_step "步骤 7/8: 安装核心组件"

    CORE_DIR="$PLUGIN_DATA_DIR/core"
    mkdir -p "$CORE_DIR"
    print_log "核心组件安装目录: $CORE_DIR"

    # 用 python3 解析 manifest 中的 core 组件并下载
    CORE_COUNT=0
    CORE_ERROR_COUNT=0

    # 提取 core 组件列表: key|file|version
    CORE_LIST=$(python3 -c "
import json, sys
with open('$MANIFEST_FILE', 'r') as f:
    m = json.load(f)
core = m.get('core', {})
for key, info in core.items():
    print(f\"{key}|{info['file']}|{info['version']}\")
" 2>/dev/null)

    if [ -z "$CORE_LIST" ]; then
        print_warn "manifest 中未找到核心组件定义，跳过"
    else
        # 初始化版本信息
        VERSION_FILE="$PLUGIN_DATA_DIR/.version.json"
        VERSION_JSON="{\"coreVersions\":{}}"

        while IFS='|' read -r CORE_KEY CORE_FILE CORE_VER; do
            CORE_FILENAME=$(basename "$CORE_FILE")
            print_log "正在下载核心组件: $CORE_KEY (v$CORE_VER) → $CORE_FILENAME"
            if curl -kfsSL "$SERVER_URL/$CORE_FILE" -o "$CORE_DIR/$CORE_FILENAME"; then
                CORE_COUNT=$((CORE_COUNT + 1))
                print_ok "  $CORE_KEY 安装完成"
            else
                CORE_ERROR_COUNT=$((CORE_ERROR_COUNT + 1))
                print_err "  $CORE_KEY 下载失败"
            fi
        done <<< "$CORE_LIST"

        # 写入 .version.json (记录安装的核心组件版本)
        python3 -c "
import json, sys
with open('$MANIFEST_FILE', 'r') as f:
    m = json.load(f)
core = m.get('core', {})
version_info = {
    'coreVersions': {},
    'lastCoreUpdate': '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
}
for key, info in core.items():
    version_info['coreVersions'][key] = info['version']
if 'pluginManager' in version_info['coreVersions']:
    version_info['coreVersion'] = version_info['coreVersions']['pluginManager']
with open('$VERSION_FILE', 'w') as f:
    json.dump(version_info, f, indent=2)
" 2>/dev/null

        if [ $CORE_ERROR_COUNT -eq 0 ]; then
            print_ok "全部 $CORE_COUNT 个核心组件安装完成 ✓"
        else
            print_warn "$CORE_COUNT 个成功 / $CORE_ERROR_COUNT 个失败"
        fi
    fi

    # ---- 步骤 8: 安装插件 ----
    print_step "步骤 8/8: 安装插件"

    PLUGINS_DIR="$PLUGIN_DATA_DIR/plugins"
    mkdir -p "$PLUGINS_DIR"
    print_log "插件安装目录: $PLUGINS_DIR"

    PLUGIN_COUNT=0
    PLUGIN_ERROR_COUNT=0

    # 提取插件列表: id|file|version|format
    PLUGIN_LIST=$(python3 -c "
import json, sys
with open('$MANIFEST_FILE', 'r') as f:
    m = json.load(f)
plugins = m.get('plugins', [])
for p in plugins:
    fmt = p.get('format', 'js')
    print(f\"{p['id']}|{p['file']}|{p['version']}|{fmt}\")
" 2>/dev/null)

    if [ -z "$PLUGIN_LIST" ]; then
        print_warn "manifest 中未找到插件定义，跳过"
    else
        while IFS='|' read -r PLUG_ID PLUG_FILE PLUG_VER PLUG_FMT; do
            PLUG_DIR="$PLUGINS_DIR/$PLUG_ID"
            mkdir -p "$PLUG_DIR"
            print_log "正在安装插件: $PLUG_ID (v$PLUG_VER)"

            PLUG_DL="$WORK_DIR/download_$(basename "$PLUG_FILE")"
            if curl -kfsSL "$SERVER_URL/$PLUG_FILE" -o "$PLUG_DL"; then
                if [ "$PLUG_FMT" = "zip" ]; then
                    # 使用 python3 解压 ZIP
                    python3 -c "
import zipfile, sys, os
zf = zipfile.ZipFile('$PLUG_DL', 'r')
zf.extractall('$PLUG_DIR')
zf.close()
" 2>/dev/null
                    if [ $? -eq 0 ]; then
                        PLUGIN_COUNT=$((PLUGIN_COUNT + 1))
                        print_ok "  $PLUG_ID 解压安装完成"
                    else
                        PLUGIN_ERROR_COUNT=$((PLUGIN_ERROR_COUNT + 1))
                        print_err "  $PLUG_ID 解压失败"
                    fi
                else
                    # 单文件格式
                    cp "$PLUG_DL" "$PLUG_DIR/main.js"
                    PLUGIN_COUNT=$((PLUGIN_COUNT + 1))
                    print_ok "  $PLUG_ID 安装完成"
                fi
                rm -f "$PLUG_DL" 2>/dev/null || true
            else
                PLUGIN_ERROR_COUNT=$((PLUGIN_ERROR_COUNT + 1))
                print_err "  $PLUG_ID 下载失败"
            fi
        done <<< "$PLUGIN_LIST"

        if [ $PLUGIN_ERROR_COUNT -eq 0 ]; then
            print_ok "全部 $PLUGIN_COUNT 个插件安装完成 ✓"
        else
            print_warn "$PLUGIN_COUNT 个成功 / $PLUGIN_ERROR_COUNT 个失败"
        fi
    fi

    # ---- 写入客户端配置 (plugin-config.json) ----
    print_log "正在写入客户端配置 (serverUrl: $SERVER_URL)..."
    CONFIG_FILE="$PLUGIN_DATA_DIR/plugin-config.json"
    python3 -c "
import json
cfg = {
    'version': '2.0.0',
    'serverUrl': '$SERVER_URL',
    'plugins': []
}
with open('$CONFIG_FILE', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
" 2>/dev/null
    print_ok "客户端配置已写入"

    # ---- 完成 ----
    echo ""
    echo "========================================="
    printf "${GREEN}  安装全部完成！${NC}\n"
    echo "========================================="
    echo ""
    echo "  📁 核心组件: $CORE_DIR"
    echo "  📁 插件目录: $PLUGINS_DIR"
    echo "  📁 备份文件: $BACKUP_FILE"
    echo ""
    printf "  核心组件: ${GREEN}${CORE_COUNT} 个${NC}"
    if [ $CORE_ERROR_COUNT -gt 0 ]; then
        printf " / ${RED}${CORE_ERROR_COUNT} 个失败${NC}"
    fi
    echo ""
    printf "  插件:     ${GREEN}${PLUGIN_COUNT} 个${NC}"
    if [ $PLUGIN_ERROR_COUNT -gt 0 ]; then
        printf " / ${RED}${PLUGIN_ERROR_COUNT} 个失败${NC}"
    fi
    echo ""
    echo ""

    start_app
    echo ""
    echo "  可以关闭终端"
    echo ""
}

# ============================================================
# 卸载流程
# ============================================================

do_uninstall() {
    echo "========================================="
    echo "  🔄 插件系统卸载/还原工具"
    echo "========================================="
    echo ""

    # ---- 步骤 1: 查找备份文件 ----
    print_step "步骤 1/5: 查找备份文件"
    check_app

    LATEST_BACKUP=$(ls -t "$ASAR_FILE".backup.* 2>/dev/null | head -1)
    if [ -z "$LATEST_BACKUP" ]; then
        print_err "未找到任何备份文件！"
        print_err "请确认之前是否执行过安装脚本（备份文件格式: app.asar.backup.YYYYMMDD_HHMMSS）"
        exit 1
    fi

    echo ""
    print_log "找到以下备份文件:"
    BACKUP_INDEX=0
    while IFS= read -r bak; do
        BACKUP_INDEX=$((BACKUP_INDEX + 1))
        BAK_SIZE=$(ls -lh "$bak" | awk '{print $5}')
        BAK_DATE=$(echo "$bak" | grep -oE '[0-9]{8}_[0-9]{6}' | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)_\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3 \4:\5:\6/')
        if [ $BACKUP_INDEX -eq 1 ]; then
            printf "  ${GREEN}[最新]${NC} %s (%s, %s)\n" "$(basename "$bak")" "$BAK_SIZE" "$BAK_DATE"
        else
            printf "        %s (%s, %s)\n" "$(basename "$bak")" "$BAK_SIZE" "$BAK_DATE"
        fi
    done < <(ls -t "$ASAR_FILE".backup.* 2>/dev/null)
    echo ""
    print_ok "将使用最新备份: $(basename "$LATEST_BACKUP")"

    # ---- 步骤 2: 终止应用进程 ----
    print_step "步骤 2/5: 终止应用进程"
    kill_app

    # ---- 步骤 3: 还原备份 ----
    print_step "步骤 3/5: 还原原始应用包"
    print_log "正在从备份还原 app.asar..."
    sudo cp "$LATEST_BACKUP" "$ASAR_FILE"
    print_ok "app.asar 已还原"

    print_log "正在处理签名..."
    sudo xattr -cr "$APP_PATH" 2>/dev/null || true
    sudo codesign --remove-signature "$APP_PATH" 2>/dev/null || true
    print_ok "签名处理完成"

    # ---- 步骤 4: 清理插件数据 ----
    print_step "步骤 4/5: 清理插件数据"
    if [ -d "$PLUGIN_DATA_DIR" ]; then
        print_log "正在清理插件数据目录: $PLUGIN_DATA_DIR"
        rm -rf "$PLUGIN_DATA_DIR"
        print_ok "插件数据目录已清理"
    else
        print_ok "无插件数据目录需要清理"
    fi

    # ---- 步骤 5: 清理备份文件 ----
    print_step "步骤 5/5: 清理备份文件"
    BACKUP_COUNT=$(ls "$ASAR_FILE".backup.* 2>/dev/null | wc -l | tr -d ' ')
    if [ "$BACKUP_COUNT" -gt 0 ]; then
        print_log "正在清理 ${BACKUP_COUNT} 个备份文件..."
        sudo rm -f "$ASAR_FILE".backup.* 2>/dev/null || true
        print_ok "备份文件已清理"
    fi

    # ---- 完成 ----
    echo ""
    echo "========================================="
    printf "${GREEN}  插件系统已卸载，应用已还原为原始状态！${NC}\n"
    echo "========================================="
    echo ""

    start_app
    echo ""
    echo "  可以关闭终端"
    echo ""
}

# ============================================================
# 主入口: 根据参数分发
# ============================================================

case "$ACTION" in
    install)
        do_install
        ;;
    uninstall)
        do_uninstall
        ;;
    *)
        echo "用法:"
        echo "  安装: bash install.sh"
        echo "  卸载: bash install.sh uninstall"
        echo ""
        echo "  远程安装: curl -kfsSL $SCRIPTS_URL/install.sh | bash"
        echo "  远程卸载: curl -kfsSL $SCRIPTS_URL/install.sh | bash -s -- uninstall"
        exit 1
        ;;
esac
