# Guia de instalação

São dois programas:

| Programa | Onde instalar | Para quê |
|---|---|---|
| **Reprodutor Painel** | no seu computador de gestão | enviar mídias, montar playlists, agendar e publicar |
| **Reprodutor Player** | no PC ligado às TVs | baixar as mídias e tocá-las, mesmo sem internet |

Instalação por comando no cmd (a partir do Release do GitHub): veja o README, seção "Instalar por comando". Os instaladores também ficam em `release/painel/` e `release/player/` depois de rodar `npm run dist`.

## 1. Backblaze B2 (uma vez)

1. Crie uma conta no Backblaze B2 e um **bucket privado** (o público exige cartão ou US$ 1). O player lê com uma chave somente de leitura; detalhes em [B2.md](B2.md).
2. Em *Application Keys*, crie duas chaves **restritas a esse bucket**: uma de leitura e escrita (só no painel) e uma **somente leitura** (para o player). Anote o *keyID* e a *applicationKey* de cada uma (ela só aparece uma vez).
3. Anote o **endpoint S3** do bucket (algo como `https://s3.us-west-004.backblazeb2.com`) e o nome do bucket.

Digite as credenciais somente no painel. Elas ficam criptografadas naquele computador e nunca vão para o player.

## 2. Painel (computador de gestão)

1. Execute `ReprodutorPainel-Setup-<versão>.exe`. A instalação é por usuário, sem pedir administrador.
2. Abra o painel, vá em **Configurações**, escolha *Backblaze B2*, preencha endpoint, bucket, keyID e applicationKey e clique em **Salvar e testar conexão**. Deve aparecer "Conexão OK".
3. Em **Biblioteca** adicione imagens e vídeos. Prefira vídeos MP4 (H.264).
4. Em **Playlist** monte a ordem, defina o tempo de cada imagem e, se quiser, a **Agenda** de cada item.
5. Em **Publicar**, clique em *Publicar agora*. Em **Configurações**, informe a chave de leitura do player: a aba Publicar passa a mostrar o **código de pareamento** (`RM1-...`), que leva o bucket e a chave de leitura para o player.

## 3. Player (PC das TVs)

1. Execute `ReprodutorPlayer-Setup-<versão>.exe`. O player abre em tela cheia.
2. Na tela "Player não configurado", pressione **Ctrl+Shift+M**. Na primeira vez ele pede para **definir a senha de manutenção**. Guarde essa senha.
3. No menu de manutenção, clique em **Configurar conexão**, cole o **código de pareamento** copiado do painel, escolha a tela na lista e clique em **Salvar e reiniciar**. (Atalho: instalar com `install.ps1 -App player -Pair <código>` já grava a configuração; a tela é escolhida sozinha se só houver uma publicada.)
4. O player baixa as mídias e começa a tocar. Para conferir: **Ctrl+Shift+D** mostra revisão, itens no disco e estado da sincronização.
5. Para o PC ligar sozinho tocando, faça uma vez:
   - rode `tools\prepare-pc.ps1` (desliga suspensão, apagar a tela e hibernação);
   - ative o login automático do Windows (`Win+R` > `netplwiz`);
   - ajuste as *Horas ativas* do Windows Update para cobrir o horário da loja.

Para mexer no Windows com o player em tela cheia: passe o mouse no **canto superior direito**, clique no botão ⚙, digite a senha de manutenção e escolha **Minimizar o player** ou **Configurações do Windows**. O player volta sozinho à tela cheia em 10 minutos.

O player se registra para abrir no login do Windows (`"autoStart": true` no `config.json`). Não é necessário o `install-autostart.ps1`, que é só para rodar pelo código-fonte.

## 4. Antes de levar o PC a um evento

1. Publique as alterações no painel.
2. No player, abra o menu (Ctrl+Shift+M) e use **Sincronizar agora**; confirme em Ctrl+Shift+D que "itens no disco" é igual ao total.
3. Pode desligar a internet: o player continua com o que baixou. Ao conectar em outra rede, ele volta a sincronizar sozinho.

Não depende de internet: imagens e vídeos publicados. Depende: qualquer conteúdo de páginas web, feeds ou streaming (não suportados).

## 5. Atualizar e desinstalar

- **Atualizar:** instale a versão nova por cima. Configuração, senha e mídias ficam preservadas.
- **Desinstalar:** pelo "Aplicativos instalados" do Windows. Os dados (mídias, senha, configuração) **não** são apagados; para limpar tudo, apague também as pastas abaixo.

| App | Pasta de dados |
|---|---|
| Player | `%APPDATA%\Reprodutor Player\data` |
| Painel | `%APPDATA%\Reprodutor Painel\data` |

## 6. Problemas comuns

| Sintoma | O que verificar |
|---|---|
| "Conexão falhou" no teste do painel | endpoint e região corretos; chave com acesso a esse bucket; bucket e nome digitados sem espaços |
| Player diz "Manifesto não encontrado" | falta clicar em *Publicar* no painel, ou o ID da tela difere do cadastrado |
| Player não baixa nada | a URL do bucket deve ser pública e abrir no navegador; confira em Ctrl+Shift+D |
| Imagem aparece mas o vídeo não | converta para MP4 H.264 |
| Esqueci a senha de manutenção | no PC do player, apague `security.json` na pasta de dados e abra o menu de novo para definir outra |
| Quero ver o que aconteceu | menu de manutenção mostra o fim do log; o arquivo completo é `player.log` na pasta de dados |

## 7. Aviso do Windows ("editor desconhecido")

Os instaladores não são assinados digitalmente, então o Windows SmartScreen pode avisar na primeira execução. Clique em *Mais informações > Executar assim mesmo*. Assinar o instalador exige um certificado de código pago e não faz parte deste projeto.
