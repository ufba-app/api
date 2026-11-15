# DK: chave de dados por pessoa para a senha do SIGAA (desenho)

Status: **proposta**, sem código. Autor: agente da API (Alicerce), 15/11/2026. Depende de
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
- **`sigaa_credentials`** (uma por pessoa e cliente, já existe) ganha a coluna `kind`: `password` (formato atual: o cifrado
  é a **senha**, aberto com a K do cliente) ou `dk` (o cifrado é a **DK**, aberta com a K do cliente). Linhas existentes
  ficam `password`.
- **`sigaa_master_slots`** (já existe): o que a passkey cifra passa a ser a **DK** (32 bytes), não o `{ login, password }`.
  O servidor não muda nada aqui (o conteúdo é opaco); muda o **AAD**, que vira `userId || credentialId || "2"`, e o
  navegador. Em produção ainda não há cópias (não existe tela), então não há o que migrar.

## 4. Fluxos

| Momento | O que acontece |
|---|---|
| **Conectar o SIGAA no painel** (`POST /connections/sigaa`) | Valida no SIGAA. Se **não há cofre**: cria DK, cifra a senha no cofre e grava a cópia `dk` do painel (K da sessão). Se **há cofre e esta sessão abre a DK**: recifra a senha nova com a **mesma DK**, `version+1`, e marca de novo como válidas as cópias `dk` da pessoa. Se há cofre e esta sessão **não** tem a DK (a pessoa digitou a senha em vez de desbloquear): cria **DK nova**, troca o cofre, e **apaga as outras cópias `dk` e as cópias das passkeys** (a DK velha morreu). |
| **Sair** (`DELETE /session`) | Apaga a sessão e a cópia `dk` do painel. **O cofre fica.** |
| **Ativar a passkey** | O navegador pede a DK ao servidor (`GET /connections/sigaa/key`, só com o SIGAA aberto nesta sessão), cifra com o PRF e grava a cópia (`POST /sigaa/passkey`, como hoje, com `v` 2). |
| **Desbloquear no celular** | O navegador abre a cópia da passkey (PRF local) e manda a DK ao servidor (`POST /connections/sigaa/unlock`). O servidor abre o cofre com a DK, grava a cópia `dk` desta sessão e o SIGAA fica conectado. **Sem a senha passar pelo navegador.** |
| **Desbloquear no PC pelo QR** | O pacote lacrado do correio leva a **DK**. O PC a abre e chama o mesmo `unlock`. |
| **Autorizar um app** (Claude etc.) | A aprovação abre o cofre com a K do painel (via DK) e deixa a DK em espera junto com a transação. Ao emitir o token, grava a cópia `dk` do cliente novo (DK cifrada com a K nova). |
| **Consultar o SIGAA** | `abrir(quem, K)`: se a cópia é `dk`, abre a DK com a K e abre o cofre; se é `password` (legado), abre a senha direto, como hoje. |
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

## 6. Convivência com o legado e migração

- Clientes que já têm cópia `password` **continuam funcionando sem mudança**. Eles migram quando a pessoa **reautorizar**
  o app (a autorização nova passa a gravar `dk`).
- **Limite honesto:** o servidor não consegue converter a cópia `password` de um cliente em `dk` sozinho, porque só tem a K
  daquele cliente durante a chamada dele e a DK só existe quando alguém a apresenta. Então, até reautorizar, **trocar a
  senha no SIGAA ainda quebra aqueles clientes antigos** (como hoje). O ganho vale para o painel, as passkeys e os apps
  autorizados daqui em diante.
- Quem já tem o SIGAA conectado no painel (cópia `password` do painel): na primeira vez que o painel abrir a senha
  (`abrir` com a K da sessão), o servidor **cria o cofre e a DK** na hora, grava a cópia `dk` do painel e troca a linha
  antiga. A conversão é "preguiçosa", por pessoa, e não pede nada à pessoa.
- Sem rollback de dados necessário: o formato `password` continua lido enquanto existir.

## 7. Segurança

- A DK só existe em memória: no navegador durante o desbloqueio ou a ativação, e no servidor durante uma chamada. Nunca em
  log, erro ou resposta além das duas rotas acima (os canários passam a cobrir as rotas novas, com sentinelas em `dk`).
- **Perder a DK não perde dado irrecuperável:** o cofre guarda a senha; sem nenhuma cópia da DK, a pessoa digita a senha e
  o cofre é refeito com uma DK nova.
- Quem tem uma cópia da DK de **um** cliente abre o cofre dessa pessoa para sempre (até a DK mudar). Antes, uma cópia
  aberta valia só para aquele cliente. Mitigação: revogar o cliente apaga a cópia, e **trocar a DK** (digitar a senha em
  sessão sem DK) invalida todas as outras. É a contrapartida da conveniência; vale registrar.
- O pedido do QR continua preso à mesma conta, uso único e 5 min.

## 8. O que muda para o Mosaico (o ponto que justifica fazer isto agora)

1. A cópia da passkey cifra **a DK** (32 bytes brutos), AAD `…||"2"`, e não `{ login, password }`.
2. Ativar: chamar `GET /connections/sigaa/key`, cifrar a DK e gravar com `POST /sigaa/passkey`.
3. Desbloquear (celular ou PC pelo QR): obter a DK (da passkey ou do pacote do QR) e chamar `POST /connections/sigaa/unlock`,
   **em vez** de `POST /connections/sigaa` com login e senha.
4. O correio do QR lacra a **DK**.
5. Mensagens: a tela de "senha recusada" aparece quando `sigaa.status` for `password_required`; digitar a senha nova
   **não** exige reativar a passkey.

## 9. Etapas

1. **Cofre** (`sigaa_vaults`, coluna `kind`, `CofreSigaa` com `abrir`/`gravar` dos dois formatos, conversão preguiçosa), testes e canário.
2. **Fluxos**: `connectSigaa`, `signOut`, `disconnect`, autorização de apps, `GET /me`.
3. **Rotas** `GET /connections/sigaa/key` e `POST /connections/sigaa/unlock`, contrato, `openapi.json`, `docs/WEB-API.md`, aviso ao Mosaico.
4. **Desenho da passkey** (§4 a §13 do outro arquivo) atualizado para a DK.

## 10. Perguntas

1. Concorda que apps antigos só ganham a DK **ao reautorizar**? (A alternativa, forçar todo mundo a reautorizar, quebra o uso de quem já está conectado.)
2. `GET /connections/sigaa/key` entrega a DK ao JavaScript do painel. Aceito (é como a senha digitada hoje) ou prefere que a ativação da passkey só aconteça logo depois de digitar a senha, sem esse endpoint?
