import { Secret } from '../../../application/shared/secret';
import type { IdentityService } from '../../../application/identity/identity.service';
import type { AppClassroom, ClassroomLinkPort } from '../../../application/oauth/oauth-ports';
import type { SourceAccountRepository } from '../../../application/ports/repositories';
import type { FetchFn } from '../google/google-http';
import { exchangeCode, GOOGLE_AUTH_URL, GoogleLinkError, userInfo } from '../google/google-oauth-flow';

/**
 * Somente leitura do Classroom + e-mail (vira o `accountKey`) + `drive.readonly` para baixar os anexos (arquivos do
 * Drive). `drive.readonly` é escopo RESTRITO: só é usado sem auditoria porque
 *  - no app INTERNO (contas @ufba.br) apps internos não passam por verificação;
 *  - no app EXTERNO (convidados) o app fica em "Testando", com até 100 usuários de teste adicionados à mão.
 * O código só baixa arquivos anexados no Classroom (ver `ClassroomLive.baixar`).
 */
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const CLASSROOM_LINK_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  DRIVE_READONLY_SCOPE,
];

const TEST_URL = 'https://classroom.googleapis.com/v1/courses';

export interface ClienteGoogle {
  clientId: string;
  clientSecret: string;
}

/** Qual app OAuth emitiu (e renova) o acesso de uma conta: decidido só pelo domínio do e-mail. */
export function appDaConta(email: string, dominio = 'ufba.br'): AppClassroom {
  return email.toLowerCase().endsWith(`@${dominio.toLowerCase()}`) ? 'ufba' : 'convidado';
}

function clienteDoEnv(id?: string, secret?: string): ClienteGoogle | undefined {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined;
}

/**
 * Conectar o Classroom, por um de dois apps OAuth:
 *  - `ufba`: o app INTERNO do login (`GOOGLE_CLIENT_ID/SECRET`), só contas do domínio; redirect
 *    `<PUBLIC_URL>/oauth/callback/google` (o mesmo do login, já cadastrado). Sem limite de usuários nem expiração.
 *  - `convidado`: o app EXTERNO (`GOOGLE_CLASSROOM_CLIENT_ID/SECRET`), para turmas em gmail pessoal; só quem estiver
 *    na lista de usuários de teste; o acesso expira em 7 dias (modo "Testando"). Redirect `/oauth/callback/classroom`.
 * Dá para conectar mais de uma conta. Nada é logado.
 */
export class ClassroomLink implements ClassroomLinkPort {
  private readonly dominio: string;

  constructor(
    private readonly identity: IdentityService,
    private readonly accounts: SourceAccountRepository,
    private readonly cfg: {
      ufba?: ClienteGoogle;
      convidado?: ClienteGoogle;
      dominio?: string;
      fetchFn?: FetchFn;
    } = {
      ufba: clienteDoEnv(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET),
      convidado: clienteDoEnv(process.env.GOOGLE_CLASSROOM_CLIENT_ID, process.env.GOOGLE_CLASSROOM_CLIENT_SECRET),
      dominio: process.env.GOOGLE_ALLOWED_DOMAIN,
    },
  ) {
    this.dominio = (cfg.dominio || 'ufba.br').toLowerCase();
  }

  apps(): AppClassroom[] {
    return (['ufba', 'convidado'] as const).filter((a) => this.cfg[a]);
  }

  enabled(): boolean {
    return this.apps().length > 0;
  }

  private client(app: AppClassroom) {
    const c = this.cfg[app];
    if (!c) {
      throw new GoogleLinkError(
        app === 'ufba'
          ? 'Classroom @ufba.br não configurado: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET'
          : 'Classroom de convidados não configurado: defina GOOGLE_CLASSROOM_CLIENT_ID e GOOGLE_CLASSROOM_CLIENT_SECRET',
      );
    }
    return { ...c, fetchFn: this.cfg.fetchFn };
  }

  async startUrl(app: AppClassroom, callbackUrl: string, state: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: this.client(app).clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: CLASSROOM_LINK_SCOPES.join(' '),
      access_type: 'offline',
      // consent: garante o refresh token; select_account: a pessoa escolhe a conta das turmas.
      prompt: 'consent select_account',
      state,
    });
    if (app === 'ufba') params.set('hd', this.dominio); // dica de UI; a checagem é no callback
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async handleCallback(app: AppClassroom, userId: string, code: string, callbackUrl: string): Promise<{ email: string }> {
    const c = this.client(app);
    const tok = await exchangeCode(c, code, callbackUrl);
    if (!tok.refresh_token) {
      throw new GoogleLinkError(
        'O Google não devolveu refresh token; revogue o acesso em myaccount.google.com/permissions e tente de novo',
      );
    }
    const info = await userInfo(c, tok.access_token);
    const email = info.email?.toLowerCase();
    if (!email) throw new GoogleLinkError('Conta Google sem e-mail');
    // O app que emitiu o token tem que ser o que a regra do domínio escolhe na hora de renovar.
    if (appDaConta(email, this.dominio) !== app) {
      throw new GoogleLinkError(
        app === 'ufba'
          ? `Escolha uma conta @${this.dominio} (para outras contas, use "Conectar outra conta")`
          : `Contas @${this.dominio} entram pelo botão "Conectar Classroom @${this.dominio}"`,
      );
    }
    await this.testarLeitura(c.fetchFn, tok.access_token);
    await this.identity.conectarConta({ userId, provider: 'CLASSROOM', accountKey: email, secretPlain: Secret.of(tok.refresh_token) });
    return { email };
  }

  /** Leitura de teste antes de guardar: 1 chamada, no máximo 1 turma. Não lê nem grava conteúdo. */
  private async testarLeitura(fetchFn: FetchFn | undefined, accessToken: string): Promise<void> {
    const res = await (fetchFn ?? fetch)(`${TEST_URL}?pageSize=1`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new GoogleLinkError(
        res.status === 403
          ? 'O Google não liberou a leitura do Classroom (permissão negada na tela do Google, conta fora da lista de teste, ou API desativada no projeto)'
          : `Falha no teste de leitura do Classroom (${res.status})`,
      );
    }
  }
}
