<#
  Ajustes de energia para o PC das TVs (rodar uma vez, no próprio PC das TVs):
   - nunca suspender nem desligar a tela quando ligado na tomada
   - desligar a hibernação
  Não altera atualizações do Windows nem o login automático (veja as instruções ao final).

  Uso: powershell -ExecutionPolicy Bypass -File tools\prepare-pc.ps1
  Reverter (exemplo): powercfg /change standby-timeout-ac 30 ; powercfg /change monitor-timeout-ac 15 ; powercfg /hibernate on
#>

powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off

Write-Host ''
Write-Host 'Energia ajustada: sem suspensão, sem apagar a tela, hibernação desligada.'
Write-Host ''
Write-Host 'Faça manualmente:'
Write-Host ' 1. Configurações > Windows Update > Opções avançadas > Horas ativas: cubra o horário de funcionamento da loja.'
Write-Host ' 2. Login automático: Win+R > netplwiz > desmarque "Os usuários devem digitar nome e senha".'
Write-Host ' 3. Desative notificações (Não incomodar) para não aparecerem balões sobre a TV.'
Write-Host ' 4. Em uso com notebook: Painel de Controle > Opções de energia > "Ao fechar a tampa" = Não fazer nada.'
