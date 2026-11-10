# Reprodutor de Mídia (Sinalização Digital) — Esboço do Projeto

## 1. Objetivo

Sistema de sinalização digital para as TVs da loja, com:

- **Gerenciamento remoto** de qualquer lugar, quando houver internet.
- **Reprodução 100% offline** a partir de mídias já baixadas no disco.
- **Portabilidade:** o PC pode ser levado a eventos e trocar de rede sem reconfiguração.
- **Custo zero e sem cartão de crédito** (Backblaze B2, plano gratuito).
- **Fase 2:** banco de dados (Supabase) para login, vários usuários e várias telas.

## 2. Arquitetura

```
┌──────────────────────┐        upload mídia + manifest        ┌─────────────────────┐
│  PAINEL (Electron)   │ ───────────────────────────────────▶  │  Backblaze B2       │
│  no PC de gestão     │      (chave de ESCRITA, só aqui)      │  bucket             │
└──────────────────────┘                                       │   media/<sha>.ext   │
                                                               │   screens/<id>.json │
┌──────────────────────┐   consulta manifest (ETag) a cada 60s │                     │
│  PLAYER (Electron)   │ ◀───────────────────────────────────  │  (leitura pública)  │
│  no PC das TVs       │   baixa só o que mudou                └─────────────────────┘
│                      │
│  disco local:        │   Sem internet: ignora a consulta e
│   media/ manifest    │   toca o que está no disco.
└──────────────────────┘
```

Princípio central: **o player nunca toca pela rede**. Ele só toca arquivos do disco local; a rede serve apenas para sincronizar.

## 3. Componentes

### 3.1 Player (Electron, Windows)
- Janela em tela cheia, sem borda, cursor oculto, sempre no topo.
- **Motor de reprodução:** imagens (`<img>`) e vídeos (`<video>`), com troca suave (crossfade), pré-carregamento do próximo item e ajuste `contain`/`cover`.
- **Protocolo `media://`** para servir arquivos do disco ao renderer com segurança.
- **Motor de sincronização** (processo principal): consulta o manifesto, compara, baixa, valida e limpa (seção 5).
- **Agendamento local:** decide o que tocar a partir do relógio do PC (dias, horários, datas de início/fim).
- **Robustez:** inicia com o Windows, instância única, reinicia se o renderer travar, watchdog, logs em arquivo, impede suspensão da tela.
- **Atalho de manutenção** (ex.: `Ctrl+Shift+Alt+Q` com senha) para sair, abrir logs e ver o status da sincronização.
- Guarda no disco: `manifest.json` ativo, pasta `media/`, `state.json` (último ETag e último sync) e `config.json` (ID da tela, URL do bucket).

### 3.2 Painel de gerenciamento (Electron, no seu PC)
- **Biblioteca:** envia arquivos, calcula o hash SHA-256, gera miniaturas e mostra o espaço usado.
- **Playlist:** arrasta para ordenar, define duração das imagens, repetição e agenda por item.
- **Publicar:** envia as mídias novas primeiro e o manifesto por último (seção 5).
- **Telas:** cadastra cada tela/player (nesta fase, 1 tela; já preparado para várias).
- **Configurações:** credenciais do B2 guardadas criptografadas (`safeStorage` do Electron).
- Funciona só no seu PC nesta fase (a chave de escrita nunca sai dele).

### 3.3 Backblaze B2
- Um bucket com leitura pública (o player não precisa de chave).
- Acesso pela **API compatível com S3** (`@aws-sdk/client-s3`).
- Chave de escrita (Application Key) restrita a esse bucket e usada só pelo painel.

## 4. Formato do manifesto

Arquivo `screens/<screenId>.json` no bucket. Mídias são nomeadas pelo hash, o que evita duplicatas e permite cache imutável.

```json
{
  "schemaVersion": 1,
  "screenId": "loja-principal",
  "revision": 42,
  "updatedAt": "2026-11-10T14:30:00Z",
  "settings": { "fit": "contain", "transitionMs": 600, "muted": true },
  "items": [
    {
      "id": "a1",
      "type": "image",
      "file": "media/9f2c...e1.jpg",
      "sha256": "9f2c...e1",
      "size": 482113,
      "name": "promo-verao.jpg",
      "durationSec": 10,
      "schedule": {
        "days": [1, 2, 3, 4, 5, 6],
        "start": "09:00",
        "end": "18:00",
        "from": "2026-11-01",
        "to": "2026-12-31"
      }
    },
    {
      "id": "b2",
      "type": "video",
      "file": "media/77ab...03.mp4",
      "sha256": "77ab...03",
      "size": 18233411,
      "name": "institucional.mp4"
    }
  ]
}
```

- Vídeos tocam até o fim; imagens usam `durationSec`.
- `schedule` é opcional; sem ele, o item toca sempre.
- `schemaVersion` permite evoluir o formato sem quebrar players antigos.

## 5. Fluxo de sincronização

1. A cada ~60 s, o player faz `GET` do manifesto com `If-None-Match` (ETag). Resposta `304` = nada mudou.
2. Se mudou, calcula a diferença entre o manifesto novo e os arquivos locais (por hash).
3. Baixa as mídias que faltam para `media/<sha>.ext.part`, confere o SHA-256 e só então renomeia para o nome final.
4. Com **tudo** baixado, troca `manifest.json` de forma atômica (grava `.tmp` e renomeia). O player recarrega a playlist no fim do item atual, sem corte.
5. Só depois remove do disco as mídias que não estão mais no manifesto.
6. Se qualquer passo falhar (sem rede, queda no meio do download), mantém o manifesto antigo e tenta de novo com espera crescente (backoff). **O que está tocando nunca é afetado.**

Regras de segurança do fluxo:
- Nunca tocar arquivo parcial.
- Nunca apagar antes de ter o substituto.
- Verificar espaço em disco antes de baixar; se faltar, não aplicar e registrar o erro.
- Download retomável (header `Range`) para vídeos grandes.

Publicação no painel segue a mesma lógica: **mídias primeiro, manifesto por último**, para o player nunca ver um manifesto que aponta para arquivo inexistente.

## 6. Segurança

- Chave de escrita do B2: apenas no painel, criptografada com `safeStorage`, nunca no player.
- Player: sem chaves; só a URL pública do bucket.
- Renderer com `contextIsolation`, `nodeIntegration` desligado e CSP restrita; acesso a arquivos só via `media://`.
- Mídias acessíveis por quem tiver o link: não usar conteúdo sigiloso.
- Validação do manifesto (schema) antes de aplicar; manifesto inválido é ignorado.

## 7. Operação do PC das TVs

- Login automático do Windows e início automático do player.
- Desativar suspensão, hibernação e desligamento de tela.
- Agendar atualizações do Windows fora do horário de uso.
- Fuso horário e relógio corretos (a agenda usa o relógio local).
- Antes de levar a eventos: confirmar no painel/player que a sincronização terminou.
- Conteúdo que depende de internet (páginas web, feeds, YouTube) fica fora do escopo; só mídia em arquivo.

## 8. Stack

- **Electron** + **Node.js** (TypeScript), Windows 10/11.
- **Interface** (painel): HTML/CSS + framework leve (React ou Svelte, a definir).
- **B2:** `@aws-sdk/client-s3` (endpoint S3 do B2).
- **Validação:** `zod` para o manifesto, compartilhado entre painel e player.
- **Empacotamento:** `electron-builder` (instalador `.exe`).
- **Logs:** `electron-log`.
- **Miniaturas/metadados** (painel): `sharp` (imagens) e `ffmpeg` (frames e duração de vídeos).

## 9. Estrutura do repositório

```
Reprodutor de Mídia/
├── PROJETO.md
├── packages/
│   ├── shared/        # schema do manifesto, tipos, utilitários de hash
│   ├── player/        # app Electron do PC das TVs
│   │   ├── src/main/      # sync, agenda, protocolo media://, watchdog
│   │   └── src/renderer/  # tela de reprodução
│   └── panel/         # app Electron de gerenciamento
│       ├── src/main/      # cliente B2, publicação, credenciais
│       └── src/renderer/  # biblioteca, playlist, publicar, telas
└── docs/
```

## 10. Fases de desenvolvimento

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0 | Conta B2, bucket e chaves | Upload/download manuais funcionando |
| 1 | `shared` + player MVP | Toca imagens e vídeos de um manifesto e uma pasta locais, em tela cheia e em loop |
| 2 | Sincronização no player | Alterar o manifesto no bucket atualiza o player; offline segue tocando |
| 3 | Robustez do player | Autostart, watchdog, logs, retomada de download, atalho de manutenção |
| 4 | Painel: biblioteca, playlist e publicar | Você sobe uma mídia no painel e ela aparece na TV |
| 5 | Agendamento por dia/horário/data | Itens aparecem e somem nos horários definidos |
| 6 | Instaladores e guia de instalação | `.exe` instala e configura o player e o painel em outro PC |
| 7 | Testes em campo | Desligar a rede, trocar de rede, cortar a energia no meio de um download e reiniciar; tudo se recupera |

## 11. Fase 2 — Banco de dados (Supabase)

Só depois da plataforma pronta. Nada do player offline muda; o Supabase entra no lado do gerenciamento:

- **Login e vários usuários** no painel (inclusive painel web acessível de qualquer navegador).
- **Várias telas/players** com agrupamento e permissões.
- **Status em tempo real:** cada player envia "batimento" (última sincronização, versão, espaço livre, item atual).
- **Histórico e auditoria** de publicações; reversão para versões anteriores.
- O B2 continua guardando as mídias; o manifesto passa a ser gerado a partir do banco.

## 12. Pré-requisitos (a cargo do usuário)

1. Criar conta no Backblaze B2.
2. Criar um bucket (leitura pública) e uma Application Key com escrita limitada a esse bucket.
3. Informar o nome do bucket, o endpoint S3 e a região (as chaves são digitadas por você no painel, nunca no chat).
4. Ter um PC Windows 10/11 para as TVs, com espaço livre em disco para as mídias.

## 13. Decisões em aberto e riscos

- **Cotas do plano gratuito do B2** (armazenamento, downloads diários e transações): validar no cadastro e dimensionar pelo número de telas.
- **Formatos de vídeo:** padronizar em H.264/MP4 para compatibilidade e aceleração por hardware; o painel pode avisar ou converter outros formatos.
- **Resolução e orientação** das TVs (horizontal/vertical): definir em `settings`.
- **Áudio:** vídeos mudos por padrão; confirmar se alguma mídia terá som.
- **Número de telas** no curto prazo: define quando antecipar o Supabase.
- **Framework do painel** (React ou Svelte): escolher no início da fase 4.
