# Augment Proxy Injector for Windows
# Run as Administrator

param(
    [int]$Port = 8765,
    [switch]$Restore
)

$ErrorActionPreference = "Stop"

Write-Host "=== Augment Proxy Injector ===" -ForegroundColor Cyan

$extensionsDir = Join-Path $env:USERPROFILE ".vscode\extensions"
$augmentDir = Get-ChildItem $extensionsDir -Directory | Where-Object { $_.Name -like "augment.vscode-augment-*" } | Sort-Object Name | Select-Object -Last 1

if (-not $augmentDir) {
    Write-Host "Error: Augment extension not found" -ForegroundColor Red
    exit 1
}

$jsPath = Join-Path $augmentDir.FullName "out\extension.js"
$backupPath = $jsPath + ".backup"

Write-Host "Found: $($augmentDir.Name)" -ForegroundColor Green
Write-Host "Target: $jsPath"

# Kill all VSCode processes
$vscodeProcesses = Get-Process -Name "Code" -ErrorAction SilentlyContinue
if ($vscodeProcesses) {
    Write-Host "Killing VSCode processes..." -ForegroundColor Yellow
    $vscodeProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# Also kill related processes
Get-Process -Name "Code - Insiders" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "electron" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Take ownership and grant full control
Write-Host "Setting file permissions..." -ForegroundColor Yellow
try {
    $acl = Get-Acl $jsPath
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl $jsPath $acl
} catch {
    Write-Host "Warning: Could not set permissions: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Remove read-only attribute
Set-ItemProperty $jsPath -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue

if ($Restore) {
    if (Test-Path $backupPath) {
        Copy-Item $backupPath $jsPath -Force
        Write-Host "Restored from backup" -ForegroundColor Green
    } else {
        Write-Host "Error: Backup not found" -ForegroundColor Red
    }
    exit 0
}

$content = Get-Content $jsPath -Raw -Encoding UTF8
if ($content -match "AUGMENT_PROXY_INJECTION") {
    Write-Host "Already injected, restoring first..." -ForegroundColor Yellow
    if (Test-Path $backupPath) {
        Copy-Item $backupPath $jsPath -Force
        $content = Get-Content $jsPath -Raw -Encoding UTF8
    }
}

if (-not (Test-Path $backupPath)) {
    Copy-Item $jsPath $backupPath
    Write-Host "Backup created" -ForegroundColor Green
}

$proxyUrl = "http://localhost:$Port"
$timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"

# Read injection template from same directory as this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$templatePath = Join-Path $scriptDir "injection-template.js"

if (-not (Test-Path $templatePath)) {
    Write-Host "Error: injection-template.js not found" -ForegroundColor Red
    Write-Host "Expected at: $templatePath" -ForegroundColor Red
    exit 1
}

Write-Host "Reading injection template..." -ForegroundColor Cyan
$js = Get-Content $templatePath -Raw -Encoding UTF8

# Replace placeholders
$js = $js -replace '__PROXY_URL__', $proxyUrl
$js = $js -replace '__TIMESTAMP__', $timestamp

# Prepend injection code to BEGINNING (same as Mac version)
# Use LF line ending (not CRLF) for JavaScript compatibility
$newContent = $js + "`n" + $content
[System.IO.File]::WriteAllText($jsPath, $newContent, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "=== Injection Success! ===" -ForegroundColor Green
Write-Host "Proxy: $proxyUrl" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Start VSCode"
Write-Host "2. Start proxy server in Augment Proxy Manager"
Write-Host "3. Enjoy!"
Write-Host ""
Write-Host "To restore: .\inject-windows.ps1 -Restore" -ForegroundColor Gray

