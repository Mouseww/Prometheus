#Requires -Version 5.1
<#
.SYNOPSIS
  One-time setup of the Prometheus Hub Windows sandbox (tenant runtime driver "sandbox").

.DESCRIPTION
  Run once from an elevated PowerShell ("Run as administrator") as the account that runs the Hub.
  It
    1. creates the local group "prometheus-tenants" (tenant accounts prom_t_* are added to it by the Hub),
    2. denies that group read access to the Hub owner's profile folder and to the Hub data directory,
    3. creates "<DataDir>\tenants" (tenant directories live there; each tenant account gets an explicit grant on its own folders, which outranks the inherited deny),
    4. writes the marker "<DataDir>\sandbox-setup.json" that tells the Hub the sandbox is ready.

  The per-tenant accounts themselves are created by the Hub on first use of each tenant (it needs the same administrator rights once, so start the Hub elevated the first time or pre-create tenants from here).

  Node and the Prometheus repository must NOT live inside the Hub owner's profile folder: the tenant accounts are denied read access there and could not start.

.PARAMETER DataDir
  The Hub data directory (HubOptions.dataDir). Default: $env:HUB_DATA_DIR.

.PARAMETER HubHome
  The Hub owner's profile folder. Default: $env:USERPROFILE.

.EXAMPLE
  pnpm hub:setup-sandbox -- -DataDir D:\prometheus-hub
#>
[CmdletBinding()]
param(
	[string]$DataDir = $env:HUB_DATA_DIR,
	[string]$HubHome = $env:USERPROFILE
)

$ErrorActionPreference = 'Stop'
$Group = 'prometheus-tenants'
$Marker = 'sandbox-setup.json'

function Test-Admin {
	$id = [Security.Principal.WindowsIdentity]::GetCurrent()
	return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
	Write-Error '需要管理员权限：请右键 PowerShell，选择“以管理员身份运行”，然后重新执行本脚本。'
	exit 1
}
if (-not $DataDir) {
	Write-Error '请用 -DataDir 指定 Hub 数据目录（或设置环境变量 HUB_DATA_DIR）。'
	exit 1
}
if (-not (Test-Path -LiteralPath $HubHome)) {
	Write-Error "Hub 所有者目录不存在: $HubHome"
	exit 1
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$DataDir = (Resolve-Path -LiteralPath $DataDir).Path
$Tenants = Join-Path $DataDir 'tenants'
New-Item -ItemType Directory -Force -Path $Tenants | Out-Null

if (-not (Get-LocalGroup -Name $Group -ErrorAction SilentlyContinue)) {
	New-LocalGroup -Name $Group -Description 'Prometheus Hub tenant accounts' | Out-Null
	Write-Host "已创建本地组 $Group"
} else {
	Write-Host "本地组 $Group 已存在"
}

foreach ($path in @($HubHome, $DataDir)) {
	& icacls $path /deny "${Group}:(OI)(CI)R" /C /Q
	if ($LASTEXITCODE -ne 0) { throw "icacls 拒绝 $Group 读取 $path 失败 (退出码 $LASTEXITCODE)" }
	Write-Host "已拒绝 $Group 读取 $path"
}

$info = [ordered]@{
	version   = 1
	group     = $Group
	hubHome   = $HubHome
	dataDir   = $DataDir
	createdAt = (Get-Date).ToUniversalTime().ToString('o')
}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DataDir $Marker) -Encoding UTF8
Write-Host "完成。标记文件: $(Join-Path $DataDir $Marker)"
Write-Host '提示：Node 与 Prometheus 仓库不能放在 Hub 所有者的用户目录里。'
