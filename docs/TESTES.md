# Relatório de testes (fase 7)

Executado em 10/11/2026 em um PC Windows 11 de desenvolvimento, com um bucket local (`tools/dev-server.js`) no lugar do B2. **Nada foi testado em TV real, no PC da loja nem com o B2 de verdade.**

## Testes automatizados (`npm test`, 37 testes)

Cenários de falha em `packages/player/test/resilience.test.js`:

| Cenário | Resultado |
|---|---|
| Internet cai com o player rodando, o painel publica uma versão nova durante a queda, a internet volta (mesmo endereço) | segue tocando; atualiza sozinho ao reconectar |
| Energia cortada (processo encerrado à força) no meio do download de 4 MB | ao religar, retoma pelo `Range` do ponto em que parou, o hash confere, não sobra `.part` e o manifesto novo só é aplicado no fim |
| `manifest.json` vazio, truncado ou apagado (queda de energia) | recupera de `manifest.bak.json` e continua tocando offline |
| Mídia truncada no disco | detectada pelo tamanho, não toca e baixa de novo |
| Disco sem espaço (manifesto pede 10 TB) | não baixa, não troca o manifesto, mantém a programação atual |
| Bucket responde 500, 503, 404 ou 403 | status de erro, **continua tocando**; volta ao normal quando o bucket volta |
| Falhas de rede seguidas | contador sobe (base do aumento do intervalo de consulta) |

Mais os testes das fases anteriores (sincronização, agenda, publicação ponta a ponta, watchdog, senha).

## Testes no Electron (app real)

| Teste | Resultado |
|---|---|
| Vídeo MP4 H.264 1280x720 com áudio | toca (verificado: `currentTime` avançando, resolução 1280x720, mudo por padrão) |
| Abrir o player **sem internet** | toca do disco (status `offline — ECONNREFUSED`, 4 itens no disco, imagem na tela) |
| Fechar a janela (WM_CLOSE, o mesmo efeito do Alt+F4) em tela cheia | bloqueado; a janela continua aberta e o log registra a tentativa |
| Renderer travado de propósito (laço infinito) | o watchdog o recupera: **~60 s** até voltar a tocar (era ~100 s antes da correção abaixo) |
| Teste de longa duração: ~2,5 min com 4 trocas por ciclo, queda de internet de 30 s e republicação com remoção do vídeo | sem travamento nem acionamento do watchdog; offline detectado e recuperado; vídeo removido do disco após a republicação; memória do renderer oscilando entre 96 e 134 MB, **sem crescimento contínuo** |
| Instalador do Player e do Painel (instalação silenciosa por usuário) | instalou, abriu, criou atalho e entrada em Aplicativos instalados |
| Player instalado com a configuração padrão | registrou o início com o Windows |
| Desinstalação | removeu pastas, atalhos, entrada em Aplicativos e **o registro de início com o Windows**; os dados do usuário foram preservados |

## Problemas encontrados e corrigidos

1. **Watchdog lento com a tela travada de verdade:** a recarga normal não funciona com um laço infinito; levava ~100 s. Agora, se a recarga não concluir em 10 s, o renderer é derrubado à força e recarregado.
2. **Manifesto sem cópia de segurança:** um arquivo corrompido por queda de energia deixava o player sem nada, se estivesse offline. Agora existe `manifest.bak.json`.
3. **Pasta de instalação feia** (`@reprodutorplayer`, vinda do nome do pacote): agora `reprodutor-player` e `reprodutor-painel`.
4. **Início com o Windows ficava registrado após desinstalar:** o desinstalador passou a remover a entrada.
5. **Efeito colateral do meu teste anterior:** uma execução do app empacotado, sem `config.json`, registrou um início automático no seu Windows apontando para a pasta `release\player\win-unpacked`. Removi essa entrada. Também apaguei as pastas de dados de teste em `%APPDATA%` (`@reprodutor`, `Reprodutor Painel`, `Reprodutor Player`). Os instaladores foram desinstalados ao final.

## Limitações conhecidas

- **Corrupção silenciosa:** um arquivo de mídia com o tamanho certo e conteúdo alterado não é detectado depois de baixado (só o tamanho é conferido na abertura). Raro, mas possível após queda de energia em discos ruins.
- **Intervalo após queda longa:** o intervalo de consulta dobra a cada falha, até no máximo 5 minutos; após uma queda longa, a volta pode levar até esse tempo.
- **Teste de longa duração curto:** ~2,5 min. Horas de operação não foram testadas.
- **Fora do alcance desta sessão:** B2 real (envio de arquivos grandes, cotas, latência), TV/PC reais, vários players ao mesmo tempo, suspensão e hibernação do Windows, troca real de rede Wi-Fi/cabo/4G, relógio do PC errado, GPU fraca com vídeo em 4K.

## Roteiro para fazer no PC da loja

1. Instalar o player, configurar e deixar tocando por **8 a 24 h**; conferir `player.log` (sem `Watchdog`, sem erros repetidos) e se a imagem continua fluida.
2. **Tirar o cabo de rede** com o player tocando; esperar 10 min; religar; publicar uma mudança e ver se chega em até alguns minutos.
3. **Desligar o PC da tomada** durante uma sincronização grande; religar; o player deve voltar sozinho (com login automático) e concluir o download.
4. Levar o PC a **outra rede** (ou usar o 4G do celular como ponto de acesso) e confirmar a sincronização.
5. Testar os **vídeos reais** da loja (resolução, codec e tamanho) e conferir uso de CPU/GPU.
6. Confirmar o horário das **agendas** (relógio e fuso do Windows corretos).
7. Com o B2 de verdade: *Salvar e testar conexão*, publicar uma mídia grande, ver o consumo de cota.
