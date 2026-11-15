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
import { ApiError, sessionExpired, type WebPrincipal } from '../../application/web/web-api';
import { OAUTH_SERVICE } from '../mcp/oauth/oauth-tokens';

/** Lista separada por vírgula, sem espaços nem barras finais (tolerante; a validação estrita é `validateOriginConfig`). */
function originList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Valida `WEB_ORIGIN` (lista, a primeira é a principal) e `AUTH_ORIGIN` (único) no boot: cada item precisa ser só
 * uma origem (esquema + host [+ porta]), sem barra final, sem curinga; em produção, https. Lança `Error`.
 */
export function validateOriginConfig(env: NodeJS.ProcessEnv, production: boolean): void {
  const check = (name: string, value: string): void => {
    if (value.includes('*')) throw new Error(`${name}: curinga não é permitido`);
    if (value.endsWith('/')) throw new Error(`${name}: sem barra final (${value})`);
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      throw new Error(`${name}: origem inválida (${value})`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name}: use http(s) (${value})`);
    if (u.origin !== value) throw new Error(`${name}: informe só a origem, sem caminho, usuário ou parâmetros (${value})`);
    if (production && u.protocol !== 'https:') throw new Error(`${name}: em produção use https (${value})`);
  };
  const raw = (env.WEB_ORIGIN ?? '').trim();
  if (raw) {
    const items = raw.split(',').map((o) => o.trim());
    if (items.some((o) => !o)) throw new Error('WEB_ORIGIN: item vazio na lista');
    items.forEach((o) => check('WEB_ORIGIN', o));
  }
  const auth = (env.AUTH_ORIGIN ?? '').trim();
  if (auth) {
    if (auth.includes(',')) throw new Error('AUTH_ORIGIN: aceita uma origem só');
    check('AUTH_ORIGIN', auth);
  }
}

/**
 * Origens do app web, lidas do ambiente a cada uso (os testes trocam o env). Todas as telas são do web; sem
 * `WEB_ORIGIN`, vale o web local de desenvolvimento (em produção o boot exige a variável, ver main.ts).
 * `WEB_ORIGIN` aceita lista (transição entre domínios do painel): a PRIMEIRA é a principal (`webOrigin`, usada em
 * qualquer redirect da API para o painel); todas entram em `origins` (CORS e checagem de Origin do CSRF).
 */
export function webEnv() {
  const publicUrl = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const webOrigins = originList(process.env.WEB_ORIGIN);
  if (!webOrigins.length) webOrigins.push('http://localhost:3001');
  const webOrigin = webOrigins[0];
  // Telas de login e autorização (ex.: https://auth.ufba.app). Sem AUTH_ORIGIN, ficam no próprio WEB_ORIGIN principal.
  const authOrigin = (process.env.AUTH_ORIGIN ?? '').replace(/\/+$/, '') || webOrigin;
  // Origens da casa: as únicas aceitas no CORS e na checagem de Origin do CSRF.
  const origins = [...new Set([...webOrigins, authOrigin].filter(Boolean))];
  const secure = publicUrl.startsWith('https://');
  return { publicUrl, webOrigin, webOrigins, authOrigin, origins, secure, cookieName: secure ? '__Host-ufba_session' : 'ufba_session' };
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

/** Nome do cookie MARCADOR (ver `setSignedInMarker`). */
export const SIGNED_IN_MARKER = 'ufba_signed_in';

/**
 * Domínio do marcador: o sufixo de rótulos que `WEB_ORIGIN`, `AUTH_ORIGIN` e `PUBLIC_URL` têm em comum (hoje
 * `.ufba.app`, para `meu.`, `auth.` e `api.`). Sem sufixo comum de pelo menos 2 rótulos (localhost, IP, origens de
 * sites diferentes), devolve `null` e o cookie fica sem `Domain` (só o host que o emitiu).
 */
export function markerDomain(env = webEnv()): string | null {
  const hosts = [...env.webOrigins, env.authOrigin, env.publicUrl].map((o) => {
    try {
      return new URL(o).hostname.toLowerCase();
    } catch {
      return '';
    }
  });
  if (hosts.some((h) => !h || /^[\d.]+$/.test(h) || h.includes(':'))) return null;
  const labels = hosts.map((h) => h.split('.').reverse());
  const common: string[] = [];
  for (let i = 0; labels.every((l) => l[i] !== undefined) && labels.every((l) => l[i] === labels[0][i]); i++) common.push(labels[0][i]);
  return common.length >= 2 ? `.${common.reverse().join('.')}` : null;
}

/**
 * Cookie MARCADOR `ufba_signed_in=1`: diz só "há uma sessão aberta" para quem fica na frente do painel decidir o
 * redirect sem piscar a tela. NÃO é segredo e NÃO autentica nada: a API valida apenas o cookie de sessão. É HttpOnly
 * (o JavaScript não precisa dele) e vive o mesmo tempo que a sessão. Domain compartilhado entre os subdomínios (ver
 * `markerDomain`); em http de desenvolvimento, sem Secure e sem Domain.
 */
function markerCookie(value: string, maxAgeSeconds: number): string {
  const { secure } = webEnv();
  const domain = markerDomain();
  return (
    `${SIGNED_IN_MARKER}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (domain ? `; Domain=${domain}` : '') +
    (secure ? '; Secure' : '')
  );
}

export function setSignedInMarker(res: Response, maxAgeMs: number): void {
  res.append('Set-Cookie', markerCookie('1', Math.floor(maxAgeMs / 1000)));
}

export function clearSignedInMarker(res: Response): void {
  res.append('Set-Cookie', markerCookie('', 0));
}

/** Cookie de sessão (sem Domain: só o host da API) e o marcador junto. */
export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  const { cookieName, secure } = webEnv();
  res.append(
    'Set-Cookie',
    `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}` +
      (secure ? '; Secure' : ''),
  );
  setSignedInMarker(res, maxAgeMs);
}

export function clearSessionCookie(res: Response): void {
  const { cookieName, secure } = webEnv();
  res.append('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : ''));
  clearSignedInMarker(res);
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
  return {
    userId: s.userId,
    clientId: s.clientId,
    ...(s.chave ? { chave: s.chave } : {}),
    ...(s.expiresAt ? { sessionExpiresAt: s.expiresAt } : {}),
  };
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
