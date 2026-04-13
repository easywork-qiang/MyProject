# ============================================
# 新点即时通讯 - 插件系统安装/卸载脚本 (Windows PowerShell)
# 纯 PowerShell 实现，无需安装任何额外工具 (Python/Node.js 等)
#
# 一键安装 (管理员 PowerShell 中粘贴运行):
#   irm 'http://<服务器地址>/scripts/install.ps1'|iex
#
# 一键卸载:
#   $env:RC_ACTION='uninstall';irm 'http://<服务器地址>/scripts/install.ps1'|iex
#
# 本地使用:
#   .\install.ps1              # 安装
#   .\install.ps1 uninstall    # 卸载
# ============================================

# 参数解析: 支持本地 .\install.ps1 uninstall 和远程 $env:RC_ACTION='uninstall' 两种方式
$Action = "install"
if ($args -contains "uninstall") {
    $Action = "uninstall"
} elseif ($env:RC_ACTION -eq "uninstall") {
    $Action = "uninstall"
    $env:RC_ACTION = $null  # 用完即清
}

# 检测是否在无交互的后台/重定向模式中运行
$script:IsPipelineMode = $false
try {
    if ([Console]::IsInputRedirected) {
        $script:IsPipelineMode = $true
    }
} catch {
    # 无法访问 Console 状态，默认视为非交互模式
    $script:IsPipelineMode = $true
}

# 强制 UTF-8 输出
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# SSL/TLS 处理：强制 TLS 1.2+，并跳过自签名证书验证
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
try {
    Add-Type @"
    using System.Net;
    using System.Net.Security;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCerts {
        public static void Ignore() {
            ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
        }
    }
"@
    [TrustAllCerts]::Ignore()
} catch {
    # 如果类型已添加则忽略
    try { [TrustAllCerts]::Ignore() } catch {}
}

# ============================================
# 颜色输出函数
# ============================================

function Print-Log($msg)  { Write-Host "[$(Get-Date -Format 'HH:mm:ss')]" -ForegroundColor Cyan -NoNewline; Write-Host " $msg" }
function Print-Ok($msg)   { Write-Host "[✓]" -ForegroundColor Green -NoNewline; Write-Host " $msg" }
function Print-Warn($msg) { Write-Host "[!]" -ForegroundColor Yellow -NoNewline; Write-Host " $msg" }
function Print-Err($msg)  { Write-Host "[✗]" -ForegroundColor Red -NoNewline; Write-Host " $msg" }
function Print-Step($msg) { Write-Host "[STEP]" -ForegroundColor Magenta -NoNewline; Write-Host " $msg" }

# ============================================
# 配置
# ============================================

$ServerUrl  = "__SERVER_URL__"
$ScriptsUrl = "$ServerUrl/scripts"

# 应用相关关键字 (用于搜索进程、注册表、文件名)
$AppKeywords = @("新点即时通讯", "EpointMsg", "xindian")
$AppProcessName = "新点即时通讯"

# 插件数据目录
$PluginDataDir = "$env:APPDATA\EpointMsgPlugins"

# 注入代码
$InjectCode = @'

// >>> EPOINT_PLUGIN_INJECT_START <<<
// 插件引导系统 - 由脚本注入
(function() {
    const fs = require("fs");
    const path = require("path");
    const { app } = require("@electron/remote");
    const pluginDir = path.join(app.getPath("appData"), "EpointMsgPlugins");
    const entryFile = path.join(pluginDir, "core", "plugin-manager.js");
    if (fs.existsSync(entryFile)) {
        try { require(entryFile); }
        catch(e) { console.error("[Bootstrap] Failed:", e); }
    }
})();
// >>> EPOINT_PLUGIN_INJECT_END <<<
'@

# ============================================
# ASAR 解包/打包 (纯 PowerShell 实现，无需 Python)
# ============================================
# ASAR 二进制格式 (基于 Chromium Pickle 序列化):
#   [4 bytes] payloadSize = 4 (UInt32 LE, 固定值)
#   [4 bytes] headerBuf.length (UInt32 LE)
#   [4 bytes] payloadSize (UInt32 LE, 对齐后)
#   [4 bytes] JSON string length (UInt32 LE)
#   [N bytes] JSON header string (UTF-8)
#   [P bytes] Padding (null bytes, 4字节对齐)
#   [... ]    File Contents (所有文件内容依次拼接)

function Align4([int64]$n) {
    return $n + (4 - $n % 4) % 4
}

function Read-AsarHeader {
    <#
    .SYNOPSIS
    从 ASAR 文件读取并解析 JSON header，返回 header 对象和数据区偏移量
    #>
    param([string]$AsarPath)

    $fs = [System.IO.File]::OpenRead($AsarPath)
    try {
        $reader = New-Object System.IO.BinaryReader($fs)

        # Size Pickle: 8 bytes
        $picklePayloadSize = $reader.ReadUInt32()  # 固定为 4
        $headerBufLength = $reader.ReadUInt32()

        # Header Pickle
        $headerBuf = $reader.ReadBytes([int]$headerBufLength)
        $headerPayloadSize = [BitConverter]::ToUInt32($headerBuf, 0)
        $jsonStringSize = [BitConverter]::ToUInt32($headerBuf, 4)
        $jsonBytes = New-Object byte[] $jsonStringSize
        [Array]::Copy($headerBuf, 8, $jsonBytes, 0, $jsonStringSize)
        $jsonString = [System.Text.Encoding]::UTF8.GetString($jsonBytes)

        $header = $jsonString | ConvertFrom-Json
        $dataOffset = 8 + [int64]$headerBufLength

        return @{ Header = $header; DataOffset = $dataOffset; OriginalJson = $jsonString }
    } finally {
        $fs.Close()
    }
}

function Extract-AsarFiles {
    <#
    .SYNOPSIS
    递归提取 ASAR 中的文件到目标目录
    #>
    param(
        [System.IO.BinaryReader]$Reader,
        [object]$Node,
        [string]$CurrentPath,
        [int64]$DataOffset
    )

    if ($Node.files) {
        New-Item -ItemType Directory -Path $CurrentPath -Force | Out-Null
        foreach ($prop in $Node.files.PSObject.Properties) {
            $childPath = Join-Path $CurrentPath $prop.Name
            Extract-AsarFiles -Reader $Reader -Node $prop.Value -CurrentPath $childPath -DataOffset $DataOffset
        }
    } elseif ($null -ne $Node.offset -and -not $Node.unpacked) {
        # 已打包的文件节点
        $parentDir = Split-Path $CurrentPath -Parent
        if ($parentDir -and -not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $offset = [int64]$Node.offset
        $size = [int64]$Node.size

        $Reader.BaseStream.Seek($DataOffset + $offset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $content = $Reader.ReadBytes([int]$size)

        [System.IO.File]::WriteAllBytes($CurrentPath, $content)
    }
    # unpacked 和 link 节点跳过
}

function Expand-Asar {
    <#
    .SYNOPSIS
    解包 ASAR 文件到指定目录
    #>
    param(
        [string]$AsarPath,
        [string]$OutputDir
    )

    $result = Read-AsarHeader -AsarPath $AsarPath
    $header = $result.Header
    $dataOffset = $result.DataOffset

    $fs = [System.IO.File]::OpenRead($AsarPath)
    try {
        $reader = New-Object System.IO.BinaryReader($fs)
        Extract-AsarFiles -Reader $reader -Node $header -CurrentPath $OutputDir -DataOffset $dataOffset
    } finally {
        $fs.Close()
    }
}

function Build-AsarHeader {
    <#
    .SYNOPSIS
    遍历目录构建 ASAR header 和文件列表
    #>
    param(
        [string]$InputDir,
        [object]$OriginalHeader = $null
    )

    $script:asarFileList = @()
    $script:asarCurrentOffset = [int64]0

    function Get-OriginalNode([object]$orig, [string[]]$pathParts) {
        if ($null -eq $orig) { return $null }
        $node = $orig
        foreach ($part in $pathParts) {
            if ($node.files -and ($node.files.PSObject.Properties.Name -contains $part)) {
                $node = $node.files.$part
            } else {
                return $null
            }
        }
        return $node
    }

    function Test-UnpackedNode([object]$node) {
        if ($node.unpacked) { return $true }
        if ($node.files) {
            foreach ($child in $node.files.PSObject.Properties) {
                if (-not (Test-UnpackedNode $child.Value)) { return $false }
            }
            return $true
        }
        return $false
    }

    function Remove-IntegrityField([object]$node) {
        if ($null -eq $node) { return $null }
        $result = @{}
        foreach ($prop in $node.PSObject.Properties) {
            if ($prop.Name -eq 'integrity') { continue }
            if ($prop.Value -is [PSCustomObject]) {
                $result[$prop.Name] = Remove-IntegrityField $prop.Value
            } else {
                $result[$prop.Name] = $prop.Value
            }
        }
        return [PSCustomObject]$result
    }

    function Walk-Directory([string]$dirPath, [string[]]$pathParts = @()) {
        $node = [ordered]@{ files = [ordered]@{} }
        $entries = Get-ChildItem -Path $dirPath -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -notin @('.DS_Store', '__MACOSX', '.git')
        } | Sort-Object Name

        foreach ($entry in $entries) {
            $childParts = $pathParts + @($entry.Name)
            if ($entry.PSIsContainer) {
                $node.files[$entry.Name] = Walk-Directory $entry.FullName $childParts
            } else {
                $fileSize = $entry.Length
                $fileNode = [ordered]@{
                    offset = [string]$script:asarCurrentOffset
                    size   = [int64]$fileSize
                }
                $node.files[$entry.Name] = $fileNode
                $script:asarFileList += @([PSCustomObject]@{
                    Path   = $entry.FullName
                    Offset = $script:asarCurrentOffset
                    Size   = $fileSize
                })
                $script:asarCurrentOffset += $fileSize
            }
        }

        # 合并原始 header 中的 unpacked 文件
        $origNode = Get-OriginalNode $OriginalHeader $pathParts
        if ($origNode -and $origNode.files) {
            foreach ($prop in $origNode.files.PSObject.Properties) {
                if (-not $node.files.Contains($prop.Name)) {
                    if (Test-UnpackedNode $prop.Value) {
                        $node.files[$prop.Name] = Remove-IntegrityField $prop.Value
                    }
                }
            }
        }

        return [PSCustomObject]$node
    }

    $header = Walk-Directory $InputDir
    return @{ Header = $header; FileList = $script:asarFileList }
}

function Compress-Asar {
    <#
    .SYNOPSIS
    将目录打包为 ASAR 文件
    #>
    param(
        [string]$InputDir,
        [string]$OutputPath,
        [string]$OriginalAsarPath = $null
    )

    # 读取原始 header 以保留 unpacked 信息
    $originalHeader = $null
    if ($OriginalAsarPath -and (Test-Path $OriginalAsarPath)) {
        $origResult = Read-AsarHeader -AsarPath $OriginalAsarPath
        $originalHeader = $origResult.Header
    }

    $buildResult = Build-AsarHeader -InputDir $InputDir -OriginalHeader $originalHeader
    $header = $buildResult.Header
    $fileList = $buildResult.FileList

    # 移除顶层 integrity 字段
    # 序列化 JSON (紧凑格式)
    $headerJson = $header | ConvertTo-Json -Depth 100 -Compress
    $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($headerJson)
    $jsonStringSize = $headerBytes.Length

    # Chromium Pickle 对齐
    $alignedPayloadSize = Align4 (4 + $jsonStringSize)
    $paddingSize = $alignedPayloadSize - 4 - $jsonStringSize

    # headerBuf.length = 4 (payloadSize) + alignedPayloadSize
    $headerBufLength = 4 + $alignedPayloadSize

    $fs = [System.IO.File]::Create($OutputPath)
    try {
        $writer = New-Object System.IO.BinaryWriter($fs)

        # Size Pickle (8 bytes)
        $writer.Write([uint32]4)                 # payloadSize = 4 (固定)
        $writer.Write([uint32]$headerBufLength)  # headerBuf.length

        # Header Pickle
        $writer.Write([uint32]$alignedPayloadSize)  # payloadSize
        $writer.Write([uint32]$jsonStringSize)       # JSON 字符串长度
        $writer.Write($headerBytes)                  # JSON 字符串
        if ($paddingSize -gt 0) {
            $writer.Write((New-Object byte[] $paddingSize))  # 对齐填充
        }

        # File Data
        foreach ($fileEntry in $fileList) {
            $srcFs = [System.IO.File]::OpenRead($fileEntry.Path)
            try {
                $buffer = New-Object byte[] (1024 * 1024)  # 1MB buffer
                while ($true) {
                    $bytesRead = $srcFs.Read($buffer, 0, $buffer.Length)
                    if ($bytesRead -le 0) { break }
                    $writer.Write($buffer, 0, $bytesRead)
                }
            } finally {
                $srcFs.Close()
            }
        }
    } finally {
        $fs.Close()
    }
}

# ============================================
# 公共函数
# ============================================

function Find-AsarFile {
    <#
    .SYNOPSIS
    智能查找 app.asar 文件路径，支持自定义安装目录
    搜索策略 (按优先级):
      1. 从正在运行的进程路径推断
      2. 从 Windows 注册表卸载信息查找
      3. 扫描常见安装目录
      4. 全盘搜索 (较慢，作为最终手段)
    #>

    # ---- 策略 1: 从正在运行的进程推断 ----
    Print-Log "正在从运行中的进程查找..."
    foreach ($keyword in $AppKeywords) {
        $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -like "*$keyword*" -or $_.MainWindowTitle -like "*$keyword*"
        }
        foreach ($proc in $procs) {
            try {
                $exePath = $proc.Path
                if ($exePath) {
                    $appDir = Split-Path $exePath -Parent
                    $asarPath = Join-Path $appDir "resources\app.asar"
                    if (Test-Path $asarPath) {
                        Print-Ok "从运行进程找到: $asarPath"
                        return $asarPath
                    }
                }
            } catch {}
        }
    }

    # ---- 策略 2: 从注册表查找 ----
    Print-Log "正在从注册表查找安装路径..."
    $regPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($regPath in $regPaths) {
        try {
            $apps = Get-ItemProperty $regPath -ErrorAction SilentlyContinue
            foreach ($app in $apps) {
                $displayName = $app.DisplayName
                $installLocation = $app.InstallLocation
                if (-not $displayName) { continue }

                $matched = $false
                foreach ($keyword in $AppKeywords) {
                    if ($displayName -like "*$keyword*") { $matched = $true; break }
                }
                if (-not $matched) { continue }

                # 尝试从 InstallLocation 查找
                if ($installLocation -and (Test-Path $installLocation)) {
                    $asarPath = Join-Path $installLocation "resources\app.asar"
                    if (Test-Path $asarPath) {
                        Print-Ok "从注册表找到: $asarPath"
                        return $asarPath
                    }
                }

                # 尝试从 UninstallString 推断路径
                $uninstallStr = $app.UninstallString
                if ($uninstallStr) {
                    # 去掉引号和参数，提取可执行路径
                    $uninstallExe = $uninstallStr -replace '"', '' -replace '\s+--.*$', '' -replace '\s+/.*$', ''
                    if (Test-Path $uninstallExe) {
                        $appDir = Split-Path $uninstallExe -Parent
                        $asarPath = Join-Path $appDir "resources\app.asar"
                        if (Test-Path $asarPath) {
                            Print-Ok "从注册表 (UninstallString) 找到: $asarPath"
                            return $asarPath
                        }
                    }
                }
            }
        } catch {}
    }

    # ---- 策略 3: 扫描常见安装路径 ----
    Print-Log "正在扫描常见安装目录..."
    $commonRoots = @(
        "$env:LOCALAPPDATA\Programs",
        "$env:LOCALAPPDATA",
        "$env:ProgramFiles",
        "${env:ProgramFiles(x86)}",
        "C:\Program Files",
        "C:\Program Files (x86)",
        "$env:USERPROFILE\Desktop",
        "D:\Program Files",
        "D:\Program Files (x86)"
    ) | Select-Object -Unique | Where-Object { Test-Path $_ }

    foreach ($root in $commonRoots) {
        foreach ($keyword in $AppKeywords) {
            # 在常见根目录下查找包含关键字的子目录
            $matchDirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | Where-Object {
                $_.Name -like "*$keyword*"
            }
            foreach ($dir in $matchDirs) {
                $asarPath = Join-Path $dir.FullName "resources\app.asar"
                if (Test-Path $asarPath) {
                    Print-Ok "从常见目录找到: $asarPath"
                    return $asarPath
                }
            }
        }
    }

    # ---- 策略 4: 全盘搜索 (较慢) ----
    Print-Warn "常规路径未找到，正在进行全盘搜索 (可能需要几十秒)..."
    # 获取所有可用磁盘
    $drives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Used -ne $null }
    foreach ($drive in $drives) {
        $driveRoot = $drive.Root
        Print-Log "正在搜索 $driveRoot ..."
        try {
            # 使用 cmd /c where 或 Get-ChildItem 递归搜索 (限制深度避免过慢)
            $results = Get-ChildItem -Path $driveRoot -Filter "app.asar" -Recurse -Depth 6 -ErrorAction SilentlyContinue |
                Where-Object {
                    $parentDir = Split-Path $_.DirectoryName -Parent
                    # 确认是 Electron 应用且包含关键字
                    $_.DirectoryName -like "*\resources" -and (
                        $parentDir -like "*新点即时通讯*" -or
                        $parentDir -like "*EpointMsg*" -or
                        $parentDir -like "*xindian*"
                    )
                }
            if ($results) {
                $found = $results[0].FullName
                Print-Ok "全盘搜索找到: $found"
                return $found
            }
        } catch {}
    }

    return $null
}

function Check-App {
    $script:AsarFile = Find-AsarFile
    if (-not $script:AsarFile) {
        Print-Err "自动搜索未找到新点即时通讯应用"
        if ($script:IsPipelineMode) {
            # 管道模式下无法交互输入，直接退出
            Print-Err "当前为远程管道模式 (irm|iex)，无法进行手动输入。"
            Print-Err "请确保应用已安装后重试，或下载脚本本地运行以支持手动指定路径。"
            exit 1
        }
        Write-Host ""
        Write-Host "  请手动输入 app.asar 文件的完整路径" -ForegroundColor Yellow
        Write-Host "  例如: D:\MyApps\新点即时通讯\resources\app.asar" -ForegroundColor Gray
        Write-Host ""
        $manualPath = Read-Host "  路径"
        $manualPath = $manualPath.Trim().Trim('"')

        if ($manualPath -and (Test-Path $manualPath) -and $manualPath.EndsWith("app.asar")) {
            $script:AsarFile = $manualPath
            Print-Ok "使用手动指定路径: $script:AsarFile"
        } else {
            Print-Err "路径无效或文件不存在: $manualPath"
            exit 1
        }
    }
    $script:AppDir = Split-Path (Split-Path $script:AsarFile -Parent) -Parent
    Print-Ok "确认应用 ASAR: $script:AsarFile"
}

function Get-FileLockingProcesses {
    <#
    .SYNOPSIS
    诊断锁定指定文件的进程（纯 PowerShell 实现，无需第三方工具）
    #>
    param([string]$FilePath)

    Print-Warn "正在诊断锁定 app.asar 的进程..."

    # 方法1: 遍历所有进程，找到 MainModule/Path 位于同一应用目录的进程
    $appDir = Split-Path (Split-Path $FilePath -Parent) -Parent
    $suspects = @()
    $allProcs = Get-Process -ErrorAction SilentlyContinue
    foreach ($p in $allProcs) {
        try {
            $exePath = $p.Path
            if ($exePath -and $exePath.StartsWith($appDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                $suspects += $p
            }
        } catch {}
    }

    if ($suspects.Count -gt 0) {
        Print-Warn "发现以下进程正在使用应用目录下的文件:"
        foreach ($p in $suspects) {
            Write-Host "    PID=$($p.Id)  Name=$($p.ProcessName)  Path=$($p.Path)" -ForegroundColor Yellow
        }
    } else {
        # 方法2: 遍历所有进程尝试找路径包含文件名的模块
        Print-Warn "未从进程路径定位，尝试枚举所有进程模块..."
        foreach ($p in $allProcs) {
            try {
                $modules = $p.Modules
                foreach ($m in $modules) {
                    if ($m.FileName -and $m.FileName -like "*app.asar*") {
                        Write-Host "    PID=$($p.Id)  Name=$($p.ProcessName)  Module=$($m.FileName)" -ForegroundColor Yellow
                        $suspects += $p
                    }
                }
            } catch {}
        }
    }

    # 方法3: 用 WMI 查找父子进程树（用 Win32_Process 的 ParentProcessId）
    try {
        $wmiProcs = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue
        $appPids = $suspects | ForEach-Object { $_.Id }
        if ($appPids.Count -gt 0) {
            Print-Warn "检查是否有子进程遗留:"
            foreach ($wp in $wmiProcs) {
                if ($wp.ParentProcessId -in $appPids) {
                    Write-Host "    子进程: PID=$($wp.ProcessId)  Name=$($wp.Name)  Parent=$($wp.ParentProcessId)" -ForegroundColor Yellow
                }
            }
        }
    } catch {}

    if ($suspects.Count -eq 0) {
        Print-Warn "未能通过进程路径定位锁定者，可能是杀毒软件/Windows Defender 或 SearchIndexer 临时扫描"
        Print-Warn "常见导致文件锁定的进程:"
        Write-Host "    - MsMpEng.exe (Windows Defender 实时保护)"
        Write-Host "    - SearchIndexer.exe (Windows 搜索索引)"
        Write-Host "    - 第三方杀毒软件 (360/火绒/腾讯管家等)"
        Print-Warn "建议: 在杀毒软件中将安装目录加入信任区，或暂时关闭实时保护后重试"
    }

    # 验证文件是否真的被锁
    try {
        $testStream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $testStream.Close()
        Print-Log "文件当前可正常访问（锁可能已自动释放）"
    } catch {
        Print-Err "文件仍被锁定，无法独占访问: $($_.Exception.Message)"
    }
}

function Kill-App {
    $kwRegex = ($AppKeywords | ForEach-Object { [regex]::Escape($_) }) -join '|'

    # 同时查找：关键字匹配的进程 + 所有 EXE 路径位于应用目录的进程（捕获 Helper 子进程）
    $appDir = if ($script:AppDir) { $script:AppDir } else { $null }

    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match $kwRegex -or $_.MainWindowTitle -match $kwRegex
    }

    # 如果已知 AppDir，额外查找路径在该目录下的所有进程（Electron Helper 等）
    if ($appDir -and (Test-Path $appDir)) {
        $helperProcs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -and $_.Path.StartsWith($appDir, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
        }
        if ($helperProcs) {
            $procs = @($procs) + @($helperProcs) | Sort-Object Id -Unique
        }
    }

    if ($procs) {
        Print-Warn "检测到应用正在运行，正在终止进程..."
        foreach ($proc in $procs) {
            try {
                Print-Log "  终止: PID=$($proc.Id) $($proc.ProcessName)"
                $proc.Kill()
            } catch {
                # 忽略已退出的进程
            }
        }
        # 等待进程退出
        $waitCount = 0
        do {
            Start-Sleep -Seconds 1
            $waitCount++
            $remaining = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $kwRegex }
            if (-not $remaining) { break }
            if ($waitCount -ge 10) {
                Print-Warn "进程未能正常退出，尝试强制终止..."
                foreach ($p in $remaining) {
                    try { $p.Kill() } catch {}
                }
                Start-Sleep -Seconds 1
                break
            }
        } while ($true)

        $stillRunning = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $kwRegex }
        if ($stillRunning) {
            Print-Err "无法终止应用进程，请手动关闭后重试"
            exit 1
        }
        Print-Ok "应用进程已终止"
        # 额外等待 Windows 释放文件句柄（Electron 使用内存映射文件，OS 释放需要短暂延迟）
        Print-Log "等待系统释放文件句柄..."
        Start-Sleep -Seconds 2
    } else {
        Print-Ok "应用未在运行中，可以继续操作"
    }
}

function Start-App {
    Print-Log "正在重新启动 `"$AppProcessName`"..."
    $exeCandidates = @(
        (Join-Path $script:AppDir "$AppProcessName.exe"),
        (Join-Path $script:AppDir "EpointMsg.exe")
    )
    foreach ($exe in $exeCandidates) {
        if (Test-Path $exe) {
            # 将进程的标准输出和错误重定向到临时文件，避免污染当前终端
            $outLog = Join-Path $env:TEMP "EpointMsg_out.log"
            $errLog = Join-Path $env:TEMP "EpointMsg_err.log"
            Start-Process -FilePath $exe -RedirectStandardOutput $outLog -RedirectStandardError $errLog
            Print-Ok "应用已启动"
            return
        }
    }
    Print-Warn "未找到可执行文件，请手动启动应用"
}

function Download-File {
    <#
    .SYNOPSIS
    下载文件到指定路径，支持超时控制与自动重试
    #>
    param(
        [string]$Url,
        [string]$OutPath,
        [int]$TimeoutSeconds = 30,
        [int]$MaxRetries = 3
    )

    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            $req = [System.Net.HttpWebRequest]::Create($Url)
            $req.Timeout = $TimeoutSeconds * 1000          # 连接+响应超时 (ms)
            $req.ReadWriteTimeout = $TimeoutSeconds * 1000 # 读取超时 (ms)
            $req.Method = 'GET'
            $req.UserAgent = 'RCAssist-Installer/1.0 PowerShell'
            $req.KeepAlive = $false

            $resp = $req.GetResponse()
            $statusCode = [int]$resp.StatusCode
            if ($statusCode -lt 200 -or $statusCode -ge 300) {
                $resp.Close()
                throw "HTTP $statusCode"
            }

            $stream = $resp.GetResponseStream()
            $outStream = [System.IO.File]::Create($OutPath)
            try {
                $buf = New-Object byte[] (64 * 1024)
                while ($true) {
                    $n = $stream.Read($buf, 0, $buf.Length)
                    if ($n -le 0) { break }
                    $outStream.Write($buf, 0, $n)
                }
            } finally {
                $outStream.Close()
                $stream.Close()
                $resp.Close()
            }
            return $true
        } catch {
            $errMsg = $_.Exception.Message
            $inner  = $_.Exception.InnerException
            if ($inner) { $errMsg += " | $($inner.Message)" }

            if ($attempt -lt $MaxRetries) {
                Print-Warn "下载失败 (第 $attempt/$MaxRetries 次) [$Url]: $errMsg"
                Print-Log "  ${TimeoutSeconds}s 后重试..."
                Start-Sleep -Seconds $TimeoutSeconds
            } else {
                Print-Err "下载失败 (已重试 $MaxRetries 次) [$Url]: $errMsg"
                # 清理可能产生的不完整文件
                Remove-Item $OutPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    return $false
}

# ============================================
# 安装流程
# ============================================

function Do-Install {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor White
    Write-Host "  📦 插件系统安装工具 (Windows 零依赖版)" -ForegroundColor White
    Write-Host "=========================================" -ForegroundColor White
    Write-Host ""

    # 创建临时工作目录
    $WorkDir = Join-Path $env:TEMP "rc_assist_install_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
    $ExtractDir = Join-Path $WorkDir "extract_app"

    try {
        # ---- 步骤 1: 检查应用 ----
        Print-Step "步骤 1/7: 检查应用包"
        Check-App
        $asarSize = (Get-Item $script:AsarFile).Length
        $asarSizeMB = [math]::Round($asarSize / 1MB, 2)
        Print-Log "ASAR 大小: ${asarSizeMB}MB"

        # ---- 步骤 2: 终止应用进程 ----
        Print-Step "步骤 2/7: 终止应用进程"
        Kill-App

        # ---- 步骤 3: 解包 ASAR 并注入引导代码 ----
        Print-Step "步骤 3/7: 解包 ASAR 并注入引导代码"
        New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
        Print-Log "正在从 app.asar 中提取文件，请稍候..."
        try {
            Expand-Asar -AsarPath $script:AsarFile -OutputDir $ExtractDir
        } catch {
            Print-Err "ASAR 解包失败: $_"
            exit 1
        }
        Print-Ok "提取完成！"

        $PreloadFile = Join-Path $ExtractDir "src\inject\preload.js"

        if (-not (Test-Path $PreloadFile)) {
            Print-Err "未找到 preload.js: $PreloadFile"
            Print-Err "注入失败，无法继续安装（应用结构不匹配）"
            exit 1
        }

        # 清理旧的注入
        $preloadContent = Get-Content $PreloadFile -Raw -Encoding UTF8
        if ($preloadContent -match "EPOINT_PLUGIN_INJECT_START") {
            Print-Warn "发现旧注入代码，正在清理..."
            $preloadContent = $preloadContent -replace '(?s)// >>> EPOINT_PLUGIN_INJECT_START <<<.*?// >>> EPOINT_PLUGIN_INJECT_END <<<\r?\n?', ''
            Set-Content -Path $PreloadFile -Value $preloadContent -Encoding UTF8 -NoNewline
            Print-Ok "旧注入代码已清理"
        }

        # 注入引导代码
        Add-Content -Path $PreloadFile -Value $InjectCode -Encoding UTF8
        Print-Ok "引导代码注入完成"

        # ---- 步骤 4: 重新打包并替换原生应用包 ----
        Print-Step "步骤 4/7: 重新打包并替换原生应用包"

        # 备份原文件
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $BackupFile = "$($script:AsarFile).backup.$timestamp"
        Print-Log "备份原应用包到: $BackupFile"
        Copy-Item $script:AsarFile $BackupFile -Force

        # 重新打包 → 先写入临时文件，避免直接写入被锁的 app.asar
        $TempAsarFile = "$($script:AsarFile).tmp"
        Print-Log "正在重新打包 asar（写入临时文件），这可能需要一些时间..."
        [Console]::Out.Flush()
        try {
            $null = Compress-Asar -InputDir $ExtractDir -OutputPath $TempAsarFile -OriginalAsarPath $BackupFile
        } catch {
            Print-Err "ASAR 重新打包失败: $_"
            Remove-Item $TempAsarFile -Force -ErrorAction SilentlyContinue
            exit 1
        }
        Print-Ok "打包完成，准备替换原文件..."

        # 用重试机制替换原文件（杀毒软件/Defender 可能短暂持有文件锁）
        $replaceOk = $false
        for ($i = 1; $i -le 10; $i++) {
            try {
                # 先删除原文件（如果文件有锁此处会抛异常）
                Remove-Item $script:AsarFile -Force -ErrorAction Stop
                # 再把临时文件移动过来（原子性更好）
                Move-Item $TempAsarFile $script:AsarFile -Force -ErrorAction Stop
                $replaceOk = $true
                break
            } catch {
                if ($i -eq 1) {
                    Print-Warn "app.asar 当前被锁定，正在等待释放（可能是杀毒软件扫描）..."
                }
                Print-Log "  第 $i/10 次尝试失败，2秒后重试: $($_.Exception.Message)"
                Start-Sleep -Seconds 2
            }
        }

        if (-not $replaceOk) {
            Print-Err "ASAR 替换失败：文件持续被锁定，无法写入"
            Get-FileLockingProcesses -FilePath $script:AsarFile
            Print-Err "正在恢复备份..."
            Copy-Item $BackupFile $script:AsarFile -Force -ErrorAction SilentlyContinue
            Remove-Item $TempAsarFile -Force -ErrorAction SilentlyContinue
            exit 1
        }
        Print-Ok "打包替换完成"

        # Windows 不需要处理 codesign/xattr
        Print-Ok "注入成功 ✓ (Windows 无需处理签名)"

        # ---- 步骤 5: 拉取组件清单 ----
        Print-Step "步骤 5/7: 拉取组件清单 (manifest.json)"
        $ManifestFile = Join-Path $WorkDir "manifest.json"
        $manifestUrl  = "$ServerUrl/manifest.json"
        Print-Log "正在连接: $manifestUrl"
        if (Download-File $manifestUrl $ManifestFile) {
            Print-Ok "组件清单下载完成"
        } else {
            Write-Host ""
            Print-Err "下载 manifest.json 失败，脚本无法继续"
            Write-Host "  可能原因:" -ForegroundColor Yellow
            Write-Host "    1. 服务器地址不可达，请确认 $ServerUrl 能否在浏览器打开" -ForegroundColor Yellow
            Write-Host "    2. 网络代理/防火墙拦截了请求" -ForegroundColor Yellow
            Write-Host "    3. 服务器尚未启动或 manifest.json 不存在" -ForegroundColor Yellow
            Write-Host "  解决方法:" -ForegroundColor Cyan
            Write-Host "    - 检查网络连接后重新运行脚本" -ForegroundColor Cyan
            Write-Host "    - 或在浏览器打开 $manifestUrl 确认服务可用" -ForegroundColor Cyan
            Write-Host ""
            exit 1
        }

        # ---- 清理旧插件数据 ----
        Print-Log "正在清理旧的插件数据: $PluginDataDir"
        if (Test-Path $PluginDataDir) {
            Get-ChildItem -Path $PluginDataDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            New-Item -ItemType Directory -Path $PluginDataDir -Force | Out-Null
        }

        # ---- 步骤 6: 安装核心组件 ----
        Print-Step "步骤 6/7: 安装核心组件"

        $CoreDir = Join-Path $PluginDataDir "core"
        New-Item -ItemType Directory -Path $CoreDir -Force | Out-Null
        Print-Log "核心组件安装目录: $CoreDir"

        $manifest = Get-Content $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $coreCount = 0
        $coreErrorCount = 0

        if ($manifest.core) {
            $coreProps = $manifest.core.PSObject.Properties
            foreach ($prop in $coreProps) {
                $coreKey = $prop.Name
                $coreInfo = $prop.Value
                $coreFile = $coreInfo.file
                $coreVer = $coreInfo.version
                $coreFilename = Split-Path $coreFile -Leaf

                Print-Log "正在下载核心组件: $coreKey (v$coreVer) → $coreFilename"
                $destPath = Join-Path $CoreDir $coreFilename
                if (Download-File "$ServerUrl/$coreFile" $destPath) {
                    $coreCount++
                    Print-Ok "  $coreKey 安装完成"
                } else {
                    $coreErrorCount++
                    Print-Err "  $coreKey 下载失败"
                }
            }

            # 写入 .version.json
            $VersionFile = Join-Path $PluginDataDir ".version.json"
            $versionInfo = @{
                coreVersions = @{}
                lastCoreUpdate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
            }
            foreach ($prop in $coreProps) {
                $versionInfo.coreVersions[$prop.Name] = $prop.Value.version
            }
            if ($versionInfo.coreVersions.ContainsKey("pluginManager")) {
                $versionInfo["coreVersion"] = $versionInfo.coreVersions["pluginManager"]
            }
            $versionInfo | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $VersionFile -Encoding UTF8

            if ($coreErrorCount -eq 0) {
                Print-Ok "全部 $coreCount 个核心组件安装完成 ✓"
            } else {
                Print-Warn "$coreCount 个成功 / $coreErrorCount 个失败"
            }
        } else {
            Print-Warn "manifest 中未找到核心组件定义，跳过"
        }

        # ---- 步骤 7: 安装插件 ----
        Print-Step "步骤 7/7: 安装插件"

        $PluginsDir = Join-Path $PluginDataDir "plugins"
        New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
        Print-Log "插件安装目录: $PluginsDir"

        $pluginCount = 0
        $pluginErrorCount = 0

        if ($manifest.plugins -and $manifest.plugins.Count -gt 0) {
            foreach ($plugin in $manifest.plugins) {
                $plugId = $plugin.id
                $plugFile = $plugin.file
                $plugVer = $plugin.version
                $plugFmt = if ($plugin.format) { $plugin.format } else { "js" }

                $plugDir = Join-Path $PluginsDir $plugId
                New-Item -ItemType Directory -Path $plugDir -Force | Out-Null
                Print-Log "正在安装插件: $plugId (v$plugVer)"

                $plugDl = Join-Path $WorkDir "download_$(Split-Path $plugFile -Leaf)"
                if (Download-File "$ServerUrl/$plugFile" $plugDl) {
                    if ($plugFmt -eq "zip") {
                        # 使用 .NET 内置 ZIP 解压 (无需 Python)
                        try {
                            Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
                            [System.IO.Compression.ZipFile]::ExtractToDirectory($plugDl, $plugDir)
                            $pluginCount++
                            Print-Ok "  $plugId 解压安装完成"
                        } catch {
                            $pluginErrorCount++
                            Print-Err "  $plugId 解压失败: $_"
                        }
                    } else {
                        # 单文件格式
                        Copy-Item $plugDl (Join-Path $plugDir "main.js") -Force
                        $pluginCount++
                        Print-Ok "  $plugId 安装完成"
                    }
                    Remove-Item $plugDl -Force -ErrorAction SilentlyContinue
                } else {
                    $pluginErrorCount++
                    Print-Err "  $plugId 下载失败"
                }
            }

            if ($pluginErrorCount -eq 0) {
                Print-Ok "全部 $pluginCount 个插件安装完成 ✓"
            } else {
                Print-Warn "$pluginCount 个成功 / $pluginErrorCount 个失败"
            }
        } else {
            Print-Warn "manifest 中未找到插件定义，跳过"
        }

        # ---- 写入客户端配置 (plugin-config.json) ----
        # 注意：直接使用字符串模板拼装 JSON，避免 PowerShell ConvertTo-Json
        #       将空数组 @() 序列化为 null 的已知 bug（导致客户端读取 plugins 字段为 null）
        Print-Log "正在写入客户端配置 (serverUrl: $ServerUrl)..."
        $ConfigFile = Join-Path $PluginDataDir "plugin-config.json"
        $escapedUrl = $ServerUrl -replace '\\', '\\\\' -replace '"', '\"'
        $cfgJson = "{`"version`":`"2.0.0`",`"serverUrl`":`"$escapedUrl`",`"guideShown`":false,`"plugins`":[]}"
        [System.IO.File]::WriteAllText($ConfigFile, $cfgJson, [System.Text.Encoding]::UTF8)
        Print-Ok "客户端配置已写入: $ConfigFile"
        Print-Log "  内容: $cfgJson"

        # ---- 完成 ----
        Write-Host ""
        Write-Host "=========================================" -ForegroundColor White
        Write-Host "  安装全部完成！" -ForegroundColor Green
        Write-Host "=========================================" -ForegroundColor White
        Write-Host ""
        Write-Host "  📁 核心组件: $CoreDir"
        Write-Host "  📁 插件目录: $PluginsDir"
        Write-Host "  📁 备份文件: $BackupFile"
        Write-Host ""
        Write-Host -NoNewline "  核心组件: "; Write-Host -NoNewline "$coreCount 个" -ForegroundColor Green
        if ($coreErrorCount -gt 0) { Write-Host -NoNewline " / $coreErrorCount 个失败" -ForegroundColor Red }
        Write-Host ""
        Write-Host -NoNewline "  插件:     "; Write-Host -NoNewline "$pluginCount 个" -ForegroundColor Green
        if ($pluginErrorCount -gt 0) { Write-Host -NoNewline " / $pluginErrorCount 个失败" -ForegroundColor Red }
        Write-Host ""
        Write-Host ""

        Start-App
        Write-Host ""
        Write-Host "  可以关闭终端" -ForegroundColor Cyan
        Write-Host ""

    } finally {
        # 清理临时目录
        if (Test-Path $WorkDir) {
            Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ============================================
# 卸载流程
# ============================================

function Do-Uninstall {
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor White
    Write-Host "  🔄 插件系统卸载/还原工具" -ForegroundColor White
    Write-Host "=========================================" -ForegroundColor White
    Write-Host ""

    # ---- 步骤 1: 查找备份文件 ----
    Print-Step "步骤 1/5: 查找备份文件"
    Check-App

    $backupPattern = "$($script:AsarFile).backup.*"
    $backups = Get-ChildItem -Path (Split-Path $script:AsarFile -Parent) -Filter "app.asar.backup.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending

    if (-not $backups -or $backups.Count -eq 0) {
        Print-Err "未找到任何备份文件！"
        Print-Err "请确认之前是否执行过安装脚本（备份文件格式: app.asar.backup.YYYYMMDD_HHMMSS）"
        exit 1
    }

    $latestBackup = $backups[0].FullName

    Write-Host ""
    Print-Log "找到以下备份文件:"
    $idx = 0
    foreach ($bak in $backups) {
        $idx++
        $bakSize = "{0:N2}MB" -f ($bak.Length / 1MB)
        $bakDate = $bak.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
        if ($idx -eq 1) {
            Write-Host "  " -NoNewline
            Write-Host "[最新]" -ForegroundColor Green -NoNewline
            Write-Host " $($bak.Name) ($bakSize, $bakDate)"
        } else {
            Write-Host "        $($bak.Name) ($bakSize, $bakDate)"
        }
    }
    Write-Host ""
    Print-Ok "将使用最新备份: $(Split-Path $latestBackup -Leaf)"

    # ---- 步骤 2: 终止应用进程 ----
    Print-Step "步骤 2/5: 终止应用进程"
    Kill-App

    # ---- 步骤 3: 还原备份 ----
    Print-Step "步骤 3/5: 还原原始应用包"
    Print-Log "正在从备份还原 app.asar..."
    Copy-Item $latestBackup $script:AsarFile -Force
    Print-Ok "app.asar 已还原"

    # Windows 不需要处理签名
    Print-Ok "无需处理签名（Windows）"

    # ---- 步骤 4: 清理插件数据 ----
    Print-Step "步骤 4/5: 清理插件数据"
    if (Test-Path $PluginDataDir) {
        Print-Log "正在清理插件数据目录: $PluginDataDir"
        Remove-Item $PluginDataDir -Recurse -Force
        Print-Ok "插件数据目录已清理"
    } else {
        Print-Ok "无插件数据目录需要清理"
    }

    # ---- 步骤 5: 清理备份文件 ----
    Print-Step "步骤 5/5: 清理备份文件"
    $backupCount = $backups.Count
    if ($backupCount -gt 0) {
        Print-Log "正在清理 $backupCount 个备份文件..."
        foreach ($bak in $backups) {
            Remove-Item $bak.FullName -Force -ErrorAction SilentlyContinue
        }
        Print-Ok "备份文件已清理"
    }

    # ---- 完成 ----
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor White
    Write-Host "  插件系统已卸载，应用已还原为原始状态！" -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor White
    Write-Host ""

    Start-App
    Write-Host ""
    Write-Host "  可以关闭终端" -ForegroundColor Cyan
    Write-Host ""
}

# ============================================
# 主入口
# ============================================

switch ($Action) {
    "install"   { Do-Install }
    "uninstall" { Do-Uninstall }
    default {
        Write-Host "用法:"
        Write-Host "  安装: .\install.ps1"
        Write-Host "  卸载: .\install.ps1 uninstall"
        Write-Host ""
        Write-Host "  一键安装:"
        Write-Host "    irm '$ScriptsUrl/install.ps1'|iex"
        Write-Host ""
        Write-Host "  一键卸载:"
        Write-Host "    `$env:RC_ACTION='uninstall';irm '$ScriptsUrl/install.ps1'|iex"
        exit 1
    }
}
