import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { baseUrl } from './base-url';
import {
  GOOGLE_LINK,
  GoogleLinkPort,
  MOODLE_LINK,
  MoodleLinkPort,
  OAUTH_STORE,
  OAuthStore,
} from '../../../application/oauth/oauth-ports';
import { AuthorizeParams, OAuthError, OAuthService, TokenParams } from '../../../application/oauth/oauth.service';
import { connectPage, errorPage, identifyPage } from './pages';
import { timingSafeEqual } from 'node:crypto';

export const OAUTH_SERVICE = Symbol('OAUTH_SERVICE');

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
      this.html(res, identifyPage(p.id, client?.clientName, !!process.env.OAUTH_AUTHORIZE_SECRET));
    } catch (e) {
      this.htmlError(res, e);
    }
  }

  @Post('authorize')
  async authorizePost(@Body() b: Record<string, string>, @Res() res: Response) {
    try {
      if (b.acao === 'negar') return res.redirect(303, await this.oauth.deny(b.txn));
      if (b.acao === 'concluir') return res.redirect(303, await this.oauth.complete(b.txn));

      // identificar
      const pending = await this.oauth.pending(b.txn);
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

  // ---- conectar Google ----

  @Get('oauth/connect/google')
  async googleStart(@Query('txn') txn: string, @Req() req: Request, @Res() res: Response) {
    try {
      const p = await this.identified(txn);
      const url = await this.google.startUrl(p.userId!, `${baseUrl(req)}/oauth/callback/google`, p.id);
      res.redirect(303, url);
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  @Get('oauth/callback/google')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') txn: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const p = await this.identified(txn);
      await this.google.handleCallback(p.userId!, code, `${baseUrl(req)}/oauth/callback/google`);
      await this.renderConnect(res, p.id, p.userId!, 'Google conectado.');
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  // ---- conectar Moodle (SSO via MoodleLinkPort; sem campo para colar token) ----

  @Get('oauth/connect/moodle')
  async moodleStart(@Query('txn') txn: string, @Req() req: Request, @Res() res: Response) {
    try {
      const p = await this.identified(txn);
      const url = await this.moodle.startUrl(p.userId!, `${baseUrl(req)}/oauth/return/moodle?txn=${encodeURIComponent(p.id)}`);
      res.redirect(303, url);
    } catch (e) {
      await this.backToConnect(res, txn, e);
    }
  }

  @Get('oauth/return/moodle')
  async moodleReturn(@Query('txn') txn: string, @Query('payload') payload: string, @Res() res: Response) {
    try {
      const p = await this.identified(txn);
      await this.moodle.handleReturn(p.userId!, payload ?? '');
      await this.renderConnect(res, p.id, p.userId!, 'Moodle conectado.');
    } catch (e) {
      await this.backToConnect(res, txn, e);
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
    const [g, m] = await Promise.all([this.google.status(userId), this.moodle.status(userId)]);
    this.html(res, connectPage({ txn, google: g.connected, moodle: m.connected, notice, error }));
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
