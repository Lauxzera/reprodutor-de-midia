<#
.SYNOPSIS
  Instala o Reprodutor Player ou o Reprodutor Painel a partir do último Release do GitHub.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App player
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App painel
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App player -Config C:\caminho\config.json

  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -App player -Pair RM1-...

  -Pair instala o Player já pareado com o bucket, usando o código de pareamento do painel (aba Publicar).
        A tela é escolhida sozinha se só houver uma publicada; senão, no menu do Player (Ctrl+Shift+M).
  -Config copia um config.json pronto para a pasta de dados do Player (só para -App player).
  -Tag escolhe uma versão específica (padrão: a mais recente).
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('player', 'painel')][string]$App,
  [string]$Config = '',
  [string]$Pair = '',
  [string]$Tag = '',
  [string]$Repo = 'Lauxzera/reprodutor-de-midia'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue' # download bem mais rápido no PowerShell 5

# Decodifica o código de pareamento (RM1-<base64url>.<adler32>) gerado pelo painel.
function ConvertFrom-PairCode([string]$Code) {
  $t = ($Code -replace '\s', '')
  if (-not $t.StartsWith('RM1-')) { throw 'Código de pareamento inválido (deve começar com RM1-).' }
  $dot = $t.LastIndexOf('.')
  if ($dot -lt 0) { throw 'Código de pareamento incompleto; copie de novo.' }
  $payload = $t.Substring(4, $dot - 4)
  $a = 1; $b = 0
  foreach ($x in [Text.Encoding]::ASCII.GetBytes($payload)) { $a = ($a + $x) % 65521; $b = ($b + $a) % 65521 }
  $sum = '{0:x8}' -f ([uint32]($b * 65536 + $a))
  if ($sum -ne $t.Substring($dot + 1).ToLower()) { throw 'Código de pareamento corrompido ou cortado; copie de novo.' }
  $s = $payload.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  $o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) | ConvertFrom-Json
  if ($o.v -ne 1 -or -not $o.e -or -not $o.b) { throw 'Versão de código de pareamento não suportada.' }
  $hostName = ([uri]$o.e).Host
  $privado = [bool]($o.k -and $o.s)
  $base = if ($o.u) { ([string]$o.u).TrimEnd('/') } elseif ($privado) { "https://$hostName/$($o.b)" } else { "https://$($o.b).$hostName" }
  $region = if ($o.e -match 's3\.([a-z0-9-]+)\.backblazeb2\.com') { $Matches[1] } else { '' }
  $cfg = [ordered]@{ baseUrl = $base; screenId = ''; pollSeconds = $(if ($o.p -ge 5) { [int]$o.p } else { 120 }); autoStart = $true }
  if ($privado) { $cfg.keyId = $o.k; $cfg.secretKey = $o.s; $cfg.region = $region }
  return $cfg
}

$prefix = if ($App -eq 'player') { 'ReprodutorPlayer-Setup-' } else { 'ReprodutorPainel-Setup-' }
$nome = if ($App -eq 'player') { 'Reprodutor Player' } else { 'Reprodutor Painel' }

if ($Pair -and $App -ne 'player') { throw '-Pair só vale para -App player.' }
if ($Pair -and $Config) { throw 'Use -Pair ou -Config, não os dois.' }
$pairCfg = $null
if ($Pair) { $pairCfg = ConvertFrom-PairCode $Pair; Write-Host 'Código de pareamento válido.' }

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

  if ($pairCfg) {
    $dados = Join-Path $env:APPDATA 'Reprodutor Player\data'
    New-Item -ItemType Directory -Force -Path $dados | Out-Null
    [IO.File]::WriteAllText((Join-Path $dados 'config.json'), ($pairCfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-Host "Player pareado com o bucket (configuração em $dados\config.json)."
    Get-Process -Name $nome -ErrorAction SilentlyContinue | Stop-Process -Force
    $inst = Join-Path $env:LOCALAPPDATA "Programs\reprodutor-player\$nome.exe"
    if (Test-Path $inst) { Start-Process -FilePath $inst }
  }
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
  if ($pairCfg) {
    Write-Host 'A tela é escolhida sozinha se só houver uma publicada; senão, Ctrl+Shift+M > Configurar conexão no player. Defina a senha de manutenção no primeiro Ctrl+Shift+M.'
  } elseif ($App -eq 'player' -and -not $Config) {
    Write-Host 'Próximo passo: no player, Ctrl+Shift+M > Configurar conexão e cole o código de pareamento do painel (ou rode de novo com -Pair <código>).'
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
