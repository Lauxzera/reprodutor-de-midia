# Reprodutor de Mídia

Sinalização digital com **gerenciamento remoto** e **reprodução offline**. O painel publica no Backblaze B2; o player baixa as mídias para o disco e toca sempre a partir dele. Veja o desenho completo em [PROJETO.md](PROJETO.md).

Estado atual: fases 1 a 7 (player, sincronização, painel, agendamento, robustez, instaladores e testes de falha). Falta validar no PC e nas TVs da loja e com o B2 real (roteiro em [docs/TESTES.md](docs/TESTES.md)); depois, o Supabase. Para instalar nos PCs, veja o [guia de instalação](docs/INSTALACAO.md).

## Painel web

Gerencie de qualquer lugar, sem instalar nada: **https://lauxzera.github.io/reprodutor-de-midia/painel/** (guia em [docs/PAINEL-WEB.md](docs/PAINEL-WEB.md)). Os arquivos vão do navegador direto para o seu bucket do B2.

## Instalar por comando (cmd)

Instala a versão mais recente do [Release](https://github.com/Lauxzera/reprodutor-de-midia/releases/latest) (por usuário, sem administrador, com conferência SHA-256). No **PC das TVs**:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/Lauxzera/reprodutor-de-midia/main/install.ps1 -OutFile $env:TEMP\rm-install.ps1; & $env:TEMP\rm-install.ps1 -App player"
```

No **computador de gestão**, troque `-App player` por `-App painel`. Para já deixar o player ligado ao seu bucket, use o **código de pareamento** da aba Publicar do painel: acrescente `-Pair RM1-...`. A tela é escolhida sozinha se só houver uma publicada; senão, escolha na lista em `Ctrl+Shift+M` > *Configurar conexão*. (`-Config C:\caminho\config.json` continua valendo para quem já tem um `config.json` pronto; ele fica fora do repositório porque leva a chave de leitura.) `-Tag v0.1.0` fixa uma versão. Rodar de novo atualiza por cima, preservando os dados.

Para publicar uma versão nova: `powershell -ExecutionPolicy Bypass -File tools\release.ps1` (testa, gera os instaladores e cria o Release com `SHA256SUMS.txt`; precisa do `gh` autenticado e de `version` nova nos `package.json`).

## Atualizar pelo próprio app

A partir da versão 0.1.4, o Player e o Painel de mesa verificam sozinhos se há um Release novo no GitHub (ao abrir e a cada 6 h):

- **Player:** o botão ⚙ do canto inferior direito ganha um pontinho laranja e fica um pouco mais visível. Segure o botão por 1,5 s para abrir o painel e use **Atualizar para vX** (a barra mostra o download). O player baixa o instalador, confere o SHA-256 publicado no Release, fecha, instala e **reabre sozinho** (cerca de um minuto; a TV fica sem imagem nesse tempo). *Verificar atualizações* força a consulta.
- **Painel de mesa:** *Configurações* > **Atualizações**. O painel web já está sempre na versão mais recente.
- Sem internet, a verificação falha em silêncio e tenta de novo depois. Para desligar no Player: `"updates": false` no `config.json`.
- O instalador só é executado se o hash bater com o `SHA256SUMS.txt` do mesmo Release. Os instaladores não são assinados digitalmente, então a garantia é de integridade, não de autoria.
- A primeira instalação da 0.1.4 (e de qualquer versão anterior à 0.1.4) ainda é pelo comando de instalação; daí em diante, pelo app.

## Gerar os instaladores

```bash
npm install
npm run dist          # os dois; ou: npm run dist:player / npm run dist:panel
```

Saída em `release/player/ReprodutorPlayer-Setup-<versão>.exe` e `release/painel/ReprodutorPainel-Setup-<versão>.exe` (instalação por usuário, sem administrador; uns 120 MB cada, porque levam o Electron junto). `npm run pack:player` / `pack:panel` geram só a pasta `win-unpacked`, sem o instalador, útil para testar. O código é empacotado com esbuild (inclui `shared` e o SDK do B2), então o app instalado não depende de `node_modules`. Para trocar os ícones, substitua `packages/*/build/icon.png` (512x512) ou rode `npm run icons` para recriar os de exemplo.

## Requisitos

- Node.js 20+ e Windows 10/11 (o Electron é instalado pelo `npm install`).

```bash
npm install
npm test
```

## Testar sem conta no B2 (demonstração local)

```bash
node tools/seed-demo.js
npm run dev-server -- .dev/bucket 8080
```

Em outro terminal, crie `.dev/player-data/config.json`:

```json
{ "baseUrl": "http://localhost:8080", "screenId": "loja", "pollSeconds": 10 }
```

```bash
# PowerShell:  $env:PLAYER_DATA_DIR = "$PWD\.dev\player-data"; $env:PLAYER_WINDOWED = 1; npm run player
npm run player
npm run panel
```

No painel (dados de demo: `$env:PANEL_DATA_DIR = "$PWD\.dev\panel-data"`), mude a playlist, clique em **Publicar** e o player atualiza em até 10 s. Pare o `dev-server` e o player continua tocando do disco.

## Uso real (Backblaze B2)

Passo a passo e verificação com as suas credenciais: [docs/B2.md](docs/B2.md) (`npm run b2-check`).

1. Crie uma conta no B2, um **bucket privado** (sem cartão; o público exige cartão ou US$ 1) e duas **Application Keys** restritas a ele: leitura e gravação (só no painel) e **somente leitura** (para o player, que assina as leituras com SigV4).
2. **Painel** (`npm run panel`): em *Configurações*, informe endpoint S3, bucket e chaves e use *Salvar e testar conexão*.
3. Em *Biblioteca* adicione arquivos, monte a *Playlist* (arraste para ordenar, defina duração e *Agenda* por item) e clique em *Publicar*.
4. **Player** (PC das TVs): pressione `Ctrl+Shift+M`, escolha *Configurar conexão*, cole o **código de pareamento** da aba *Publicar* e escolha a tela na lista (ele grava o `config.json` e reinicia). Antes, informe a chave de leitura do player em *Configurações* do painel. A pasta de dados é `%APPDATA%\Reprodutor Player\data` no app instalado; `PLAYER_DATA_DIR` escolhe outra.

### Atalhos do player

| Atalho | Ação |
|---|---|
| `Ctrl+Shift+D` | mostra/oculta o painel de status (revisão, sincronização, itens no disco) |
| `Ctrl+Shift+M` | painel inicial (sem senha): sincronizar agora, configurar conexão, minimizar, configurações do Windows, abrir pasta de dados, reiniciar, sair, ver o log |
| botão ⚙ no canto inferior direito | sempre presente, com 10% de opacidade (quase invisível sobre o vídeo); fica nítido ao passar o mouse; volta ao painel inicial |
| `Ctrl+Shift+Q` | encerra o player, **só em modo janela** (`PLAYER_WINDOWED=1`, para desenvolvimento) |

**Sem senha:** o painel do player abre direto, sem login (quem tem acesso ao teclado/toque do PC pode mexer; o acesso físico já é a proteção). Em tela cheia, Alt+F4 não fecha o player. **Minimizar** (menu de manutenção) esconde a janela para você usar o Windows; ela volta sozinha à tela cheia em 10 min, ou antes se você clicar no ícone na barra de tarefas. *Configurações do Windows* minimiza e abre o aplicativo Configurações.

Variáveis úteis: `PLAYER_DATA_DIR`, `PLAYER_WINDOWED=1`, `PLAYER_DEBUG=1`.

### Robustez (fase 3)

- **Watchdog:** o player envia batimentos a cada 5 s. Sem batimento por 60 s, ou com um item além do prazo (tempo de tela + folga), a tela é recarregada. Mais de 3 recargas em 10 min reiniciam o app inteiro. Renderer que cai ou trava também é recarregado.
- **Log:** `player.log` na pasta de dados (rotação em 1 MB). Registra início, mudanças de estado da sincronização (online/offline/erro), falhas, ações de manutenção e tentativas de acesso.
- **Início com o Windows:** o app instalado se registra sozinho (`"autoStart": true` no `config.json`). Rodando pelo npm, use `powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1` (cria um atalho em Inicializar; `-Remove` desfaz).
- **Energia:** `tools\prepare-pc.ps1`, rodado uma vez no PC das TVs, desliga suspensão, apagar tela e hibernação, e lista o que fazer à mão (horas ativas do Windows Update, login automático). O player também impede a tela de apagar enquanto roda.

## Como o offline funciona

- O player nunca toca pela rede: só arquivos de `media/` na pasta de dados.
- A cada `pollSeconds` ele consulta `screens/<id>.json` com ETag. Havendo mudança, baixa o que falta (com retomada), confere o SHA-256, troca o `manifest.json` de forma atômica e só então apaga o que saiu.
- Sem internet, a consulta falha em silêncio e segue a última programação. Ao reiniciar sem rede, recarrega o manifesto do disco.
- O painel envia as mídias primeiro e o manifesto por último.

## Estrutura

```
packages/shared   schema do manifesto, validação, regras de agenda, hash
packages/player   app Electron das TVs (sync.js = motor de sincronização)
packages/panel    app Electron de gerenciamento (storage.js = B2/pasta, publish.js)
tools/            dev-server (bucket local), demo, build (esbuild), ícones, scripts .ps1
docs/             guia de instalação e relatório de testes
release/          instaladores gerados (não versionar)
```

## Decisões que diferem do esboço

- Mídia tocada via `file://` (sem protocolo `media://` próprio) e CSP restrita.
- Painel em JavaScript puro, sem framework; miniaturas usam o próprio arquivo (sem `sharp`/`ffmpeg`).
- O painel guarda uma cópia local de cada arquivo da biblioteca (ocupa disco no PC de gestão).

## Limitações conhecidas

- **Vídeos em HEVC (H.265), padrão do iPhone, não tocam no Player:** o som anda, mas não há imagem. O **painel web converte sozinho** esses vídeos para H.264/MP4 ao enviar (1080p, 30 fps, no próprio navegador; precisa de Chrome/Edge que decodifique HEVC, o que depende do computador: no Windows, pela extensão HEVC da Microsoft ou por GPU compatível). Se o navegador não decodificar, ele recusa e explica; o Player, por sua vez, pula o item sem imagem e registra no `player.log`. Nesse caso converta para **H.264 em MP4** antes (HandBrake, ou `ffmpeg -i entrada.mov -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart saida.mp4`). Vídeos verticais aparecem com faixas pretas numa TV na horizontal.

- O fluxo completo foi verificado no B2 real com bucket privado (`npm run b2-check`: ETag/304, Range, 25 MB, sincronização); a chave de leitura separada e o uso com vários players ainda não foram exercitados. Vídeo MP4 foi testado no player. Horas de operação e a troca real de rede ficam para o roteiro em [docs/TESTES.md](docs/TESTES.md).
- Mídias órfãs no bucket (removidas da playlist) não são apagadas; a limpeza do bucket ainda não existe.
- Os instaladores foram instalados, executados e desinstalados no PC de desenvolvimento (ver [docs/TESTES.md](docs/TESTES.md)).
- Os instaladores não são assinados: o Windows SmartScreen avisa na primeira execução.
- Não há atualização automática: para atualizar, instale a versão nova por cima (dados preservados).
- O B2 gratuito tem cotas de armazenamento e de download; confira no site.

**Painel inicial (v0.1.5):** o Player abre mostrando o painel com a conexão com o admin, a última sincronização, a versão, as mídias baixadas (com aviso das que não tocam, como HEVC) e os botões *Iniciar reprodução*, *Atualizar* (com barra de download), *Exibição* (ajuste da imagem, rotação, volume), *Conexão com o admin*, *Minimizar* e *Configurações do Windows*. Sem ninguém mexer, a reprodução começa sozinha em 60 s. Durante a reprodução, o botão ⚙ do canto inferior direito volta a este painel.

**Ligar uma TV com menos passos:** na aba Publicar do admin, *Copiar comando de instalação* gera uma linha para colar no cmd do PC da TV (instala, conecta e escolhe a tela sozinho). Para um Player já instalado, *Baixar pair.txt* e colocar o arquivo num pendrive, em Downloads ou no Desktop antes de abrir o Player (ele se pareia sozinho se ainda não tiver conexão), ou copiar o código e usar *Colar código copiado* em Conexão com o admin. O `pair.txt` leva a chave de leitura: apague-o depois e não o envie a ninguém.

**Painel para toque e mouse (v0.1.6):** botões grandes com descrição, rolagem por toque, foco visível para teclado e layout que se adapta a telas pequenas. A barra do topo tem **Minimizar** e **Janela / Tela cheia**: *Janela* tira o player da tela cheia (janela de 1200×780 que você move e redimensiona) e *Tela cheia* volta ao modo da TV. Em janela, sem usar o painel por 30 min, ele volta sozinho à tela cheia.

**Monitoramento das telas (v0.1.8):** a aba *Monitoramento* do admin lista cada tela, se o player está online (relatou nos últimos 5 min), qual versão usa, a revisão da programação, se está em dia com o que foi publicado e o que está tocando. O player grava `status/<tela>.json` a cada 2 minutos com uma **chave do B2 que só escreve em `status/`** (Write Only, prefixo `status/`), informada em *Configurações* do admin e levada dentro do código de pareamento. A gravação é operação de upload do B2 (sem custo) e o arquivo tem ~1 KB. Sem a chave, o player funciona igual e aparece como "Sem relatório".

**Totem touch, sem mouse e sem teclado (v0.1.9):** tudo no painel do Player funciona só com o toque.
- **Abrir:** segure o ⚙ do canto inferior direito por 1,5 s (um anel mostra o andamento; um toque curto só exibe a dica). Isso evita que alguém abra as configurações sem querer. Sem conteúdo na tela, aparece o botão grande **Abrir painel**. O atalho `Ctrl+Shift+M` continua existindo.
- **Sair:** **Iniciar reprodução** (ou **Voltar** nas telas de ajuste). Parado por 3 minutos em qualquer tela, o painel fecha sozinho e a reprodução volta.
- **Digitar:** ao tocar num campo aparece o **teclado na tela** do próprio Player (letras, números e símbolos, setas, Limpar e Colar). Ele não depende do teclado do Windows.
- **Parear sem digitar:** em *Conexão com o admin*, **Procurar pair.txt** acha o arquivo no pendrive (raiz), em Downloads ou na Área de Trabalho. As telas aparecem como botões; ajuste da imagem, rotação e volume também.
- **Fechar o Player:** botão **Fechar o Player** na barra do painel (com confirmação). Em **Janela** (sem a barra do Windows) o Player mostra a sua própria barra no topo com Minimizar, Tela cheia e Fechar. Minimizado ou em janela, também fecha pela barra de tarefas do Windows; só a **tela cheia** da TV continua protegida contra Alt+F4.
- **Mídias e downloads (v0.1.11):** o quadro **Mídias e downloads** do painel mostra cada mídia da programação com estado (No disco, Baixando, Na fila, Pausada, Falhou), tamanho e **porcentagem** ao vivo. **Baixar já** interrompe a que está baixando e começa por essa (a interrompida retoma depois, de onde parou); ▲ ▼ mudam a ordem da fila; **Pausar/Retomar** (por mídia ou **Pausar tudo**); e, para o que já está no disco, **Baixar de novo** e **Remover do disco** (a removida fica pausada e não volta sozinha). A ordem e as pausas ficam gravadas e valem depois de reiniciar. Uma mídia pausada não impede a programação nova de entrar: o Player toca só o que estiver no disco.
- **Playlist e nomes (v0.1.12):** no painel do Player, **Playlist e nomes** mostra a ordem de reprodução com miniatura. Dá para **mover** (▲ ▼, início, fim), **renomear** (com o teclado na tela), **ocultar/mostrar** e ajustar o **tempo na tela** das imagens (−5 −1 +1 +5). Vale só naquele Player (fica no `state.json`; o manifesto e o admin não mudam, então builds antigas seguem compatíveis). Mídias novas do admin entram no fim; **Voltar ao do admin** desfaz uma mídia e **Restaurar tudo do admin** desfaz tudo.
- **Reprodução mais fluida (v0.1.13):** o Player pré-carrega e decodifica o próximo vídeo/imagem enquanto o atual toca (troca sem engasgo) e força a decodificação de vídeo pela GPU, mesmo em placas antigas bloqueadas por precaução pelo Chromium. Nenhum arquivo é recomprimido, então a qualidade é a mesma. O log do Player registra a GPU e se a decodificação é por hardware.
- **Confirmações** (reiniciar, sair, atualizar) são diálogos grandes do painel. Pinça (zoom) e deslizar nas bordas ficam desligados, e o toque longo não abre menu do navegador.

**Compatibilidade entre versões:** uma build nova nunca deve deixar uma antiga sem funcionar. As regras são: o manifesto continua em `schemaVersion: 1` e só ganha campos **novos e opcionais** (as versões antigas os ignoram); as chaves do bucket (`screens/<id>.json`, `media/<sha256>.<ext>`) não mudam; o código de pareamento só ganha campos opcionais; objetos novos (como `status/`) são apenas acrescentados. O teste `packages/shared/test/compat.test.js` guarda cópias congeladas do validador da 0.1.0 e do decodificador da 0.1.2 e confere que o que o admin atual publica continua aceito por elas. Também foi conferido com o Player real das versões 0.1.0, 0.1.1 e 0.1.2 sincronizando uma playlist publicada pelo admin atual.
