# Integração Google (Classroom, Calendar, Drive)

A plataforma lê Classroom, Calendar e anexos do Drive com a API REST do Google, usando um **refresh token** da pessoa. O token é recebido pela plataforma e guardado **cifrado** (AES-256-GCM, chave em `SECRETS_KEY`). O acesso é somente leitura.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | credenciais do cliente OAuth (passo 3) |
| `SECRETS_KEY` | 32 bytes em hex (64 chars) ou base64, para cifrar tokens. Gere com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

## Escopos usados (todos somente leitura)

- `classroom.courses.readonly`
- `classroom.coursework.me.readonly` (tarefas e notas das suas submissões)
- `classroom.announcements.readonly`
- `classroom.courseworkmaterials.readonly`
- `calendar.readonly`
- `drive.readonly` (baixar anexos sob demanda)

## Passo a passo no Google Cloud Console

1. Acesse <https://console.cloud.google.com/> e crie um projeto (ex.: `ufba-platform`).
2. **APIs e serviços › Biblioteca**: ative **Google Classroom API**, **Google Calendar API** e **Google Drive API**.
3. **APIs e serviços › Tela de permissão OAuth** (Google Auth Platform):
   - Tipo de usuário: **Externo** (conta Gmail pessoal) ou **Interno** (conta Workspace da instituição, se permitido).
   - Preencha nome do app e e-mail de suporte/contato.
   - Em **Acesso a dados / Escopos**, adicione os seis escopos acima.
   - Em **Usuários de teste**, adicione o seu e-mail Google. Com o app em modo "Teste", o refresh token **expira em 7 dias**; para uso contínuo, publique o app (**Em produção**). Para uso pessoal os escopos sensíveis funcionam com o aviso "app não verificado".
4. **Credenciais › Criar credenciais › ID do cliente OAuth**:
   - Tipo de aplicativo: **App para computador** (Desktop). Esse tipo aceita o redirecionamento em loopback (`http://127.0.0.1:<porta>`) sem cadastrar URI.
   - Copie o **ID do cliente** e a **chave secreta do cliente**.
5. Obtenha o refresh token (nada é gravado em disco):

   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-refresh-token.mjs
   ```

   No PowerShell:

   ```powershell
   $env:GOOGLE_CLIENT_ID='...'; $env:GOOGLE_CLIENT_SECRET='...'; node scripts/google-refresh-token.mjs
   ```

   O navegador abre a tela de consentimento; ao aceitar, o terminal imprime o refresh token. Guarde-o em local seguro (gerenciador de senhas) e entregue-o à plataforma, que o cifra com `SECRETS_KEY`.

## Problemas comuns

- **`access_denied` / app bloqueado**: seu e-mail não está em *Usuários de teste*.
- **Sem `refresh_token` na resposta**: o script já força `prompt=consent`; se persistir, revogue o acesso em <https://myaccount.google.com/permissions> e rode de novo.
- **`invalid_grant` depois de dias**: token expirou (app em modo Teste) ou foi revogado. A plataforma sinaliza `REAUTH_NEEDED`; gere outro token.
- **403 na Classroom**: conta sem acesso à Classroom (algumas contas institucionais bloqueiam apps de terceiros).
