#Requires -Version 5.1
<#
  build-installer.ps1 — 从本仓库源码重新生成单文件安装器 install-browser-pro.ps1

  用法：
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
      # 或指定输出位置
      powershell -ExecutionPolicy Bypass -File .\build-installer.ps1 -OutFile .\dist\install-browser-pro.ps1

  生成器把以下文件 base64 内嵌进安装器：
      preset/preset.yml
      preset/agent.cordis.yml            （保留 {{PLUGIN_PATH}} 占位符，安装时替换）
      browser-agent/browser-agent-plugin.mjs
      browser-agent/server.cjs
      browser-agent/config.json
      browser-agent/package.json
      browser-agent/README.md

  输出编码为 UTF-8 with BOM（Windows PowerShell 5.1 解析 .ps1 需要 BOM 才能正确识别中文）。
#>
[CmdletBinding()]
param(
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir

if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $OutFile = Join-Path $scriptDir 'install-browser-pro.ps1'
}

$sources = @{
  '__B64_PRESET_YML__'   = Join-Path $repoRoot 'preset\preset.yml'
  '__B64_AGENT_CORDIS__' = Join-Path $repoRoot 'preset\agent.cordis.yml'
  '__B64_PLUGIN__'       = Join-Path $repoRoot 'browser-agent\browser-agent-plugin.mjs'
  '__B64_SERVER__'       = Join-Path $repoRoot 'browser-agent\server.cjs'
  '__B64_CONFIG__'       = Join-Path $repoRoot 'browser-agent\config.json'
  '__B64_PACKAGE__'      = Join-Path $repoRoot 'browser-agent\package.json'
  '__B64_README__'       = Join-Path $repoRoot 'browser-agent\README.md'
}

$templatePath = Join-Path $scriptDir 'installer.template.ps1'
if (-not (Test-Path $templatePath)) { throw "template not found: $templatePath" }
$template = Get-Content $templatePath -Raw -Encoding UTF8

foreach ($key in $sources.Keys) {
  $file = $sources[$key]
  if (-not (Test-Path $file)) { throw "source not found: $file" }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
  $template = $template.Replace($key, $b64)
  Write-Host ("   embedded {0} ({1} bytes -> {2} b64)" -f (Split-Path $file -Leaf), (Get-Item $file).Length, $b64.Length)
}

if ($template.Contains('__B64_')) { throw 'placeholder not replaced, aborting' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
[IO.File]::WriteAllText($OutFile, $template, (New-Object Text.UTF8Encoding($true)))
Write-Host ("OK: {0} ({1} bytes, UTF-8 BOM)" -f $OutFile, (Get-Item $OutFile).Length) -ForegroundColor Green
