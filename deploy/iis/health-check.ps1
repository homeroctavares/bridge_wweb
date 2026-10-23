[CmdletBinding()]
param(
  [string]$PublicUrl = 'https://whatsapp-bridge.r2pharma.com',
  [int]$LocalPort = 3002
)

$ErrorActionPreference = 'Stop'

$tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -WarningAction SilentlyContinue
if (-not $tcp.TcpTestSucceeded) { throw "A porta local $LocalPort não está aceitando conexões." }

$local = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/healthz" -Method Get
if ($local.status -ne 'ok') { throw 'Health local não retornou status ok.' }

$public = Invoke-RestMethod -Uri ($PublicUrl.TrimEnd('/') + '/healthz') -Method Get
if ($public.status -ne 'ok') { throw 'Health HTTPS não retornou status ok.' }

[pscustomobject]@{
  local_port = $LocalPort
  local_status = $local.status
  public_url = $PublicUrl
  public_status = $public.status
}
