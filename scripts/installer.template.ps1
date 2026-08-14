#Requires -Version 5.1
<#
  ============================================================
  install-browser-pro.ps1
  一键安装 DeepSeek Harness "浏览器调研模式"（browser-pro 预设 + 15 个 browser_* 工具）
  单文件自包含：全部文件以内嵌 base64 携带，目标机器上运行一次即完成安装。
  ============================================================
  用法（目标机器，PowerShell）：
      powershell -ExecutionPolicy Bypass -File .\install-browser-pro.ps1

  参数：
      -DshHome <dir>   DSH 主目录（默认取 $env:DSH_HOME，其次 ~\.dsh）
      -NoNpm           跳过 playwright-core 的 npm 安装（已手动放置时用）
      -Force           覆盖已存在的文件
  ============================================================
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DshHome = '',
  [switch]$NoNpm,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ── 内嵌文件（base64，由打包生成器注入）─────────────────
$embedded = @{
  'preset/preset.yml' = '__B64_PRESET_YML__'
  'preset/agent.cordis.yml' = '__B64_AGENT_CORDIS__'
  'browser-agent/browser-agent-plugin.mjs' = '__B64_PLUGIN__'
  'browser-agent/server.cjs' = '__B64_SERVER__'
  'browser-agent/config.json' = '__B64_CONFIG__'
  'browser-agent/package.json' = '__B64_PACKAGE__'
  'browser-agent/README.md' = '__B64_README__'
}

# ── 路径解析 ─────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}
$presetDir = Join-Path $DshHome '.agent-presets\browser-pro'
$agentDir  = Join-Path $DshHome 'browser-agent'
$pluginPath = (Join-Path $agentDir 'browser-agent-plugin.mjs').Replace('\', '/')

Write-Host ''
Write-Host '== 安装 DSH 浏览器调研模式（browser-pro）==' -ForegroundColor Cyan
Write-Host ("   DSH 主目录 : {0}" -f $DshHome)

# ── 写文件 ───────────────────────────────────────────
foreach ($rel in $embedded.Keys) {
  $bytes = [Convert]::FromBase64String($embedded[$rel])
  $isPreset = $rel -like 'preset/*'
  $targetDir = if ($isPreset) { $presetDir } else { $agentDir }
  $relName = if ($isPreset) { $rel.Substring('preset/'.Length) } else { $rel.Substring('browser-agent/'.Length) }
  $target = Join-Path $targetDir $relName

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  if ((Test-Path $target) -and -not $Force) {
    Write-Host ("   跳过（已存在，加 -Force 覆盖）: {0}" -f $target) -ForegroundColor Yellow
    continue
  }
  if (-not $PSCmdlet.ShouldProcess($target, '写入文件')) { continue }

  if ($rel -eq 'preset/agent.cordis.yml') {
    # 预设里引用插件用的绝对路径随安装位置变化，写入前替换占位符
    $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
    $text = $text.Replace('{{PLUGIN_PATH}}', $pluginPath)
    [IO.File]::WriteAllText($target, $text, (New-Object Text.UTF8Encoding($false)))
  } else {
    [IO.File]::WriteAllBytes($target, $bytes)
  }
  Write-Host ("   写入: {0}" -f $target) -ForegroundColor Green
}

# ── playwright-core 依赖 ─────────────────────────────
if (-not $NoNpm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) {
    Write-Host '== 安装 playwright-core ==' -ForegroundColor Cyan
    & $npm.Source install --prefix $agentDir --no-save --no-audit --no-fund playwright-core@1.61.1
    if ($LASTEXITCODE -ne 0) {
      Write-Warning 'npm install 未成功。可手动执行该命令，或从其他机器复制一份 node_modules/playwright-core。'
    }
  } else {
    Write-Warning '未找到 npm，跳过依赖安装。请手动执行: npm install --prefix <插件目录> playwright-core@1.61.1'
  }
} else {
  Write-Host '已按 -NoNpm 跳过依赖安装；请确认插件目录下存在 node_modules/playwright-core。' -ForegroundColor Yellow
}

# ── 浏览器检测 ───────────────────────────────────────
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chromeFound = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) }
if ($chromeFound) {
  Write-Host ("   检测到 Chrome: {0}" -f ($chromeFound | Select-Object -First 1)) -ForegroundColor Green
} else {
  Write-Warning '未检测到 Chrome。请编辑 config.json：把 channel 改为 "msedge"（Windows 自带 Edge），或设置 executablePath 指向浏览器。'
}

# ── 完成 ─────────────────────────────────────────────
Write-Host ''
Write-Host '== 安装完成 ==' -ForegroundColor Cyan
Write-Host ("   预设目录 : {0}" -f $presetDir)
Write-Host ("   插件目录 : {0}" -f $agentDir)
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host '  1. 重启 DeepSeek Harness（新会话生效）。'
Write-Host '  2. 新建会话时选择预设 "浏览器调研模式"（browser-pro）。'
Write-Host '  3. 会话中即可使用 15 个 browser_* 工具（打开/搜索/点击/输入/截图/提取/Cookie 等）。'
Write-Host '  4. 需要真人扫码/验证码登录时：编辑 config.json 将 headless 改为 false，重开会话手动登录，登录态会持久保留。'
Write-Host ''
