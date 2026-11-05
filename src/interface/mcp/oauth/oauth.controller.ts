import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { baseUrl } from './base-url';
import {
  CLASSROOM_LINK,
  ClassroomLinkPort,
  GOOGLE_LINK,
  GoogleLinkPort,
  MOODLE_LINK,
  MoodleLinkPort,
  OAUTH_STORE,
  OAuthStore,
  SIGAA_LINK,
  SigaaLinkPort,
} from '../../../application/oauth/oauth-ports';
import { AuthorizeParams, OAuthError, OAuthService, TokenParams } from '../../../application/oauth/oauth.service';
import { connectPage, errorPage, identifyPage, moodlePage } from './pages';
import { timingSafeEqual } from 'node:crypto';

export const OAUTH_SERVICE = Symbol('OAUTH_SERVICE');

const MOODLE_TXN_COOKIE = 'ufba_moodle_txn';

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function secretOk(given: string | undefined): boolean {
  const expected = process.env.OAUTH_AUTHORIZE_SECRET;
  if (!expected) return true;
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller()
export class OAuthController {
  constructor(
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Inject(OAUTH_STORE) private readonly store: OAuthStore,
    @Inject(GOOGLE_LINK) private readonly google: GoogleLinkPort,
    @Inject(MOODLE_LINK) private readonly moodle: MoodleLinkPort,
    @Inject(CLASSROOM_LINK) private readonly classroom: ClassroomLinkPort,
    @Inject(SIGAA_LINK) private readonly sigaa: SigaaLinkPort,
  ) {}

  // ---- metadados (RFC 9728 e RFC 8414) ----

  @Get('.well-known/oauth-protected-resource')
  protectedResource(@Req() req: Request) {
    const base = baseUrl(req);
    return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] };
  }

  @Get('.well-known/oauth-authorization-server')
  authorizationServer(@Req() req: Request) {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
  }

  // ---- registro dinâmico de cliente (RFC 7591) ----

  @Post('register')
  async register(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      const c = await this.oauth.registerClient(body ?? {});
      res.status(201).json({
        client_id: c.clientId,
        client_name: c.clientName,
        redirect_uris: c.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(c.createdAt / 1000),
      });
    } catch (e) {
      this.oauthJson(res, e);
    }
  }

  // ---- /authorize: telas mínimas ----

  @Get('authorize')
  async authorize(@Query() q: AuthorizeParams, @Res() res: Response) {
    try {
      const p = await this.oauth.begin(q);
      const client = await this.store.getClient(p.clientId);
      this.html(
        res,
        identifyPage(p.id, client?.clientName, !!process.env.OAUTH_AUTHORIZE_SECRET, undefined, this.google.loginEnabled()),
      );
    } catch (e) {
      this.htmlError(res, e);
    }
  }

  @Post('authorize')
  async authorizePost(@Body() b: Record<string, string>, @Res() res: Response) {
    try {
      if (b.acao === 'negar') return res.redirect(303, await this.oauth.deny(b.txn));
      if (b.acao === 'concluir') return res.redirect(303, await this.oauth.complete(b.txn));

      // identificar. Com o Google configurado, e-mail digitado não identifica ninguém: só o login Google.
      const pending = await this.oauth.pending(b.txn);
      if (this.google.loginEnabled()) {
        const client = await this.store.getClient(pending.clientId);
        return this.html(
          res,
          identifyPage(pending.id, client?.clientName, false, 'Entre com sua conta Google institucional.', true),
          403,
        );
      }
      if (!secretOk(b.secret)) {
        const client = await this.store.getClient(pending.clientId);
        return this.html(res, identifyPage(pending.id, client?.clientName, true, 'Senha de acesso incorreta.'), 403);
      }
      const next = await this.oauth.identify(b.txn, b.email ?? '');
      await this.renderConnect(res, next.id, next.userId!);
    } catch (e) {
      this.htmlError(res, e);
    }
  }

  // ---- login com Google (identidade: openid/email/profile, só @ufba.br) ----

  @Get('oauth/login/google')
  async googleLogin(@Query('txn') txn: string, @Req() req: Request, @Res() res: Response) {
    try {
      const p = await this.oauth.pending(txn);
      res.redirect(303, await this.google.startLoginUrl(`${baseUrl(req)}/oauth/callback/google`, p.id));
    } catch (e) {
      this.htmlError(res, e);
    }
  }

  @Get('oauth/callback/google')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') txn: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const callbackUrl = `${baseUrl(req)}/oauth/callback/google`;
    let p;
    try {
      p = await this.oauth.pending(txn);
    } catch (e) {
      return this.htmlError(res, e);
    }
    // Mesmo redirect do app interno para as duas etapas: sem usuário ainda = LOGIN; com usuário = CLASSROOM @ufba.br.
    if (p.userId) {
      try {
        const { email } = await this.classroom.handleCallback('ufba', p.userId, code, callbackUrl);
        return await this.renderConnect(res, p.id, p.userId, `Classroom conectado (${email}).`);
      } catch (e) {
        return await this.backToConnect(res, txn, e);
      }
    }
    try {
      const { email } = await this.google.handleLoginCallback(code, callbackUrl);
      const next = await this.oauth.identify(p.id, email);
      await this.renderConnect(res, next.id, next.userId!);
    } catch (e) {
      const client = await this.store.getClient(p.clientId);
      const msg = e instanceof Error ? e.message : 'Falha ao entrar com o Google';
      this.html(res, identifyPage(p.id, client?.clientName, false, msg, true), 403);
    }
  }

  // ---- conectar Classroom: @ufba.br (app interno, callback acima) ou convidado (app externo, callback abaixo) ----

  @Get('oauth/connect/classroom')
  async classroomStart(
    @Query('txn') txn: string,
    @Query('app') app: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const p = await this.identified(txn);
      const qual = app === 'convidado' ? 'convidado' : 'ufba';
      const callback = `${baseUrl(req)}/oauth/callback/${qual === 'ufba' ? 'google' : 'classroom'}`;
      res.redirect(303, await this.classroom.startUrl(qual, callback, p.id));
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  @Get('oauth/callback/classroom')
  async classroomCallback(
    @Query('code') code: string,
    @Query('state') txn: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const p = await this.identified(txn);
      if (error) throw new Error('Conexão com o Classroom cancelada na tela do Google.');
      const callbackUrl = `${baseUrl(req)}/oauth/callback/classroom`;
      const { email } = await this.classroom.handleCallback('convidado', p.userId!, code, callbackUrl);
      await this.renderConnect(res, p.id, p.userId!, `Classroom conectado (${email}).`);
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  @Get('oauth/connect')
  async connectHome(@Query('txn') txn: string, @Query('ok') ok: string, @Res() res: Response) {
    try {
      const p = await this.identified(txn);
      await this.renderConnect(res, p.id, p.userId!, ok === 'moodle' ? 'Moodle conectado.' : undefined);
    } catch (e) {
      this.htmlError(res, e);
    }
  }

  // ---- conectar Moodle: login no navegador da pessoa ----
  // Caminho principal: o launch.php termina em `web+ufba://token=...`; a tela registra este serviço como tratador
  // desse esquema (navigator.registerProtocolHandler) e o navegador entrega o endereço em /oauth/moodle/capture.
  // A transação vem num cookie HttpOnly curto (o endereço do tratador é fixo). Plano B: colar o link na caixa.

  private async renderMoodle(res: Response, req: Request, txn: string, userId: string, error?: string) {
    const base = baseUrl(req);
    const secure = base.startsWith('https://') ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${MOODLE_TXN_COOKIE}=${encodeURIComponent(txn)}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=900${secure}`,
    );
    this.html(
      res,
      moodlePage({
        txn,
        host: this.moodle.host(),
        launchUrl: await this.moodle.launchUrl(userId, txn),
        scheme: this.moodle.scheme(),
        captureUrl: `${base}/oauth/moodle/capture?u=%s`,
        error,
      }),
      error ? 400 : 200,
    );
  }

  @Get('oauth/connect/moodle')
  async moodleStart(@Query('txn') txn: string, @Query('erro') erro: string, @Req() req: Request, @Res() res: Response) {
    try {
      const p = await this.identified(txn);
      await this.renderMoodle(res, req, p.id, p.userId!, erro || undefined);
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  @Get('oauth/moodle/capture')
  async moodleCapture(@Query('u') u: string, @Req() req: Request, @Res() res: Response) {
    const txn = readCookie(req, MOODLE_TXN_COOKIE);
    let p;
    try {
      p = await this.identified(txn);
    } catch {
      return this.html(
        res,
        errorPage('Não encontrei o pedido de conexão. Volte à tela "Conectar o Moodle" e tente de novo.'),
        400,
      );
    }
    const t = encodeURIComponent(p.id);
    // Sempre redireciona: o endereço com o token sai da barra e do histórico desta aba.
    try {
      await this.moodle.connect(p.userId!, p.id, u ?? '');
      res.redirect(303, `/oauth/connect?txn=${t}&ok=moodle`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao conectar o Moodle';
      res.redirect(303, `/oauth/connect/moodle?txn=${t}&erro=${encodeURIComponent(msg)}`);
    }
  }

  @Post('oauth/connect/moodle')
  async moodleConnect(@Body() b: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    let p;
    try {
      p = await this.identified(b.txn);
    } catch (e) {
      return this.htmlError(res, e);
    }
    try {
      await this.moodle.connect(p.userId!, p.id, b.link ?? '');
      await this.renderConnect(res, p.id, p.userId!, 'Moodle conectado.');
    } catch (e) {
      await this.renderMoodle(res, req, p.id, p.userId!, e instanceof Error ? e.message : 'Falha ao conectar o Moodle');
    }
  }

  // ---- conectar SIGAA: login e senha validados agora, guardados em memória até o /token (o cofre cifra) ----

  @Post('oauth/connect/sigaa')
  async sigaaConnect(@Body() b: Record<string, string>, @Res() res: Response) {
    let p;
    try {
      p = await this.identified(b.txn);
    } catch (e) {
      return this.htmlError(res, e);
    }
    try {
      await this.sigaa.conectar(p.id, b.login ?? '', b.senha ?? '');
      await this.renderConnect(res, p.id, p.userId!, 'SIGAA validado: será guardado ao concluir.');
    } catch (e) {
      // A mensagem vem do SigaaLink (nunca contém a senha) e a tela não repete o que foi digitado.
      await this.renderConnect(res, p.id, p.userId!, undefined, e instanceof Error ? e.message : 'Falha ao conectar o SIGAA');
    }
  }

  // ---- /token ----

  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async token(@Body() body: TokenParams, @Res() res: Response) {
    try {
      res.json(await this.oauth.token(body ?? {}));
    } catch (e) {
      this.oauthJson(res, e);
    }
  }

  // ---- auxiliares ----

  private async identified(txn: string | undefined) {
    const p = await this.oauth.pending(txn);
    if (!p.userId) throw new OAuthError('access_denied', 'identifique-se primeiro', 403);
    return p;
  }

  private async renderConnect(res: Response, txn: string, userId: string, notice?: string, error?: string) {
    const [contas, m] = await Promise.all([
      this.classroom.enabled() ? this.classroom.contas(userId) : Promise.resolve(null),
      this.moodle.status(userId),
    ]);
    const classroom = contas === null ? null : { contas, apps: this.classroom.apps() };
    this.html(res, connectPage({ txn, classroom, moodle: m.connected, sigaaPendente: this.sigaa.pendente(txn), notice, error }));
  }

  /** Falha num vínculo não derruba a autorização: volta para a tela de conexões com o aviso. */
  private async backToConnect(res: Response, txn: string | undefined, e: unknown) {
    try {
      const p = await this.identified(txn);
      await this.renderConnect(res, p.id, p.userId!, undefined, e instanceof Error ? e.message : 'Falha ao conectar');
    } catch (inner) {
      this.htmlError(res, inner);
    }
  }

  private html(res: Response, body: string, status = 200) {
    res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.send(body);
  }

  private htmlError(res: Response, e: unknown) {
    const status = e instanceof OAuthError ? e.status : 500;
    this.html(res, errorPage(e instanceof OAuthError ? e.message : 'Erro inesperado'), status);
  }

  private oauthJson(res: Response, e: unknown) {
    if (e instanceof OAuthError) {
      res.status(e.status).json({ error: e.error, error_description: e.message });
    } else {
      res.status(500).json({ error: 'server_error' });
    }
  }
}
