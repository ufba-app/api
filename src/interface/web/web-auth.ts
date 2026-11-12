import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AUTHENTICATORS, type Authenticator } from '../../application/ports/authenticator';
import type { OAuthService } from '../../application/oauth/oauth.service';
import { ApiError, sessionExpired, type WebPrincipal } from '../../application/web/web.service';
import { OAUTH_SERVICE } from '../mcp/oauth/oauth-tokens';

/** Configuração do modo web, lida do ambiente a cada uso (os testes trocam o env). */
export function webEnv() {
  const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
  // Telas de login e autorização (ex.: https://auth.ufba.app). Sem AUTH_ORIGIN, ficam no próprio WEB_ORIGIN.
  const authOrigin = (process.env.AUTH_ORIGIN ?? '').replace(/\/+$/, '') || webOrigin;
  // Origens da casa: as únicas aceitas no CORS e na checagem de Origin do CSRF.
  const origins = [...new Set([webOrigin, authOrigin].filter(Boolean))];
  const secure = publicUrl.startsWith('https://');
  return { publicUrl, webOrigin, authOrigin, origins, secure, cookieName: secure ? '__Host-ufba_session' : 'ufba_session' };
}

export function readCookie(req: Request, name: string): string | undefined {
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

export function sessionToken(req: Request): string | undefined {
  return readCookie(req, webEnv().cookieName);
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  const { cookieName, secure } = webEnv();
  res.setHeader(
    'Set-Cookie',
    `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}` +
      (secure ? '; Secure' : ''),
  );
}

export function clearSessionCookie(res: Response): void {
  const { cookieName, secure } = webEnv();
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : ''));
}

type WebRequest = Request & { web?: WebPrincipal; webToken?: string };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF de rotas com cookie: SameSite=Lax + `X-UFBA: 1` (força preflight) + `Origin` de uma das origens da casa (painel ou auth) + JSON no corpo.
 */
export function checkCsrf(req: Request): void {
  if (SAFE.has(req.method)) return;
  const { origins } = webEnv();
  const origin = req.headers.origin;
  const json = String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
  const needsJson = req.method !== 'DELETE';
  if (req.headers['x-ufba'] !== '1' || !origin || !origins.includes(origin) || (needsJson && !json)) {
    throw new ApiError(403, 'csrf_rejected', 'Pedido recusado por segurança. Recarregue a página e tente de novo.');
  }
}

async function fromCookie(oauth: OAuthService, req: WebRequest): Promise<WebPrincipal | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const s = await oauth.verifySession(token);
  if (!s) return null;
  req.webToken = token;
  return { userId: s.userId, clientId: s.clientId, ...(s.chave ? { chave: s.chave } : {}) };
}

/** Exige o cookie de sessão do app web (e CSRF nas rotas que mudam estado). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WebRequest>();
    checkCsrf(req);
    const p = await fromCookie(this.oauth, req);
    if (!p) throw sessionExpired();
    req.web = p;
    return true;
  }
}

/** Sessão se houver; nunca recusa (tela de autorização antes do login). */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WebRequest>();
    req.web = (await fromCookie(this.oauth, req)) ?? undefined;
    return true;
  }
}

/**
 * Rotas de dados: `Authorization: Bearer` (clientes OAuth, chave de API) OU cookie de sessão do web. Com Bearer não
 * há CSRF (o navegador não manda Bearer sozinho).
 */
@Injectable()
export class DataGuard implements CanActivate {
  constructor(
    @Inject(OAUTH_SERVICE) private readonly oauth: OAuthService,
    @Optional() @Inject(AUTHENTICATORS) private readonly authenticators: Authenticator[] = [],
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<WebRequest>();
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.trim()) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (m) {
        for (const a of this.authenticators) {
          const found = await a.authenticate(m[1]);
          if (found) {
            req.web = {
              userId: found.userId,
              clientId: found.clientId ?? '',
              ...(found.chave ? { chave: found.chave } : {}),
            };
            return true;
          }
        }
      }
      throw new ApiError(401, 'session_expired', 'Credencial inválida ou expirada.');
    }
    checkCsrf(req);
    const p = await fromCookie(this.oauth, req);
    if (!p) throw sessionExpired();
    req.web = p;
    return true;
  }
}

/** Quem chama (depois de um dos guards acima). */
export const Principal = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): WebPrincipal | null => ctx.switchToHttp().getRequest<WebRequest>().web ?? null,
);

/** Token de sessão em claro (só para `DELETE /session`). */
export const SessionTokenParam = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string | undefined => ctx.switchToHttp().getRequest<WebRequest>().webToken,
);
