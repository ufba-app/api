import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ClientDirectory } from '../../application/oauth/client-directory';
import { CLIENT_DIRECTORY } from './web-tokens';
import { Inject } from '@nestjs/common';
import { WebService, sessionExpired, type WebPrincipal } from '../../application/web/web.service';
import { ApiErrorFilter } from './api-error.filter';
import {
  OptionalSessionGuard,
  Principal,
  SessionGuard,
  SessionTokenParam,
  checkCsrf,
  clearSessionCookie,
  setSessionCookie,
  webEnv,
} from './web-auth';

type Json = Record<string, unknown>;
const body = (b: unknown): Json => (b && typeof b === 'object' ? (b as Json) : {});
const must = (p: WebPrincipal | null): WebPrincipal => {
  if (!p) throw sessionExpired();
  return p;
};

/** Sessão do app web: trocar o code por cookie, sair, e quem está logado. */
@Controller()
@UseFilters(ApiErrorFilter)
export class SessionController {
  constructor(private readonly web: WebService) {}

  @Post('session')
  async create(@Body() b: unknown, @Res() res: Response): Promise<void> {
    // Sem sessão ainda: o CSRF aqui é o mesmo (X-UFBA + Origin + JSON); o code+verifier de PKCE fazem o resto.
    checkCsrf(res.req);
    const s = await this.web.createSession(body(b));
    setSessionCookie(res, s.token, s.maxAgeMs);
    res.setHeader('Cache-Control', 'no-store');
    res.status(204).end();
  }

  @Delete('session')
  @UseGuards(SessionGuard)
  async remove(
    @Principal() p: WebPrincipal | null,
    @SessionTokenParam() token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (token) await this.web.signOut(must(p), token);
    clearSessionCookie(res);
    res.status(204).end();
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Principal() p: WebPrincipal | null) {
    return this.web.me(must(p));
  }

  /** Excluir a conta (e tudo dela, inclusive os vínculos com SIGAA e AVA). A tela confirma antes de chamar. */
  @Delete('me')
  @UseGuards(SessionGuard)
  async removeAccount(@Principal() p: WebPrincipal | null, @Res() res: Response): Promise<void> {
    await this.web.deleteAccount(must(p));
    clearSessionCookie(res);
    res.status(204).end();
  }
}

@Controller('connections')
@UseFilters(ApiErrorFilter)
export class ConnectionsController {
  constructor(private readonly web: WebService) {}

  @Post('sigaa')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async sigaa(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.web.connectSigaa(must(p), body(b));
  }

  @Delete('sigaa')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async sigaaOff(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.web.disconnectSigaa(must(p));
  }

  @Post('moodle/start')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  moodleStart(@Principal() p: WebPrincipal | null) {
    return this.web.moodleStart(must(p));
  }

  @Post('moodle')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async moodle(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.web.connectMoodle(must(p), body(b));
  }

  @Delete('moodle')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async moodleOff(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.web.disconnectMoodle(must(p));
  }

  /** Navegação de página inteira (não fetch): redireciona para o Google. */
  @Get('classroom/start')
  @UseGuards(SessionGuard)
  async classroomStart(@Principal() p: WebPrincipal | null, @Query('app') app: string, @Res() res: Response) {
    res.redirect(303, await this.web.classroomStart(must(p), app, webEnv().publicUrl));
  }

  @Delete('classroom/:email')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async classroomOff(@Principal() p: WebPrincipal | null, @Param('email') email: string): Promise<void> {
    await this.web.disconnectClassroom(must(p), email);
  }
}

@Controller('authorize/requests')
@UseFilters(ApiErrorFilter)
export class AuthorizeRequestsController {
  constructor(private readonly web: WebService) {}

  @Get(':id')
  @UseGuards(OptionalSessionGuard)
  info(@Param('id') id: string, @Principal() p: WebPrincipal | null) {
    return this.web.requestInfo(id, p);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  approve(@Param('id') id: string, @Principal() p: WebPrincipal | null) {
    return this.web.approve(id, must(p));
  }

  @Post(':id/deny')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  deny(@Param('id') id: string, @Principal() p: WebPrincipal | null) {
    return this.web.deny(id, must(p));
  }
}

@Controller('authorized-apps')
@UseFilters(ApiErrorFilter)
export class AuthorizedAppsController {
  constructor(private readonly web: WebService) {}

  @Get()
  @UseGuards(SessionGuard)
  list(@Principal() p: WebPrincipal | null) {
    return this.web.authorizedApps(must(p));
  }

  @Delete(':clientId')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revoke(@Principal() p: WebPrincipal | null, @Param('clientId') clientId: string): Promise<void> {
    await this.web.revokeApp(must(p), clientId);
  }
}

/** Logos de clientes: baixados e validados pela API (o navegador nunca carrega imagem de terceiros). */
@Controller('client-logos')
@UseFilters(ApiErrorFilter)
export class ClientLogosController {
  constructor(@Inject(CLIENT_DIRECTORY) private readonly clients: ClientDirectory) {}

  @Get(':hash')
  async logo(@Param('hash') hash: string, @Res() res: Response): Promise<void> {
    const logo = await this.clients.logo(hash);
    if (!logo) {
      res.status(404).json({ error: 'not_found', message: 'Logo não encontrado.' });
      return;
    }
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.status(200).send(logo.bytes);
  }
}
