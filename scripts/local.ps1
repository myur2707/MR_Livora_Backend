param(
    [ValidateSet('setup', 'start', 'stop', 'status')]
    [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$backend = Split-Path $PSScriptRoot -Parent
$workspace = Split-Path $backend -Parent
$frontend = Join-Path $workspace 'MR_Livora_Frontend'
$tools = Join-Path $workspace '.local-tools'
$localRoot = Join-Path $backend '.local-db\manual'
$settingsPath = Join-Path $localRoot 'settings.json'
$processPath = Join-Path $localRoot 'processes.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$records = @{}
if (Test-Path -LiteralPath $processPath) {
    $saved = Get-Content -LiteralPath $processPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $records[$property.Name] = $property.Value }
}
function Quote([string]$Value) { return '"' + $Value + '"' }
function Save-Processes {
    [IO.File]::WriteAllText($processPath, ($records | ConvertTo-Json -Depth 4), $utf8)
}
function Get-OwnedProcess([string]$Name) {
    $record = $records[$Name]
    if (!$record) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.id)" -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    $live = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if (!$live -or $live.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.started) { return $null }
    if ($process.ExecutablePath -ne $record.executable -or !$process.CommandLine.Contains($record.marker)) {
        throw "Refusing to manage an unexpected process recorded as $Name."
    }
    return $live
}
function Assert-Free([int]$Port) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        throw "Port $Port is occupied. No existing service was stopped."
    }
}
function Start-LocalProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$Marker) {
    if (Get-OwnedProcess $Name) { return }
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localRoot "$Name.stdout.log") -RedirectStandardError (Join-Path $localRoot "$Name.stderr.log")
    $records[$Name] = @{ id = $process.Id; executable = $Executable; marker = $Marker; started = $process.StartTime.ToUniversalTime().Ticks.ToString() }
    Save-Processes
}
function Wait-Port([string]$Name, [int]$Port) {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (!(Get-OwnedProcess $Name)) { throw "$Name exited. Inspect ignored logs in $localRoot." }
        $socket = New-Object Net.Sockets.TcpClient
        try { $socket.Connect('127.0.0.1', $Port); return } catch { Start-Sleep -Milliseconds 200 } finally { $socket.Dispose() }
    }
    throw "$Name did not become ready on port $Port. Inspect ignored local logs."
}
function New-Secret {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Run-Npm([string]$Directory, [string]$Script) {
    Push-Location $Directory
    try {
        & $npm run $Script
        if ($LASTEXITCODE -ne 0) { throw "npm run $Script failed in $Directory." }
    } finally { Pop-Location }
}
if ($Action -eq 'status') {
    foreach ($name in @('mysql', 'mail', 'backend', 'frontend')) {
        $running = [bool](Get-OwnedProcess $name)
        Write-Host ("{0}: {1}" -f $name, $(if ($running) { 'running' } else { 'stopped' }))
    }
    exit 0
}
if ($Action -eq 'stop') {
    foreach ($name in @('frontend', 'backend', 'mail')) {
        $process = Get-OwnedProcess $name
        if ($process) { Stop-Process -Id $process.Id -ErrorAction Stop }
        $records.Remove($name)
    }
    $mysqlProcess = Get-OwnedProcess 'mysql'
    if ($mysqlProcess) {
        $mysqlAdmin = Join-Path $tools 'mysql-8.4.8-winx64\bin\mysqladmin.exe'
        $clientConfig = Join-Path $localRoot 'admin-client.ini'
        & $mysqlAdmin "--defaults-extra-file=$clientConfig" shutdown
        if ($LASTEXITCODE -ne 0) { throw 'Local MySQL shutdown failed; no process was forcibly terminated.' }
        $mysqlProcess.WaitForExit(10000) | Out-Null
        if (!$mysqlProcess.HasExited) { throw 'Local MySQL is still shutting down.' }
    }
    $records.Remove('mysql')
    if (Test-Path -LiteralPath $localRoot) { Save-Processes }
    Write-Host 'Local services stopped. All database and inbox data were retained.'
    exit 0
}
$node = Join-Path $tools 'node-v24.21.0-win-x64\node.exe'
$npm = Join-Path $tools 'node-v24.21.0-win-x64\npm.cmd'
$mysql = Join-Path $tools 'mysql-8.4.8-winx64\bin\mysqld.exe'
foreach ($file in @($node, $npm, $mysql)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Required portable tool missing: $file. See docs/testing/LOCAL_TESTING.md." }
}
$env:Path = (Split-Path $node -Parent) + ';' + $env:Path
if ($Action -eq 'setup' -and !(Test-Path -LiteralPath $settingsPath)) {
    if (Test-Path -LiteralPath $localRoot) { throw 'Existing manual data directory has no settings; refusing to initialize it.' }
    Assert-Free 3307
    New-Item -ItemType Directory -Path $localRoot | Out-Null
    $settings = @{ dataRoot = $localRoot; dbPort = 3307; adminPassword = (New-Secret); provisioned = $false }
    [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json), $utf8)
    $base = (Split-Path (Split-Path $mysql -Parent) -Parent).Replace('\', '/')
    $data = (Join-Path $localRoot 'data').Replace('\', '/')
    $log = (Join-Path $localRoot 'mysql-server.log').Replace('\', '/')
    $ini = @"
[mysqld]
basedir=$base
datadir=$data
bind-address=127.0.0.1
port=3307
mysqlx=OFF
log_bin_trust_function_creators=1
log-error=$log
"@
    $iniPath = Join-Path $localRoot 'server.ini'
    [IO.File]::WriteAllText($iniPath, $ini, $utf8)
    # The directory was just created above. Never initialize or overwrite existing data.
    $init = Start-Process -FilePath $mysql -ArgumentList @(('--defaults-file=' + (Quote $iniPath)), '--initialize-insecure') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $localRoot 'mysql-init.stdout.log') -RedirectStandardError (Join-Path $localRoot 'mysql-init.stderr.log')
    if ($init.ExitCode -ne 0) { throw 'MySQL initialization failed. Retained local files require inspection; no automatic retry.' }
}
if (!(Test-Path -LiteralPath $settingsPath)) { throw 'Run scripts/local.ps1 setup once before start.' }
$settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath($settings.dataRoot) -ne [IO.Path]::GetFullPath($localRoot) -or $settings.dbPort -ne 3307) {
    throw 'Local settings target an unexpected instance.'
}
if (!$settings.provisioned -and $Action -ne 'setup') { throw 'Local setup is incomplete. Inspect its retained files before retrying setup.' }
if ($settings.provisioned) {
    $localEnv = @{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $backend '.env') -Encoding UTF8)) {
        if ($line -match '^([A-Z_]+)=(.*)$') { $localEnv[$matches[1]] = $matches[2] }
    }
    $expected = @{ NODE_ENV = 'development'; DB_HOST = '127.0.0.1'; DB_PORT = '3307'; DB_NAME = 'livora_dev_manual'; DB_USER = 'livora_manual_migrator'; APP_DB_USER = 'livora_manual_app'; HOST = '127.0.0.1'; PORT = '3000'; APP_ORIGIN = 'http://127.0.0.1:4200'; SMTP_HOST = '127.0.0.1'; SMTP_PORT = '1025' }
    foreach ($name in $expected.Keys) {
        if ($localEnv[$name] -ne $expected[$name]) { throw "Managed local .env has an unexpected $name setting. No database configuration was changed." }
    }
}
if (!(Get-OwnedProcess 'mysql')) {
    Assert-Free $settings.dbPort
    $iniPath = Join-Path $localRoot 'server.ini'
    Start-LocalProcess 'mysql' $mysql @(('--defaults-file=' + (Quote $iniPath)), '--standalone') $backend $iniPath
}
Wait-Port 'mysql' $settings.dbPort
if (!$settings.provisioned) {
    $mailFolder = Join-Path $tools 'mailpit-v1.31.3'
    if (!(Test-Path -LiteralPath (Join-Path $mailFolder 'mailpit.exe'))) {
        $archive = Join-Path $tools 'mailpit-v1.31.3-windows-amd64.zip'
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri 'https://github.com/axllent/mailpit/releases/download/v1.31.3/mailpit-windows-amd64.zip' -OutFile $archive -UseBasicParsing
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '863e9502d4e0f14a78c0f91c5091797b1c7b7b7e3fc7e5eab62e5770ce44b76e') {
            throw 'Mailpit archive checksum differs; refusing to install.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath $mailFolder
    }
    $openssl = @('C:\xampp_2\apache\bin\openssl.exe', 'C:\Program Files\Git\usr\bin\openssl.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$openssl) { throw 'OpenSSL is required to create the local SMTP certificate. See local testing guide.' }
    $cert = Join-Path $localRoot 'smtp-cert.pem'
    $key = Join-Path $localRoot 'smtp-key.pem'
    $certConfig = Join-Path $localRoot 'smtp-certificate.ini'
    $sslConfig = @"
[req]
distinguished_name=dn
x509_extensions=server
prompt=no
[dn]
CN=localhost
[server]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage=serverAuth
"@
    [IO.File]::WriteAllText($certConfig, $sslConfig, $utf8)
    $generate = Start-Process -FilePath $openssl -ArgumentList @('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365', '-config', (Quote $certConfig), '-keyout', (Quote $key), '-out', (Quote $cert)) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $localRoot 'cert.stdout.log') -RedirectStandardError (Join-Path $localRoot 'cert.stderr.log')
    if ($generate.ExitCode -ne 0) { throw 'Local TLS certificate generation failed.' }
    foreach ($project in @($backend, $frontend)) {
        if (!(Test-Path -LiteralPath (Join-Path $project 'node_modules'))) {
            Push-Location $project
            try { & $npm ci; if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed.' } } finally { Pop-Location }
        }
    }
    Run-Npm $backend 'build'
    $previousMode = $env:NODE_ENV
    $env:NODE_ENV = 'development'
    Push-Location $backend
    try {
        & $node 'dist/database/local-development.js' 'provision'
        if ($LASTEXITCODE -ne 0) { throw 'Local provisioning failed. Do not delete data or retry blindly; inspect retained configuration.' }
    } finally { Pop-Location; $env:NODE_ENV = $previousMode }
    $client = @"
[client]
host=127.0.0.1
port=$($settings.dbPort)
user=root
password=$($settings.adminPassword)
"@
    [IO.File]::WriteAllText((Join-Path $localRoot 'admin-client.ini'), $client, $utf8)
    Write-Host 'Setup completed. No existing database or account was overwritten.'
}
foreach ($pair in @(@('backend', 3000), @('frontend', 4200), @('mail', 1025), @('mail', 8025))) {
    if (!(Get-OwnedProcess $pair[0])) { Assert-Free $pair[1] }
}
$mailpit = Join-Path $tools 'mailpit-v1.31.3\mailpit.exe'
if (!(Test-Path -LiteralPath $mailpit)) { throw 'Local Mailpit binary is missing.' }
$cert = Join-Path $localRoot 'smtp-cert.pem'
$key = Join-Path $localRoot 'smtp-key.pem'
$smtpAuth = Join-Path $localRoot 'smtp-auth.txt'
$inbox = Join-Path $localRoot 'mailpit.db'
Start-LocalProcess 'mail' $mailpit @('--listen', '127.0.0.1:8025', '--smtp', '127.0.0.1:1025', '--database', (Quote $inbox), '--smtp-tls-cert', (Quote $cert), '--smtp-tls-key', (Quote $key), '--smtp-require-starttls', '--smtp-auth-file', (Quote $smtpAuth)) $backend $inbox
Wait-Port 'mail' 1025
if (!(Get-OwnedProcess 'backend')) {
    Run-Npm $backend 'build'
    $previous = @{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $backend '.env') -Encoding UTF8)) {
        if ($line -match '^([A-Z_]+)=(.*)$') {
            $previous[$matches[1]] = [Environment]::GetEnvironmentVariable($matches[1], 'Process')
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
    $previous['NODE_EXTRA_CA_CERTS'] = $env:NODE_EXTRA_CA_CERTS
    $env:NODE_EXTRA_CA_CERTS = $cert
    $server = Join-Path $backend 'dist\server.js'
    try { Start-LocalProcess 'backend' $node @((Quote $server)) $backend $server }
    finally { foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') } }
}
Wait-Port 'backend' 3000
if (!(Get-OwnedProcess 'frontend')) {
    Run-Npm $frontend 'build'
    Run-Npm $frontend 'pwa:check'
    $previousPort = $env:PORT
    $previousApi = $env:PREVIEW_API_ORIGIN
    $previousFixtures = $env:PWA_TEST_FIXTURES
    $env:PORT = '4200'
    $env:PREVIEW_API_ORIGIN = 'http://127.0.0.1:3000'
    $env:PWA_TEST_FIXTURES = $null
    $preview = Join-Path $frontend 'scripts\serve-preview.mjs'
    try { Start-LocalProcess 'frontend' $node @((Quote $preview)) $frontend $preview }
    finally { $env:PORT = $previousPort; $env:PREVIEW_API_ORIGIN = $previousApi; $env:PWA_TEST_FIXTURES = $previousFixtures }
}
Wait-Port 'frontend' 4200
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:4200/api/v1/auth/csrf' | Out-Null
} catch { throw 'The frontend could not reach the local API. Inspect local logs.' }
Write-Host 'App: http://127.0.0.1:4200'
Write-Host 'Reset email inbox: http://127.0.0.1:8025'
Write-Host "Local test credentials: $localRoot\TEST_ACCOUNTS.md"
Write-Host 'Start/status/stop: powershell -ExecutionPolicy Bypass -File scripts/local.ps1 <action>'
