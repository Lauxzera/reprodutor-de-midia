<#
  Faz o player abrir sozinho quando o Windows iniciar (atalho na pasta Inicializar do usuário atual).
  Para o app instalado (.exe, fase 6) isso não é necessário: o próprio player se registra.

  Instalar:  powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
  Remover:   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove
  Dados em outra pasta: ... -DataDir "D:\player-data"
#>
param(
  [switch]$Remove,
  [string]$DataDir = ''
)

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'Reprodutor de Midia - Player.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Force; Write-Host "Atalho removido: $link" }
  else { Write-Host 'Nenhum atalho para remover.' }
  return
}

$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron não encontrado em $electron. Rode 'npm install' primeiro." }

$args = '"' + (Join-Path $repo 'packages\player') + '"'
if ($DataDir) { $args += ' "--data-dir=' + $DataDir + '"' }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $electron
$sc.Arguments = $args
$sc.WorkingDirectory = $repo
$sc.WindowStyle = 7  # minimizada
$sc.Description = 'Reprodutor de Midia - Player'
$sc.Save()
Write-Host "Atalho criado: $link"
Write-Host 'O player abrirá no próximo login. Para o PC logar sozinho, configure o login automático do Windows (netplwiz).'
