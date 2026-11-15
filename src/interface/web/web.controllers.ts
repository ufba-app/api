import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ClientDirectory } from '../../application/oauth/client-directory';
import { CLIENT_DIRECTORY } from './web-tokens';
import { Inject } from '@nestjs/common';
import { AuthorizationRequests } from '../../application/web/authorization-requests.service';
import { AuthorizedApps } from '../../application/web/authorized-apps.service';
import { ConnectionsService } from '../../application/web/connections.service';
import { SigaaPasskeys } from '../../application/web/sigaa-passkeys.service';
import { SigaaPairings } from '../../application/web/sigaa-pairings.service';
import { AcademicImports, type AcademicState } from '../../application/academic/academic-imports';
import { parseUserAgent } from '../../application/web/user-agent';
import {
  ClassroomStartQuery,
  ConnectMoodleBody,
  ConnectSigaaBody,
  AcademicConsentBody,
  PERMISSION_KEYS,
  PermissionBody,
  CreatePairingBody,
  CreateSessionBody,
  DeliverPairingBody,
  UnlockSigaaBody,
  SaveSigaaPasskeyBody,
  SigaaPasskeySlotBody,
  parseInput,
} from '../../application/web/contract';
import { ApiError, invalidRequest, sessionExpired, type WebPrincipal } from '../../application/web/web-api';
import { WebSessionService } from '../../application/web/web-session.service';
import { PermissionsService } from '../../application/permissions/permissions.service';
import { z } from 'zod';
import { ApiErrorFilter } from './api-error.filter';
import {
  OptionalSessionGuard,
  Principal,
  SessionGuard,
  SessionTokenParam,
  checkCsrf,
  requireCustomHeader,
  clearSessionCookie,
  setSessionCookie,
  setSignedInMarker,
  webEnv,
} from './web-auth';

const must = (p: WebPrincipal | null): WebPrincipal => {
  if (!p) throw sessionExpired();
  return p;
};

const loginFailed = () =>
  new ApiError(400, 'invalid_request', 'Não foi possível concluir o login. Tente entrar de novo.');

/** Sessão do app web: trocar o code por cookie, sair, e quem está logado. */
@Controller()
@UseFilters(ApiErrorFilter)
export class SessionController {
  constructor(private readonly web: WebSessionService) {}

  @Post('session')
  async create(@Body() b: unknown, @Res() res: Response): Promise<void> {
    // Sem sessão ainda: o CSRF aqui é o mesmo (X-UFBA + Origin + JSON); o code+verifier de PKCE fazem o resto.
    checkCsrf(res.req);
    const input = parseInput(CreateSessionBody, b, loginFailed);
    const s = await this.web.createSession(input);
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
  me(@Principal() p: WebPrincipal | null, @Res({ passthrough: true }) res: Response) {
    const who = must(p);
    // Quem tinha sessão antes do marcador não o tem: reemite (idempotente, mesmos atributos, o que resta da sessão).
    if (who.sessionExpiresAt) {
      const restanteMs = who.sessionExpiresAt - Date.now();
      if (restanteMs > 0) setSignedInMarker(res, restanteMs);
    }
    return this.web.me(who);
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
  constructor(private readonly web: ConnectionsService) {}

  @Post('sigaa')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async sigaa(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.web.connectSigaa(must(p), parseInput(ConnectSigaaBody, b, invalidRequest));
  }

  @Delete('sigaa')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async sigaaOff(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.web.disconnectSigaa(must(p));
  }

  /** A DK do cofre para o navegador cifrá-la com a passkey (ativar). Só com o SIGAA aberto nesta sessão. */
  @Get('sigaa/key')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard)
  sigaaKey(@Principal() p: WebPrincipal | null, @Req() req: Request) {
    // GET que entrega a DK e gasta limite: exige X-UFBA (ver `requireCustomHeader`).
    requireCustomHeader(req);
    return this.web.sigaaKey(must(p));
  }

  /** Desbloqueio com a DK (da passkey ou do pacote do QR): o SIGAA fica conectado nesta sessão. */
  @Post('sigaa/unlock')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionGuard)
  async sigaaUnlock(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.web.unlockSigaa(must(p), parseInput(UnlockSigaaBody, b, invalidRequest).dk);
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
    await this.web.connectMoodle(must(p), parseInput(ConnectMoodleBody, b, invalidRequest));
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
  async classroomStart(@Principal() p: WebPrincipal | null, @Query() q: unknown, @Res() res: Response) {
    const { app } = parseInput(ClassroomStartQuery, q, invalidRequest);
    res.redirect(303, await this.web.classroomStart(must(p), app ?? 'ufba', webEnv().publicUrl));
  }

  @Delete('classroom/:email')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async classroomOff(@Principal() p: WebPrincipal | null, @Param('email') email: string): Promise<void> {
    await this.web.disconnectClassroom(must(p), email);
  }
}

/**
 * Chave mestra do SIGAA com passkey. O servidor só guarda e devolve o texto cifrado no navegador; o toque (PRF) e a
 * decifragem acontecem no navegador. O id da passkey vai no corpo (não na URL) ao pedir a cópia.
 */
@Controller('sigaa/passkey')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class SigaaPasskeyController {
  constructor(private readonly passkeys: SigaaPasskeys) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Principal() p: WebPrincipal | null) {
    const passkeys = await this.passkeys.list(must(p));
    return {
      passkeys: passkeys.map((k) => ({
        credentialId: k.credentialId,
        prfSalt: k.prfSalt,
        label: k.label,
        createdAt: k.createdAt.toISOString(),
        lastUnlockedAt: k.lastUnlockedAt ? k.lastUnlockedAt.toISOString() : null,
      })),
    };
  }

  @Post()
  @HttpCode(204)
  async save(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.passkeys.save(must(p), parseInput(SaveSigaaPasskeyBody, b, invalidRequest));
  }

  @Post('slot')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  slot(@Principal() p: WebPrincipal | null, @Body() b: unknown) {
    return this.passkeys.slot(must(p), parseInput(SigaaPasskeySlotBody, b, invalidRequest).credentialId);
  }

  @Delete(':credentialId')
  @HttpCode(204)
  async remove(@Principal() p: WebPrincipal | null, @Param('credentialId') credentialId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,1364}$/.test(credentialId)) throw invalidRequest();
    await this.passkeys.remove(must(p), credentialId);
  }
}

/**
 * Permissões por fonte: o que a pessoa libera para o Claude fazer (padrão desligado). Só a sessão do painel liga; nenhuma
 * ferramenta MCP altera permissões.
 */
@Controller('me/permissions')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Principal() p: WebPrincipal | null) {
    return { items: await this.permissions.list(must(p).userId) };
  }

  @Put(':key')
  @HttpCode(204)
  async set(@Principal() p: WebPrincipal | null, @Param('key') key: string, @Body() b: unknown): Promise<void> {
    const who = must(p);
    const k = parseInput(z.enum(PERMISSION_KEYS), key, invalidRequest);
    await this.permissions.set(who.userId, k, parseInput(PermissionBody, b, invalidRequest).enabled);
  }
}

const academicState = (s: AcademicState) => ({ ...s, importedAt: s.importedAt ? s.importedAt.toISOString() : null });

/**
 * Vida acadêmica (docs/specs/2026-11-15-vida-academica.md): consentimento, importação do histórico em segundo plano
 * (a IA só LÊ), confirmação da pessoa antes de gravar, e a grade do curso adequada ao currículo Ativo. Tudo apagável.
 */
@Controller('me/academic')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class AcademicController {
  constructor(private readonly academic: AcademicImports) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async state(@Principal() p: WebPrincipal | null) {
    return academicState(await this.academic.state(must(p)));
  }

  @Put('consent')
  @HttpCode(204)
  async consent(@Principal() p: WebPrincipal | null, @Body() b: unknown): Promise<void> {
    await this.academic.setConsent(must(p), parseInput(AcademicConsentBody, b, invalidRequest).accepted);
  }

  /** Dispara a importação em segundo plano; a tela acompanha por `GET /me/academic`. */
  @Post('import')
  @HttpCode(202)
  async start(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.academic.start(must(p));
  }

  @Post('confirm')
  @HttpCode(204)
  async confirm(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.academic.confirm(must(p));
  }

  @Delete()
  @HttpCode(204)
  async remove(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.academic.remove(must(p));
  }

  /** Descarta só o rascunho (ou a falha) de um Atualizar; o histórico gravado fica. */
  @Delete('draft')
  @HttpCode(204)
  async discardDraft(@Principal() p: WebPrincipal | null): Promise<void> {
    await this.academic.discardDraft(must(p));
  }

  /** A grade do curso (currículo Ativo) marcada com o que a pessoa já fez. Sempre uma estimativa. */
  @Get('curriculum')
  @Header('Cache-Control', 'no-store')
  curriculum(@Principal() p: WebPrincipal | null) {
    return this.academic.progress(must(p));
  }
}

/**
 * "Correio" do QR: o computador cria o pedido e lê o pacote uma vez; o celular da MESMA conta vê quem pede e entrega o
 * pacote lacrado. O servidor só repassa bytes que não consegue abrir.
 */
@Controller('pairings')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class PairingsController {
  constructor(private readonly pairings: SigaaPairings) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async create(@Principal() p: WebPrincipal | null, @Body() b: unknown, @Req() req: Request) {
    // O que a API VÊ (User-Agent) é gravado junto: o celular mostra isso, não o rótulo que o computador escreveu.
    const r = await this.pairings.create(must(p), parseInput(CreatePairingBody, b ?? {}, invalidRequest), parseUserAgent(req.headers['user-agent']));
    return { id: r.id, expiresAt: r.expiresAt.toISOString() };
  }

  @Get(':id/info')
  @Header('Cache-Control', 'no-store')
  async info(@Principal() p: WebPrincipal | null, @Param('id') id: string) {
    const i = await this.pairings.info(must(p), pairingId(id));
    return {
      label: i.label,
      client: i.client,
      seenBrowser: i.seenBrowser,
      seenOs: i.seenOs,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      delivered: i.delivered,
    };
  }

  @Post(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async deliver(@Principal() p: WebPrincipal | null, @Param('id') id: string, @Body() b: unknown): Promise<void> {
    await this.pairings.deliver(must(p), pairingId(id), parseInput(DeliverPairingBody, b, invalidRequest));
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  read(@Principal() p: WebPrincipal | null, @Param('id') id: string) {
    return this.pairings.read(must(p), pairingId(id));
  }
}

const pairingId = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw invalidRequest();
  return id;
};

@Controller('authorize/requests')
@UseFilters(ApiErrorFilter)
export class AuthorizeRequestsController {
  constructor(private readonly web: AuthorizationRequests) {}

  @Get(':id')
  @UseGuards(OptionalSessionGuard)
  info(@Param('id') id: string, @Principal() p: WebPrincipal | null) {
    return this.web.info(id, p);
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
  constructor(private readonly web: AuthorizedApps) {}

  @Get()
  @UseGuards(SessionGuard)
  list(@Principal() p: WebPrincipal | null) {
    return this.web.list(must(p));
  }

  @Delete(':clientId')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revoke(@Principal() p: WebPrincipal | null, @Param('clientId') clientId: string): Promise<void> {
    await this.web.revoke(must(p), clientId);
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
