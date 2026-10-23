[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$ServiceName = 'R2PHARMA-WhatsAppBridge',
  [string]$NssmPath = 'C:\Tools\nssm\nssm.exe'
)

$ErrorActionPreference = 'Stop'
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Write-Host "Serviço $ServiceName não encontrado."
  exit 0
}

if ($PSCmdlet.ShouldProcess($ServiceName, 'parar e remover serviço Windows')) {
  if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
  & $NssmPath remove $ServiceName confirm | Out-Null
  Write-Host "Serviço $ServiceName removido. O diretório de dados não foi apagado."
}
