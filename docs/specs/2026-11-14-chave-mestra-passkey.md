# Chave mestra do SIGAA com passkey (desenho)

Status: **etapa 1 (API) implementada** em `feat/chave-mestra-etapa1`; o spike da etapa 0 deu **SEGUIR COM RESSALVA** (ver §9). Autor: agente da API (Alicerce), 14/11/2026.
Relacionado: [`2026-11-14-memoria-ufba.md`](2026-11-14-memoria-ufba.md) (outro assunto) e a mudança "sessão do SIGAA por pessoa" (branch `fix/sigaa-expirada-302`, independente deste desenho).

## 1. Problema e objetivo

Hoje a senha do SIGAA fica cifrada com uma chave K que só existe dentro do token de cada cliente (`<random>.<K>`). No painel, o token de sessão **carrega a K**, e `signOut` apaga a sessão **e a credencial do SIGAA do cliente `ufba-web`** (`WebSessionService.signOut`). Resultado: sair e entrar de novo faz o SIGAA voltar a "Conectar", e a pessoa digita a senha outra vez.

**Objetivo:** a pessoa digita a senha do SIGAA **uma vez**. Depois, em qualquer login novo no painel, um toque na passkey do celular religa o SIGAA. O servidor sozinho continua sem conseguir abrir a senha.

## 2. Decisões do André (14/11)

1. A chave mestra é a **passkey** (Android e iPhone recentes). Celular ou gerenciador sem suporte: a pessoa **digita a senha do SIGAA de novo**, como hoje. Sem código de recuperação e sem "chave de desbloqueio".
2. O toque é pedido **só quando o SIGAA está sem chave** (por exemplo, depois de sair e entrar), e não em todo login.
3. **Começa só pelo login no painel.** Aprovar outros aplicativos (o Claude etc.) com a passkey fica para depois, e já está coberto indiretamente (§7).
4. **A primeira etapa é um teste de suporte** em celulares reais, com critério de seguir ou não.
5. O botão "Abrir o SIGAA" está **fora deste desenho** (decisão pendente do André; ver o resultado do spike em `handoffs/spike-sigaa-resultado.md`).

## 3. O que a pesquisa mostra (e por que a passkey é só "uma fechadura")

Fontes lidas em 14/11/2026; vários dados vêm de blogs de fornecedores e de fóruns, então **não são garantia**: o teste da etapa 0 é o que decide.

- **Apple (iCloud Keychain / Apple Senhas):** PRF disponível a partir do iOS 18, com bug de perda de dados no iOS 18.0 a 18.3, corrigido no 18.4. O fluxo entre aparelhos por QR já devolveu resultado vazio ou diferente. Há relatos abertos no fórum da Apple de a **mesma passkey sincronizada gerar PRF diferente** entre iPhone e Mac e entre iOS 18.6 e iOS 26; a Apple respondeu que deveria ser idêntico e não há correção confirmada.
- **Google Senhas (Android):** listado com PRF funcionando (Chrome 142+ no Android, segundo um blog de fornecedor). Não achei página oficial do Google com a lista por versão.
- **Gerenciadores de terceiros (Bitwarden, 1Password etc.):** variam. O Bitwarden usa o PRF para o próprio cofre; para sites de terceiros o suporte é "dividido por plataforma" e no iPhone com Safari não devolve nada. Não dá para contar com "instalar um app".
- **Alerta do co-editor do WebAuthn (Tim Cappalli):** não use o PRF como única chave de dados, porque perder a passkey perde os dados. Recomenda **envelope** (uma chave de dados, vários envelopes) e salt/`info` próprios no HKDF. Isso **não nos atinge no ponto crítico**: o dado protegido (a senha do SIGAA) pode ser digitado de novo, então perder a passkey não perde nada irrecuperável.

**Conclusão de projeto:** a passkey é **uma fechadura de conveniência**. Qualquer falha dela (sem suporte, PRF diferente entre aparelhos, passkey apagada) cai em "digite a senha do SIGAA", e nunca trava a pessoa.

Fontes: [Corbado: WebAuthn L3 em gerenciadores de credenciais](https://www.corbado.com/blog/webauthn-l3-credential-manager-support) · [Corbado: Passkeys PRF](https://www.corbado.com/blog/passkeys-prf-webauthn) · [Lilting: não use o PRF como chave de dados](https://lilting.ch/en/articles/passkeys-prf-extension-encryption-risk) · [Apple Developer Forums 822523](https://developer.apple.com/forums/thread/822523) · [Apple Developer Forums 774112](https://developer.apple.com/forums/thread/774112) · [Bitwarden: PRF](https://bitwarden.com/blog/prf-webauthn-and-its-role-in-passkeys/) · [Android: passkeys](https://developer.android.com/identity/passkeys).

## 4. Desenho criptográfico

Duas cópias da senha, com chaves diferentes:

| Cópia | Chave | Quem abre | Onde fica |
|---|---|---|---|
| **Do cliente** (já existe) | K do token do cliente | o servidor, só com o token em mãos | `sigaa_credentials` |
| **Mestra** (nova) | KEK derivada do PRF da passkey | **só o navegador da pessoa**, com o toque | `sigaa_master_slots` |

A cópia mestra **nunca é aberta no servidor**: o PRF não sai do navegador. É o contrário do que acontece com a K, que o servidor enxerga a cada requisição.

**Derivação (no navegador, WebCrypto):**
- `PRF = passkey.get({ prf: { eval: { first: salt } } })`, com `salt` aleatório de 32 bytes **por passkey**, guardado no servidor (não é segredo).
- `KEK = HKDF-SHA256(ikm = PRF, salt = vazio, info = "ufba.app/sigaa-master/v1" || userId)`, chave AES-256-GCM **não extraível**. Nunca usar o PRF cru como chave.
- Conteúdo cifrado: `{ v: 1, login, password }` em JSON, com IV aleatório de 96 bits e dado associado (AAD) = `userId || credentialId || v`.
- O servidor guarda só: `credentialId`, `salt`, `iv`, `ciphertext` (com a tag).

**Por que o servidor não precisa validar a passkey (assertion):** ela serve de **detentora de chave**, não de autenticação. Quem autentica a pessoa continua sendo o cookie de sessão (Google @ufba.br). Isso dispensa biblioteca de servidor para WebAuthn. Quem consegue pôr uma cópia mestra falsa precisaria da sessão **e** da senha do SIGAA; quem apenas lê uma cópia mestra vê um texto cifrado.

**RP ID = `ufba.app`** (domínio-pai): vale para `meu.ufba.app`, `auth.ufba.app` e para o domínio antigo na transição do painel, sem refazer passkeys. Contrapartida: qualquer subdomínio de `ufba.app` consegue pedir a passkey (a pessoa vê o toque, e a CSP dos subdomínios precisa ser rígida). Configurável por `WEBAUTHN_RP_ID`.

## 5. Fluxos

### 5.1 Ativar (depois de conectar o SIGAA com a senha)
1. A pessoa conecta o SIGAA como hoje (`POST /connections/sigaa`). O navegador ainda tem login e senha na memória do formulário.
2. A tela oferece "Guardar com a passkey". Se o aparelho não suporta PRF (detecção em §6), **não oferece**.
3. O navegador cria a passkey (descobrível, `userVerification: required`, `prf` ligado), gera `salt`, deriva a KEK, cifra `{login, password}` e envia `POST /web/sigaa/passkey`.
4. **Autoteste antes de declarar ativo:** o navegador faz um `get` logo em seguida, recalcula a KEK e **decifra a própria cópia**. Só se der certo a tela diz "ativado"; senão descarta a cópia e avisa que este aparelho não suporta.

### 5.2 Sair e entrar de novo
1. `signOut` continua apagando a sessão e a cópia do cliente. **A cópia mestra fica.**
2. No login seguinte, `GET /me` traz `sigaa.status: "locked"` (§6), no lugar de `disconnected`.
3. A tela mostra "Desbloquear o SIGAA" (um toque). O navegador busca a cópia mestra, faz o `get` da passkey, deriva a KEK e **decifra** `{login, password}` em memória.
4. O navegador chama o `POST /connections/sigaa` **já existente** com esse login e senha. O servidor valida no SIGAA e cifra a senha com a K da sessão nova, exatamente como numa conexão normal. O resultado é `connected`.
5. Falha em qualquer ponto (toque cancelado, passkey sem suporte, PRF diferente, senha mudou no SIGAA): a tela cai no formulário normal "digite a senha do SIGAA". **Se o SIGAA recusa a senha** em `POST /connections/sigaa` (código `invalid_credentials`), **o servidor apaga todas as cópias mestras da pessoa**: assim a senha velha não é tentada a cada login (o que poderia bloquear a conta no SIGAA). A pessoa pode ativar a passkey de novo depois de conectar com a senha nova. (Uma senha digitada errada também apaga; é o custo de não insistir.)

### 5.3 Desconectar e excluir
- **Desconectar o SIGAA** (`DELETE /connections/sigaa`): apaga também as cópias mestras (a pessoa quis tirar a senha).
- **Excluir a conta** (`DELETE /me`): cascata no banco.
- **Remover a passkey** (tela de configurações): `DELETE /web/sigaa/passkey/{credentialId}`; a cópia do cliente e a conexão atual não mudam.

### 5.4 Outros aplicativos (depois)
A aprovação de um app novo já abre a senha com a K da sessão do painel. Se a sessão está `locked`, a tela de aprovação **faz primeiro o 5.2** (um toque) e depois aprova. Não há desenho novo a fazer para isso; fica como segunda etapa só pela UI.

## 6. Contrato e dados

### 6.1 Modelo de dados (Prisma, pasta `identity`)

```prisma
model SigaaMasterSlot {
  id           String   @id @default(uuid(7)) @db.Uuid
  userId       String   @map("user_id") @db.Uuid
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  credentialId String   @map("credential_id")   // base64url da passkey
  prfSalt      String   @map("prf_salt")        // base64url, 32 bytes, não é segredo
  iv           String                           // base64url, 12 bytes
  ciphertext   String                           // base64url, AES-GCM com a tag
  label        String?                          // texto livre curto ("iPhone"), vindo do navegador
  createdAt    DateTime @default(now()) @map("created_at")
  lastUnlockedAt DateTime? @map("last_unlocked_at")

  @@unique([userId, credentialId])
  @@map("sigaa_master_slots")
}
```
Limite de 5 cópias por pessoa (a API barra; as gravações da mesma pessoa são serializadas para a corrida não furar o limite). Os limites por minuto/hora vivem em memória e supõem **uma só instância da API**. O servidor nunca loga nem devolve esses campos fora das rotas abaixo.

### 6.2 Endpoints (no `contract.ts`/`openapi.json`; avisar o Mosaico)

| Rota | Descrição |
|---|---|
| `GET /me` (já existe) | `connections.sigaa.status` ganha o valor **`locked`**: existe cópia mestra e a sessão não tem a senha. Regra: `connected` se a K da sessão abre; senão `locked` se há cópia mestra; senão `password_required` (cópia do cliente existe) ou `disconnected`. Campo novo `sigaa.passkey: { slots: number }`. |
| `GET /sigaa/passkey` | Lista as cópias: `{ passkeys: [{ credentialId, prfSalt, label, createdAt, lastUnlockedAt }] }`. O `prfSalt` (não é segredo) vem aqui porque o navegador precisa dele **antes** do toque (`evalByCredential`). `Cache-Control: no-store`. |
| `POST /sigaa/passkey` | `{ credentialId, prfSalt, iv, ciphertext, label? }`. Exige SIGAA `connected` nesta sessão. 409 `passkey_limit_reached`; 400 `invalid_request`. |
| `POST /sigaa/passkey/slot` | `{ credentialId }` → `{ prfSalt, iv, ciphertext }` para o navegador decifrar. `POST` (e não `GET`) para o id não ir na URL nem em log de acesso. 10 por minuto por pessoa. `Cache-Control: no-store`. **Marca `lastUnlockedAt` ao entregar a cópia** (não há confirmação do navegador: simplificação da etapa 1; significa "última vez que o desbloqueio foi pedido"). |
| `DELETE /sigaa/passkey/{credentialId}` | Remove uma cópia. Sem corpo. O id vai na URL (diferente do `slot`): aceita no log de acesso por ser só um identificador de passkey, sem segredo. |

Códigos novos em `API_ERROR_CODES`: `passkey_limit_reached`, `passkey_not_found`. Textos (`message`) em pt-BR. Segue valendo CSRF (`X-UFBA`, `Origin`, JSON).

### 6.3 Detecção de suporte (no web)
- Só oferece a passkey se `PublicKeyCredential` existe **e** a criação devolve `getClientExtensionResults().prf.enabled === true`. Se a criação não devolver o valor, faz um `get` logo em seguida para derivar (alguns gerenciadores só devolvem o PRF no `get`).
- O autoteste do 5.1 é a prova final.

## 7. Segurança

- **Banco ou servidor vazado:** o atacante vê `ciphertext`, `salt` e `iv`. Sem o PRF (que fica no autenticador/gerenciador da passkey), não abre. O PRF tem 256 bits: sem ataque de força bruta.
- **Senha no navegador:** ela já passa pelo navegador na conexão (a pessoa a digita). No desbloqueio ela fica **brevemente na memória da página**, exposta a extensões, DevTools e XSS, o mesmo risco de hoje durante a digitação. Mitigação: CSP rígida no painel e nos subdomínios (por causa do RP ID `ufba.app`), nada de `localStorage`, descartar a variável logo após o `POST`.
- **Phishing:** a passkey é presa ao RP ID; um site de fora de `ufba.app` não consegue pedi-la.
- **Risco do gerenciador de passkeys:** a segurança do PRF é a do gerenciador (por exemplo, relatos de extração da chave-mestra do Google Senhas da memória do Chrome). Fora do nosso controle; a cópia é opcional e revogável.
- **Nada em log:** senha, PRF, KEK, e também `ciphertext`/`salt`/`iv`. Os canários (`test/secret-canary.spec.ts`) passam a cobrir as rotas novas.
- **Rate limit:** `slot` 10 por minuto por pessoa; `passkey` (criar) 5 por hora.
- **Princípio mantido:** o servidor sozinho não abre a senha. O que muda é onde ela abre no desbloqueio: no navegador, e a cópia do cliente é recriada pelo caminho de sempre.

## 8. Etapas

| Etapa | Entrega | Quem |
|---|---|---|
| **0. Teste de suporte** | Página de teste e matriz de aparelhos (§9). **Critério de seguir/parar.** | Mosaico hospeda a página; André testa; API lê o resultado |
| **1. Núcleo (API)** | Tabela, rotas de §6.2, `status: locked`, apagar em `DELETE /connections/sigaa`, testes, canário, `openapi.json` | API |
| **2. Cripto no web** | HKDF/AES-GCM, `create`/`get` com PRF, autoteste, com vetores de teste fixos | Mosaico |
| **3. Telas** | "Guardar com a passkey" após conectar, "Desbloquear o SIGAA" no login, lista e remoção em configurações, textos em pt-BR | Mosaico |
| **4. Endurecimento** | CSP dos subdomínios, rate limit, telemetria de falhas sem dado sensível, `docs/WEB-API.md` | API + Mosaico |
| **Depois** | Aprovar apps com o desbloqueio (5.4), botão "Abrir o SIGAA", segundo aparelho não sincronizado | a decidir |

Cada etapa só vai para produção com CI verde. Nenhum teste contra o SIGAA real sem o OK do André (a etapa 0 não toca no SIGAA).

## 9. Etapa 0: o teste de suporte

**Página estática** (sem chamar a API, sem SIGAA, sem senha), numa origem **HTTPS dentro de `ufba.app`** (por exemplo, uma rota escondida do painel), para o RP ID ser o real. Ela executa e mostra, para cada passo, OK ou falha:

1. **Criar a passkey** com `prf` e informar `prf.enabled`.
2. **Derivar duas vezes** com o mesmo salt e conferir que dá o mesmo resultado.
3. **Salt diferente** dá resultado diferente.
4. **Round-trip:** HKDF, cifrar e decifrar um texto de teste com AES-GCM.
5. **Entre aparelhos:** mostra um **resumo curto** do PRF (os 4 primeiros bytes do SHA-256, nunca o PRF) para a pessoa comparar o mesmo salt em dois aparelhos que compartilham a passkey (iPhone e Mac, por exemplo). Os resumos precisam ser iguais.
6. **Ambiente:** agente de usuário, sistema, e qual gerenciador respondeu.

**Matriz mínima a preencher** (cada linha com "passou/não passou" nos passos 1 a 5):
- iPhone com iOS 18.4 ou mais: Safari e Chrome, Apple Senhas.
- Android recente: Chrome com Google Senhas; e, se o André usar, Samsung Pass.
- Mac (Safari/Chrome) e Windows (Chrome/Edge) como "computador".
- Bitwarden, só se o André quiser saber (informativo).

**Critério de seguir:** passos 1 a 4 passam em **iPhone (iOS 18.4+) e Android (Chrome + Google Senhas)**, e o passo 5 dá resumos iguais entre dois aparelhos da mesma conta. Se o 5 falhar entre iPhone e Mac, seguimos assim mesmo (o autoteste e o fallback cobrem), mas a tela avisa que o desbloqueio só vale no aparelho onde a passkey foi criada. Se o 1 a 4 falhar em um dos dois sistemas, **paramos** e o SIGAA continua com a digitação da senha.

O resultado entra num arquivo `handoffs/passkey-prf-resultado.md` (sem valores de PRF), com a matriz.

## 10. O que não muda

- A K por cliente e as cópias cifradas por cliente (continuam; a mestra só recria a do painel).
- A sessão do SIGAA por pessoa e a senha só para logar (outro desenho, independente).
- OAuth, MCP e as ferramentas.

## 11. Perguntas em aberto

1. **RP ID `ufba.app`** (cobre todos os subdomínios, mas qualquer um deles pode pedir o toque)? A alternativa é um RP ID por subdomínio, que quebra na troca de `ufba.app` para `meu.ufba.app`.
2. **Oferecer a passkey automaticamente** logo após conectar o SIGAA, ou só num botão em configurações? Recomendo oferecer uma vez, com "agora não".
3. **Vários aparelhos não sincronizados** (por exemplo, um iPhone e um Android sem sincronia): permitir até 5 cópias (como no desenho) ou só 1?
4. **Nome na tela:** "passkey" ou algo como "biometria do celular"? (Texto pt-BR, decisão do Mosaico com o André.)
5. **Onde hospedar a página de teste** da etapa 0 (rota escondida do painel do Mosaico, ou outro subdomínio de teste)?

## 13. Etapa 2: liberar outro aparelho por QR (decidido em 15/11/2026, sem a DK)

Método do André (`dev/ufba/handoffs/metodo-chave-mestra-sigaa.md`). Um aparelho novo mostra um QR com um link do
próprio ufba.app; o celular da **mesma conta** lê com a câmera comum, confirma com a passkey **no próprio celular** (o PRF
nunca atravessa aparelhos) e entrega ao aparelho novo um pacote lacrado. A API faz só o "correio" (`sigaa_pairings`,
rotas `/pairings`, ver `docs/WEB-API.md`).

**Decisão:** o pacote leva o `{ login, password }` (o mesmo conteúdo da cópia da passkey), e o aparelho novo chama o
`POST /connections/sigaa` de sempre. A **DK** (chave de dados por pessoa, com cópias embrulhadas por cliente e por passkey)
fica como **etapa própria depois**: o formato da cópia da passkey já é versionado (`v` no AAD), então a DK entra sem apagar nada.

Cuidados: pedido preso à conta de quem o abre (o celular de outra conta recebe 404); uso único e 5 min; o celular mostra
**o que** está liberando (`label`, `client`, horário) vindo do servidor, não do fragmento; a chave pública do aparelho novo
vai só no fragmento do link. Pendências: testar o fluxo completo no iPhone; aviso "novo cliente liberado" com "não fui eu";
revogar a passkey do celular em "Clientes com acesso".

## 12. Resultado do spike (etapa 0, 14 e 15/11/2026)

Detalhes em `dev/ufba/handoffs/spike-passkey-prf-resultado.md`. **SEGUIR COM RESSALVA.**

- Passos 1 a 4 passaram no iPhone (Safari, Apple Senhas) e no Android (Chrome com Google Senhas e com Samsung Pass). RP ID `ufba.app` funcionou a partir de um subdomínio.
- **PRF pelo QR do sistema** (passkey do celular usada no PC) **falhou** com o Samsung Pass: o Chrome devolve `prf: {}`, o Firefox devolve as extensões vazias. iPhone↔Mac e Google Senhas↔outro aparelho não foram testados.
- Um pareamento por QR (o celular abre a cópia com o PRF local e lacra a chave ao PC por ECDH) funcionou onde o PRF pelo QR falhou. Fica como alternativa para o PC (precisa de um relay no servidor); **não faz parte da etapa 1**.
- Detecção de suporte: não use `getClientCapabilities()['extension:prf']`; tente criar com `prf.eval` e exija 32 bytes de PRF no `create` ou no `get` seguinte (Samsung Pass só devolve no `get`).
