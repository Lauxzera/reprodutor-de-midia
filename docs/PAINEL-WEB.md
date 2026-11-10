# Painel web

Versão do painel que roda no navegador, de qualquer lugar: **https://lauxzera.github.io/reprodutor-de-midia/painel/**. É a mesma interface do app de mesa (Biblioteca, Playlist, Publicar, Telas, Configurações). Os arquivos vão direto do navegador para o seu bucket no B2; não existe servidor intermediário e nada disso gera custo.

## Como funciona

- O site é estático (GitHub Pages). Ele **não tem nenhuma credencial**: qualquer pessoa pode abrir a página, mas sem as chaves do B2 não faz nada.
- No primeiro acesso você informa endpoint, bucket e a chave de **leitura e escrita**, mais uma **senha deste navegador**. As chaves ficam no `localStorage` criptografadas com essa senha (PBKDF2 + AES-GCM). Nos acessos seguintes só a senha é pedida.
- A biblioteca e as playlists ficam no próprio bucket, em `admin/library.json` e `admin/project.json`, então valem em qualquer navegador. Mídias em `media/<hash>.<ext>`, programação em `screens/<tela>.json` (igual ao app de mesa).
- O app de mesa (Electron) guarda o estado localmente e **não** lê o `admin/` do bucket: use um ou outro para montar a playlist da mesma tela, não os dois.

## Configuração única do bucket (CORS)

O navegador só consegue falar com o B2 se o bucket permitir a origem do site. Já foi feito para `https://lauxzera.github.io`. Para repetir ou acrescentar outra origem:

```powershell
$env:B2_BUCKET = "nome-do-bucket"
$env:B2_KEY_ID = Read-Host "keyID"
$env:B2_APP_KEY = Read-Host "applicationKey"
node tools\b2-cors.js https://lauxzera.github.io
```

A chave precisa da permissão de escrever no bucket (a de leitura e escrita criada pelo guia do B2 já tem). O script só mexe na regra `painel-web`. `npm run web-check` (mesmas variáveis, mais `B2_ENDPOINT` e `WEB_ORIGIN`) confere o cliente S3 do painel web e o CORS contra o B2 real.

## Parear o Player (código de pareamento)

1. Em **Configurações**, marque *Bucket privado* e informe a **chave de leitura do player** (a chave Read Only do B2). Ela fica criptografada junto com as outras.
2. Na aba **Publicar**, o painel mostra o **código de pareamento** (`RM1-...`): endpoint, bucket, chave de leitura e intervalo, num texto só.
3. No PC das TVs: instale já pareado com `install.ps1 -App player -Pair RM1-...` (veja o README), ou no player use `Ctrl+Shift+M` > *Configurar conexão*, cole o código e escolha a tela na lista.

O código leva a chave de leitura: trate como senha. A chave de gravação nunca entra nele.

## Usar

1. Abra o endereço acima e conecte o bucket (primeiro acesso).
2. **Biblioteca**: arraste imagens e vídeos ou use *Adicionar arquivos*. Cada arquivo é conferido por hash e enviado ao B2 (vídeos grandes demoram conforme a sua internet de envio).
3. **Playlist**: monte a ordem, tempo de cada imagem e agenda. **Publicar**: gera o `screens/<tela>.json`; o player atualiza sozinho.
4. **Configurações > Limpar mídias órfãs**: apaga do bucket as mídias que não estão na biblioteca nem em nenhuma tela publicada (libera cota).

`?demo` no endereço abre o painel com dados só em memória, sem conectar a nada.

## Cuidados

- A senha do navegador **não é recuperável**. Se esquecer, use "Esquecer as chaves deste navegador" e informe as chaves de novo.
- Não use um computador público ou alheio: a chave de escrita ficaria acessível a quem usar aquele navegador depois, se ele ficar desbloqueado. Use *Sair (bloquear)* ao terminar.
- Cada acesso ao painel consulta o bucket (leituras e gravações contam na cota diária gratuita do B2, pequena para uso normal).
- Para publicar uma versão nova do painel web: `npm run build:web` e envie `docs/painel/` para o GitHub (o Pages republica sozinho).
