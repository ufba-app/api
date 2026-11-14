import { Body, Controller, Get, Header, HttpCode, Inject, Optional, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { baseUrl } from './base-url';
import { GOOGLE_LINK, GoogleLinkPort, OAUTH_STORE, OAuthStore } from '../../../application/oauth/oauth-ports';
import { DEVICE_GRANT, DeviceAuthorizations } from '../../../application/memory/device-authorizations';
import { AuthorizeParams, OAuthError, OAuthService, TokenParams } from '../../../application/oauth/oauth.service';
import { ConnectionsService } from '../../../application/web/connections.service';
import { WEB_CLIENT_ID } from '../../../application/web/web-api';
import { sessionToken, webEnv } from '../../web/web-auth';

export { OAUTH_SERVICE } from './oauth-tokens';
import { OAUTH_SERVICE } from './oauth-tokens';

const errorParam = (req: Request): string | undefined =>
  typeof req.query.error === 'string' && req.query.error ? req.query.error : undefined;

/**
 * Servidor OAuth 2.1 do serviço: só protocolo (metadados, registro, /authorize, /token e as voltas do Google).
 * Nenhuma tela: login, consentimento e conexões são do app web (`AUTH_ORIGIN`/`WEB_ORIGIN`); aqui só se redireciona.
 */
@Controller()
export class OAuthController {
  constructor(
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Inject(OAUTH_STORE) private readonly store: OAuthStore,
    @Inject(GOOGLE_LINK) private readonly google: GoogleLinkPort,
    @Optional() private readonly connections?: ConnectionsService,
    @Optional() private readonly device?: DeviceAuthorizations,
  ) {}

  /** Erro de /authorize: página de erro do web (nunca volta ao cliente, que não é confiável aqui). */
  private webError(res: Response, e: unknown) {
    const message = e instanceof OAuthError ? e.message : 'Erro inesperado';
    const error = e instanceof OAuthError ? e.error : 'server_error';
    const q = new URLSearchParams({ error, message });
    res.redirect(303, `${webEnv().authOrigin}/authorize/error?${q.toString()}`);
  }

  /** Volta ao web (cliente da casa) com erro e descrição pt-BR prontos para mostrar. */
  private async webLoginError(res: Response, p: { id: string; redirectUri: string; state?: string }, msg: string) {
    await this.store.deletePending(p.id);
    const url = new URL(p.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', msg);
    if (p.state) url.searchParams.set('state', p.state);
    res.redirect(303, url.toString());
  }

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
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        ...(this.device ? [DEVICE_GRANT] : []),
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      ...(this.device ? { device_authorization_endpoint: `${base}/oauth/device_authorization` } : {}),
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

  // ---- /authorize: só redireciona (Google para o web; tela de consentimento do web para os demais) ----

  @Get('authorize')
  async authorize(@Query() q: AuthorizeParams, @Req() req: Request, @Res() res: Response) {
    try {
      const p = await this.oauth.begin(q);
      if (p.clientId === WEB_CLIENT_ID) {
        // Login do próprio web: direto para o Google (só @ufba.br); na volta, emite o code sem consentimento.
        if (!this.google.loginEnabled()) throw new OAuthError('server_error', 'Login com Google não configurado', 500);
        return res.redirect(303, await this.google.startLoginUrl(`${baseUrl(req)}/oauth/callback/google`, p.id));
      }
      return res.redirect(303, `${webEnv().authOrigin}/authorize?request=${encodeURIComponent(p.id)}`);
    } catch (e) {
      return this.webError(res, e);
    }
  }

  // ---- voltas do Google: login do web e Classroom @ufba.br (mesmo redirect do app interno) ----

  @Get('oauth/callback/google')
  async googleCallback(@Query('code') code: string, @Query('state') state: string, @Req() req: Request, @Res() res: Response) {
    // Classroom @ufba.br conectado pelo app web (state `web.…`, preso à sessão).
    if (this.connections?.isWebState(state)) {
      const session = await this.sessionUserId(req);
      return res.redirect(
        303,
        await this.connections.classroomCallback({ state, code, error: errorParam(req) }, session, baseUrl(req)),
      );
    }
    let p;
    try {
      p = await this.oauth.pending(state);
      if (p.clientId !== WEB_CLIENT_ID) throw new OAuthError('invalid_request', 'Pedido de login inválido.', 400);
    } catch (e) {
      return this.webError(res, e);
    }
    // Login do app web: identifica e emite o code direto (cliente da casa, sem consentimento).
    if (errorParam(req)) return this.webLoginError(res, p, 'Login cancelado na tela do Google.');
    try {
      const { email } = await this.google.handleLoginCallback(code, `${baseUrl(req)}/oauth/callback/google`);
      await this.oauth.identify(p.id, email);
      return res.redirect(303, await this.oauth.complete(p.id));
    } catch (e) {
      return this.webLoginError(res, p, e instanceof Error ? e.message : 'Falha ao entrar com o Google.');
    }
  }

  /** Classroom de convidado (gmail), conectado pelo app web. */
  @Get('oauth/callback/classroom')
  async classroomCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.connections?.isWebState(state)) {
      return this.webError(res, new OAuthError('invalid_request', 'Pedido de conexão inválido.', 400));
    }
    const session = await this.sessionUserId(req);
    return res.redirect(303, await this.connections.classroomCallback({ state, code, error }, session, baseUrl(req)));
  }

  // ---- login de dispositivo (RFC 8628): só o instalador da memória, `ufba-installer` e `memory:connect` ----

  @Post('oauth/device_authorization')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async deviceAuthorization(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      if (!this.device) throw new OAuthError('unsupported_grant_type', 'login de dispositivo indisponível', 404);
      const s = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string) : undefined);
      res.json(
        await this.device.start({
          clientId: s('client_id'),
          scope: s('scope'),
          computerName: s('computer_name'),
          os: s('os'),
          ip: req.ip ?? null,
        }),
      );
    } catch (e) {
      this.oauthJson(res, e);
    }
  }

  // ---- /token ----

  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async token(@Body() body: TokenParams, @Res() res: Response) {
    try {
      if (body?.grant_type === DEVICE_GRANT) {
        if (!this.device) throw new OAuthError('unsupported_grant_type', 'login de dispositivo indisponível');
        const b = body as unknown as Record<string, string | undefined>;
        res.json(await this.device.poll({ deviceCode: b.device_code, clientId: b.client_id }));
        return;
      }
      res.json(await this.oauth.token(body ?? {}));
    } catch (e) {
      this.oauthJson(res, e);
    }
  }

  // ---- auxiliares ----

  /** Dono do cookie de sessão do web, se houver (para a volta do Google ao conectar o Classroom). */
  private async sessionUserId(req: Request): Promise<string | undefined> {
    const token = sessionToken(req);
    return token ? (await this.oauth.verifySession(token))?.userId : undefined;
  }

  private oauthJson(res: Response, e: unknown) {
    if (e instanceof OAuthError) {
      res.status(e.status).json({ error: e.error, error_description: e.message });
    } else {
      res.status(500).json({ error: 'server_error' });
    }
  }
}
