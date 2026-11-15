# DK: chave de dados por pessoa para a senha do SIGAA (desenho)

Status: **implementada** em `feat/dk-cofre` (cofre, `GET /connections/sigaa/key`, `POST /connections/sigaa/unlock`). Decidido com o André: opção A (o servidor abre a DK com a K da sessão e a entrega ao navegador) e **sem convivência com o formato antigo** (cópias antigas pedem reautorização; sem conversão automática nem coluna `kind`). Autor: agente da API (Alicerce), 15/11/2026. Depende de
[`2026-11-14-chave-mestra-passkey.md`](2026-11-14-chave-mestra-passkey.md) (etapas 1 e 2 já na `main`). Combinado com o
André: a DK é uma **etapa própria depois do QR**; esta é a hora de fazê-la porque o Mosaico ainda não construiu o lado do
navegador, então o formato do que a passkey guarda ainda pode mudar sem retrabalho.

## 1. Em uma frase

Trancar a senha do SIGAA **uma vez só**, num cofre por pessoa (a **DK**, chave de dados), e dar a cada cliente, sessão e
passkey **uma cópia da chave do cofre**, não uma cópia da senha.

## 2. Por quê

1. **Trocar a senha no SIGAA** hoje deixa velhas as cópias de todos os clientes. Com a DK, a senha nova entra no cofre uma
   vez e todos continuam funcionando.
2. **O que a passkey guarda sobrevive à troca de senha**, porque guarda a DK e não a senha. Some o custo da etapa 1 em que
   uma senha recusada apagava as cópias da passkey.
3. **O computador novo não vê a senha.** O QR entrega só a DK; quem abre o cofre é o servidor.
4. **Revogar é limpo:** tirar um cliente é apagar a cópia da DK dele.

A proteção contra quem só tem o banco de dados é a mesma de hoje (AES-256-GCM, chaves aleatórias de 256 bits). O servidor
continua vendo a senha aberta toda vez que entra no SIGAA; a DK não muda isso.

## 3. Dados

- **Novo: `sigaa_vaults`** (uma linha por pessoa): `userId` único, `login`, `secretCiphertext/Iv/AuthTag` (a senha
  cifrada com a DK), `version` (inteiro, +1 a cada troca de senha), `updatedAt`. A DK **nunca** é guardada em claro.
- **`sigaa_credentials`** (uma por pessoa e **cliente**, já existe): o que fica aqui agora é sempre a **DK** cifrada com a K do
  cliente (não há coluna `kind` nem convivência com o formato antigo). O `clientId` das **sessões do painel** é
  `ufba-web:<sessão>` (a cópia é **por sessão**, derivada do hash do token; ver §4); o dos apps é o próprio `client_id` OAuth.
- **AAD:** o cofre é cifrado com AAD `vault:<userId>` e cada cópia com `copy:<userId>:<clientId>`. Uma linha copiada para
  outro usuário ou outro cliente não abre, mesmo com a chave certa.
- **`sigaa_master_slots`** (já existe): o que a passkey cifra passa a ser a **DK** (32 bytes), não o `{ login, password }`.
  O servidor não muda nada aqui (o conteúdo é opaco); muda o **AAD**, que vira `userId || credentialId || "2"`, e o
  navegador. Em produção ainda não há cópias (não existe tela), então não há o que migrar.

## 4. Fluxos

| Momento | O que acontece |
|---|---|
| **Conectar o SIGAA no painel** (`POST /connections/sigaa`) | Valida no SIGAA. Se **não há cofre**: cria DK, cifra a senha no cofre e grava a cópia `dk` do painel (K da sessão). Se **há cofre e esta sessão abre a DK**: recifra a senha nova com a **mesma DK**, `version+1`, e marca de novo como válidas as cópias `dk` da pessoa. Se há cofre e esta sessão **não** tem a DK (a pessoa digitou a senha em vez de desbloquear): cria **DK nova**, troca o cofre, e **apaga as outras cópias `dk` e as cópias das passkeys** (a DK velha morreu). |
| **Sair** (`DELETE /session`) | Apaga a sessão e **só a cópia desta sessão**. O cofre, as cópias das outras sessões e as dos apps ficam. |
| **Ativar a passkey** | O navegador pede a DK ao servidor (`GET /connections/sigaa/key`, só com o SIGAA aberto nesta sessão), cifra com o PRF e grava a cópia (`POST /sigaa/passkey`, como hoje, com `v` 2). |
| **Desbloquear no celular** | O navegador abre a cópia da passkey (PRF local) e manda a DK ao servidor (`POST /connections/sigaa/unlock`). O servidor abre o cofre com a DK, grava a cópia `dk` desta sessão e o SIGAA fica conectado. **Sem a senha passar pelo navegador.** |
| **Desbloquear no PC pelo QR** | O pacote lacrado do correio leva a **DK**. O PC a abre e chama o mesmo `unlock`. |
| **Autorizar um app** (Claude etc.) | A aprovação abre o cofre com a K do painel (via DK) e deixa a DK em espera junto com a transação. Ao emitir o token, grava a cópia `dk` do cliente novo (DK cifrada com a K nova). |
| **Consultar o SIGAA** | `abrir(quem, K)`: abre a DK com a K e abre o cofre. Cópia no formato antigo (a senha, sem cofre) não abre: pede reautorização. |
| **Desconectar o SIGAA** (`DELETE /connections/sigaa`) | Apaga o cofre, todas as cópias `dk` e as das passkeys (a pessoa quis tirar a senha). Cópias `password` de outros clientes continuam como estão. |
| **Remover um app** | Apaga a cópia `dk` dele. O cofre fica. |
| **Excluir a conta** | Cascata. |
| **Senha recusada pelo SIGAA no uso** | `marcarInvalida` marca o cofre (`REAUTH_NEEDED` no status do cofre), não só a cópia do cliente: a senha velha vale para todos. A pessoa digita a senha nova no painel (fluxo "Conectar"), o que recifra o cofre e limpa a marca. |

**Mudança de regra da etapa 1:** "senha recusada em `POST /connections/sigaa` apaga as cópias das passkeys" **sai**. Com a
DK elas continuam valendo, e a regra só continua para o caso de **DK nova** (linha 3 da primeira linha da tabela).

## 5. Rota nova e rota que muda

| Rota | Descrição |
|---|---|
| `GET /connections/sigaa/key` | Devolve `{ dk }` (base64url, 32 bytes) para o navegador cifrar com o PRF. Exige o SIGAA **aberto nesta sessão** (senão 409 `source_not_connected`). `Cache-Control: no-store`, 10 por hora por pessoa. A DK passa pelo JavaScript do painel (mesma exposição que a senha digitada hoje): CSP rígida e descartar logo após o uso. |
| `POST /connections/sigaa/unlock` | `{ dk }` → 204. O servidor abre o cofre; DK que não abre dá 422 `invalid_credentials` (mensagem: "A chave não abriu a senha guardada. Digite a senha do SIGAA."). Grava a cópia `dk` desta sessão. 10 por minuto por pessoa. |
| `GET /me` | `sigaa.status`: `connected` se esta sessão abre; senão `locked` se há cofre válido **e** pelo menos uma cópia de passkey (um toque resolve); `password_required` se há cofre mas nada abre nesta sessão (sem passkey) ou ele pede senha nova; `disconnected` sem cofre. `sigaa.passkey.slots` continua. |

O correio (`/pairings`) **não muda**: o pacote continua opaco; só o conteúdo que o navegador lacra passa a ser a DK.

## 6. Formato antigo e migração (revisado em 15/11 depois da revisão de segurança)

- **Não há convivência com o formato antigo** (decisão do André: só ele usa o serviço por ora). Cópia de um app no formato antigo
  (a senha cifrada com a K do cliente, sem cofre) deixa de abrir e o app **pede reautorização**. O painel pede a senha uma vez.
- A migração `20261115150000_dk_review_cleanup` apaga o que a revisão tornou inútil: a cópia única `ufba-web` (agora é por
  sessão) e qualquer `sigaa_credentials` de quem não tem `sigaa_vaults` (ciphertext órfão que ficaria guardado sem prazo).
- O AAD novo (B4) torna ilegíveis os cofres e as cópias criados antes dele: nada é apagado à força; a pessoa digita a senha
  (cria DK e cofre novos, e as cópias velhas e as passkeys antigas saem junto) e reativa a passkey.
- A cópia de DK por sessão fica limitada às **20** sessões mais novas por pessoa (as que vencem sem "Sair" não deixam órfãs).

## 7. Segurança

- A DK só existe em memória: no navegador durante o desbloqueio ou a ativação, e no servidor durante uma chamada. Nunca em
  log, erro ou resposta além das duas rotas acima (os canários passam a cobrir as rotas novas, com sentinelas em `dk`).
- **Perder a DK não perde dado irrecuperável:** o cofre guarda a senha; sem nenhuma cópia da DK, a pessoa digita a senha e
  o cofre é refeito com uma DK nova.
- Quem tem uma cópia da DK de **um** cliente abre o cofre dessa pessoa para sempre (até a DK mudar). Antes, uma cópia
  aberta valia só para aquele cliente. Mitigação: revogar o cliente apaga a cópia, e **trocar a DK** (digitar a senha em
  sessão sem DK) invalida todas as outras. É a contrapartida da conveniência; vale registrar.
- O pedido do QR continua preso à mesma conta, uso único e 5 min.
- **`GET /connections/sigaa/key` exige `X-UFBA: 1`** (cabeçalho personalizado força o preflight de CORS): outro subdomínio de
  `*.ufba.app` (mesmo "site", o cookie vai junto) não gasta o limite de 10 por hora com um `<img>` nem lê a resposta.
- **A DK não muda quando a senha é trocada** por uma sessão que já tem a DK (o ganho da DK é justamente esse). Se a DK vazar (um
  cookie de sessão comprometido, um aparelho perdido), ela vale até ser trocada. **Proposta, decisão do André:** um botão
  "Trocar a chave de segurança" (`POST /connections/sigaa/rotate-key`): cria DK nova, recifra o cofre, mantém só a sessão que
  pediu e **apaga as cópias dos apps (que reautorizam) e as das passkeys (que são reativadas)**. Não implementado.

## 8. O que muda para o Mosaico (o ponto que justifica fazer isto agora)

1. A cópia da passkey cifra **a DK** (32 bytes brutos), AAD `…||"2"`, e não `{ login, password }`.
2. Ativar: chamar `GET /connections/sigaa/key`, cifrar a DK e gravar com `POST /sigaa/passkey`.
3. Desbloquear (celular ou PC pelo QR): obter a DK (da passkey ou do pacote do QR) e chamar `POST /connections/sigaa/unlock`,
   **em vez** de `POST /connections/sigaa` com login e senha.
4. O correio do QR lacra a **DK**.
5. Mensagens: a tela de "senha recusada" aparece quando `sigaa.status` for `password_required`; digitar a senha nova
   **não** exige reativar a passkey.

## 9. Etapas

1. **Cofre** (`sigaa_vaults`, `CofreSigaa` com `abrir`/`gravar` só no formato novo), testes e canário.
2. **Fluxos**: `connectSigaa`, `signOut`, `disconnect`, autorização de apps, `GET /me`.
3. **Rotas** `GET /connections/sigaa/key` e `POST /connections/sigaa/unlock`, contrato, `openapi.json`, `docs/WEB-API.md`, aviso ao Mosaico.
4. **Desenho da passkey** (§4 a §13 do outro arquivo) atualizado para a DK.

## 10. Perguntas

1. Concorda que apps antigos só ganham a DK **ao reautorizar**? (A alternativa, forçar todo mundo a reautorizar, quebra o uso de quem já está conectado.)
2. `GET /connections/sigaa/key` entrega a DK ao JavaScript do painel. Aceito (é como a senha digitada hoje) ou prefere que a ativação da passkey só aconteça logo depois de digitar a senha, sem esse endpoint?
