<#
.SYNOPSIS
  Gera os instaladores e publica um Release no GitHub (com SHA256SUMS.txt).
  Requer: gh autenticado (gh auth login). A versão vem do package.json de packages/player.

  powershell -ExecutionPolicy Bypass -File tools\release.ps1
  powershell -ExecutionPolicy Bypass -File tools\release.ps1 -SkipBuild
#>
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$versao = (Get-Content packages\player\package.json -Raw | ConvertFrom-Json).version
$tag = "v$versao"

if (-not $SkipBuild) {
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'Testes falharam; release cancelado.' }
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw 'Build dos instaladores falhou.' }
}

$player = "release\player\ReprodutorPlayer-Setup-$versao.exe"
$painel = "release\painel\ReprodutorPainel-Setup-$versao.exe"
foreach ($f in @($player, $painel)) { if (-not (Test-Path $f)) { throw "Instalador ausente: $f" } }

$sums = 'release\SHA256SUMS.txt'
$linhas = foreach ($f in @($player, $painel)) { '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower(), (Split-Path $f -Leaf) }
Set-Content -Path $sums -Value $linhas -Encoding ascii

gh release create $tag $player $painel $sums --title "Reprodutor de Mídia $tag" --notes "Instaladores do Player e do Painel (Windows, sem assinatura digital: o SmartScreen pode avisar). Instalação por comando: veja o README."
