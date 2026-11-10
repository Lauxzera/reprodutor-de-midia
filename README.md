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
4. **Player** (PC das TVs): pressione `Ctrl+Shift+M`, defina a senha, escolha *Configurar conexão*, cole o **código de pareamento** da aba *Publicar* e escolha a tela na lista (ele grava o `config.json` e reinicia). Antes, informe a chave de leitura do player em *Configurações* do painel. A pasta de dados é `%APPDATA%\Reprodutor Player\data` no app instalado; `PLAYER_DATA_DIR` escolhe outra.

### Atalhos do player

| Atalho | Ação |
|---|---|
| `Ctrl+Shift+D` | mostra/oculta o painel de status (revisão, sincronização, itens no disco) |
| `Ctrl+Shift+M` | menu de manutenção (pede senha): sincronizar agora, configurar conexão, minimizar, configurações do Windows, abrir pasta de dados, reiniciar, sair, ver o log |
| botão ⚙ no canto superior direito | sempre presente, com 10% de opacidade (quase invisível sobre o vídeo); fica nítido ao passar o mouse; abre o mesmo menu de manutenção |
| `Ctrl+Shift+Q` | encerra o player, **só em modo janela** (`PLAYER_WINDOWED=1`, para desenvolvimento) |

**Senha de manutenção:** no primeiro `Ctrl+Shift+M` o player pede para definir a senha; faça isso na instalação. Ela fica como hash em `security.json` na pasta de dados (apagar esse arquivo no PC redefine a senha). Após 5 erros, bloqueia por 30 s. Em tela cheia, Alt+F4 não fecha o player. **Minimizar** (menu de manutenção) esconde a janela para você usar o Windows; ela volta sozinha à tela cheia em 10 min, ou antes se você clicar no ícone na barra de tarefas. *Configurações do Windows* minimiza e abre o aplicativo Configurações.

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

- **Vídeos em HEVC (H.265), padrão do iPhone, não tocam no Player:** o som anda, mas não há imagem. O painel web recusa esses arquivos ao enviar e avisa; o Player pula o item e registra no `player.log`. Converta para **H.264 em MP4** antes (HandBrake, ou `ffmpeg -i entrada.mov -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart saida.mp4`). Vídeos verticais aparecem com faixas pretas numa TV na horizontal.

- O fluxo completo foi verificado no B2 real com bucket privado (`npm run b2-check`: ETag/304, Range, 25 MB, sincronização); a chave de leitura separada e o uso com vários players ainda não foram exercitados. Vídeo MP4 foi testado no player. Horas de operação e a troca real de rede ficam para o roteiro em [docs/TESTES.md](docs/TESTES.md).
- Mídias órfãs no bucket (removidas da playlist) não são apagadas; a limpeza do bucket ainda não existe.
- Os instaladores foram instalados, executados e desinstalados no PC de desenvolvimento (ver [docs/TESTES.md](docs/TESTES.md)).
- Os instaladores não são assinados: o Windows SmartScreen avisa na primeira execução.
- Não há atualização automática: para atualizar, instale a versão nova por cima (dados preservados).
- O B2 gratuito tem cotas de armazenamento e de download; confira no site.
