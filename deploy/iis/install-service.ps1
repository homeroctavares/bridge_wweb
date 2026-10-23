[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\R2PHARMA\WhatsAppBridge',
  [string]$DataDir = 'C:\ProgramData\R2PHARMA\WhatsAppBridge',
  [string]$ServiceName = 'R2PHARMA-WhatsAppBridge',
  [string]$NssmPath = 'C:\Tools\nssm\nssm.exe',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$serviceAccount = 'NT AUTHORITY\NetworkService'

function Require-Path([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Description não encontrado: $Path"
  }
}

Require-Path $NssmPath 'NSSM'
Require-Path (Join-Path $InstallDir 'src\index.js') 'código da bridge'
Require-Path (Join-Path $InstallDir '.env') 'arquivo .env de produção'
Require-Path (Join-Path $InstallDir 'node_modules\express') 'dependências Node; execute npm ci --omit=dev antes'

$node = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22 ou superior é obrigatório; encontrado Node.js $nodeMajor." }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'logs') | Out-Null

# Somente o serviço e administradores devem acessar a sessão persistente e o .env.
& icacls.exe $DataDir /inheritance:r /grant:r "${serviceAccount}:(OI)(CI)M" 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' /T /C | Out-Null
& icacls.exe (Join-Path $InstallDir '.env') /inheritance:r /grant:r "${serviceAccount}:R" 'SYSTEM:F' 'Administrators:F' | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  if (-not $Force) { throw "O serviço $ServiceName já existe. Use -Force somente para substituí-lo de forma controlada." }
  if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
  & $NssmPath remove $ServiceName confirm | Out-Null
}

$entry = Join-Path $InstallDir 'src\index.js'
& $NssmPath install $ServiceName $node | Out-Null
& $NssmPath set $ServiceName AppParameters "`"$entry`"" | Out-Null
& $NssmPath set $ServiceName AppDirectory $InstallDir | Out-Null
& $NssmPath set $ServiceName DisplayName 'R2PHARMA WhatsApp Bridge' | Out-Null
& $NssmPath set $ServiceName Description 'Ponte persistente whatsapp-web.js da R2PHARMA.' | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName ObjectName $serviceAccount '' | Out-Null
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 10000 | Out-Null
& $NssmPath set $ServiceName AppStdout (Join-Path $DataDir 'logs\stdout.log') | Out-Null
& $NssmPath set $ServiceName AppStderr (Join-Path $DataDir 'logs\stderr.log') | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateOnline 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null

Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Format-Table Name, Status, StartType
Write-Host "Bridge instalada. Valide http://127.0.0.1:3002/healthz antes de configurar o IIS."
