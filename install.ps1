<#
.SYNOPSIS
  Instala o Reprodutor Player ou o Reprodutor Painel a partir do último Release do GitHub.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App player
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App painel
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App player -Config C:\caminho\config.json

  -Config copia o config.json para a pasta de dados do Player (só para -App player).
  -Tag escolhe uma versão específica (padrão: a mais recente).
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('player', 'painel')][string]$App,
  [string]$Config = '',
  [string]$Tag = '',
  [string]$Repo = 'Lauxzera/reprodutor-de-midia'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue' # download bem mais rápido no PowerShell 5

$prefix = if ($App -eq 'player') { 'ReprodutorPlayer-Setup-' } else { 'ReprodutorPainel-Setup-' }
$nome = if ($App -eq 'player') { 'Reprodutor Player' } else { 'Reprodutor Painel' }

Write-Host "== Instalando $nome ($Repo) =="

$api = if ($Tag) { "https://api.github.com/repos/$Repo/releases/tags/$Tag" } else { "https://api.github.com/repos/$Repo/releases/latest" }
$release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'reprodutor-install' }
Write-Host "Versão: $($release.tag_name)"

$asset = $release.assets | Where-Object { $_.name -like "$prefix*.exe" } | Select-Object -First 1
if (-not $asset) { throw "O release $($release.tag_name) não tem o instalador '$prefix*.exe'." }
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1

$work = Join-Path ([IO.Path]::GetTempPath()) ('reprodutor-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $exe = Join-Path $work $asset.name
  Write-Host ("Baixando {0} ({1:N1} MB)..." -f $asset.name, ($asset.size / 1MB))
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing

  if ($sums) {
    $lista = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
    if ($lista -is [byte[]]) { $lista = [Text.Encoding]::UTF8.GetString($lista) }
    $linha = ($lista -split "`r?`n") | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
    if (-not $linha) { throw "SHA256SUMS.txt não lista $($asset.name)." }
    $esperado = ($linha -split '\s+')[0].ToLower()
    $real = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower()
    if ($real -ne $esperado) { throw "Hash SHA-256 diferente do publicado (download corrompido). Esperado $esperado, obtido $real." }
    Write-Host 'Hash SHA-256 conferido.'
  } else {
    Write-Warning 'O release não traz SHA256SUMS.txt; não foi possível conferir a integridade.'
  }

  if ($Config -and $App -eq 'player') {
    if (-not (Test-Path $Config)) { throw "Arquivo de configuração não encontrado: $Config" }
    $null = Get-Content $Config -Raw | ConvertFrom-Json # falha cedo se o JSON for inválido
  }

  # Fecha uma versão em execução para poder atualizar por cima.
  Get-Process -Name $nome -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1

  Write-Host 'Instalando (por usuário, sem administrador)...'
  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "O instalador terminou com código $($p.ExitCode)." }

  if ($Config -and $App -eq 'player') {
    $dados = Join-Path $env:APPDATA 'Reprodutor Player\data'
    New-Item -ItemType Directory -Force -Path $dados | Out-Null
    Copy-Item -Path $Config -Destination (Join-Path $dados 'config.json') -Force
    Write-Host "Configuração copiada para $dados\config.json"
    Get-Process -Name $nome -ErrorAction SilentlyContinue | Stop-Process -Force
    $inst = Join-Path $env:LOCALAPPDATA "Programs\reprodutor-player\$nome.exe"
    if (Test-Path $inst) { Start-Process -FilePath $inst }
  }
  Write-Host "Pronto: $nome $($release.tag_name) instalado."
  if ($App -eq 'player' -and -not $Config) {
    Write-Host 'Próximo passo: no player, Ctrl+Shift+M > Configurar conexão, ou rode de novo com -Config <config.json>.'
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
