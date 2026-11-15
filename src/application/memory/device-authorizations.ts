import { randomInt } from 'node:crypto';
import { OAuthError } from '../oauth/oauth.service';
import { randomToken, sha256Base64Url } from '../oauth/pkce';
import { ApiError } from '../web/web-api';
import { DeviceAuthorizationRecord, DeviceAuthorizationRepository } from './device-ports';
import { RateWindow } from './rate-window';

export const INSTALLER_CLIENT_ID = 'ufba-installer';
export const CONNECT_SCOPE = 'memory:connect';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export const DEVICE_TTL_MS = 10 * 60_000;
export const TOKEN_TTL_MS = 10 * 60_000;
const INTERVAL_S = 5;
const MAX_POLLS = 120;
/** 20 símbolos sem ambiguidade (sem vogais, 0/1, Y): 20^8 ≈ 2,6×10^10 códigos. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const MAX_ACTIVE_PER_IP = 20;

const OSES = ['windows', 'macos', 'linux'] as const;
export type ComputerOs = (typeof OSES)[number];
export const asOs = (v: unknown): ComputerOs | null => (OSES as readonly string[]).includes(String(v)) ? (v as ComputerOs) : null;

/** Nome sugerido pelo instalador: não é confiável, então sem caracteres de controle e com tamanho limitado. */
export function cleanName(v: unknown, max = 60): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
}

export function newUserCode(): string {
  let c = '';
  for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return c;
}

export const formatUserCode = (c: string): string => `${c.slice(0, 4)}-${c.slice(4)}`;

/** `bcdf-ghjk`, ` BCDFGHJK ` etc. → `BCDFGHJK`; null se não for um código possível. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  return c.length === 8 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

/** IP sem o final (200.128.x.x / 2001:db8::): serve para mostrar e para comparar redes, sem expor o endereço inteiro. */
export function ipHint(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}::`;
  return null;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceLookup {
  clientName: string;
  computerName: string | null;
  os: string | null;
  requestedAt: Date;
  approxLocation: string | null;
  /** A rede de quem aprova é bem diferente da de quem pediu: a tela destaca o aviso (não bloqueia). */
  ipDiffers: boolean;
}

export interface DeviceTokenGrant {
  userId: string;
  deviceCodeHash: string;
}

export interface DeviceOptions {
  now?: () => number;
  /** Base da tela de aprovação (o painel, `WEB_ORIGIN`). */
  webOrigin: () => string;
}

/**
 * Login de dispositivo (RFC 8628) do instalador da memória. Códigos e o token curto só existem como hash. O token
 * curto (10 min, escopo `memory:connect`) NÃO é um token OAuth do serviço: vive só aqui, nunca abre o /mcp nem o SIGAA.
 */
export class DeviceAuthorizations {
  private readonly now: () => number;
  private readonly startsPerIp: RateWindow;
  private readonly badLookupsPerUser: RateWindow;
  private readonly badLookupsPerIp: RateWindow;

  constructor(
    private readonly repo: DeviceAuthorizationRepository,
    private readonly opts: DeviceOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.startsPerIp = new RateWindow(10, 60 * 60_000, this.now);
    this.badLookupsPerUser = new RateWindow(5, 10 * 60_000, this.now);
    this.badLookupsPerIp = new RateWindow(20, 10 * 60_000, this.now);
  }

  // ---- instalador: POST /oauth/device_authorization ----

  async start(input: {
    clientId?: string;
    scope?: string;
    computerName?: string;
    os?: string;
    ip?: string | null;
  }): Promise<DeviceStart> {
    if (input.clientId !== INSTALLER_CLIENT_ID) throw new OAuthError('invalid_client', 'client_id desconhecido');
    if (input.scope !== CONNECT_SCOPE) throw new OAuthError('invalid_scope', 'use scope=memory:connect');
    const ip = input.ip ?? null;
    if (ip) {
      if (!this.startsPerIp.take(ip)) throw new OAuthError('slow_down', 'muitos pedidos deste endereço', 429);
      if ((await this.repo.countActiveByIp(ip, new Date(this.now()))) >= MAX_ACTIVE_PER_IP) {
        throw new OAuthError('slow_down', 'muitos pedidos em aberto deste endereço', 429);
      }
    }
    await this.repo.deleteExpired(new Date(this.now() - 60 * 60_000));

    const deviceCode = randomToken(32);
    const createdAt = new Date(this.now());
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      const ok = await this.repo.create({
        deviceCodeHash: sha256Base64Url(deviceCode),
        userCodeHash: sha256Base64Url(userCode),
        clientId: INSTALLER_CLIENT_ID,
        scope: CONNECT_SCOPE,
        computerName: cleanName(input.computerName),
        os: asOs(input.os),
        requestIp: ip,
        status: 'pending',
        userId: null,
        intervalSec: INTERVAL_S,
        lastPolledAt: null,
        pollCount: 0,
        tokenHash: null,
        tokenExpiresAt: null,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + DEVICE_TTL_MS),
      });
      if (ok) {
        const base = `${this.opts.webOrigin()}/device`;
        const shown = formatUserCode(userCode);
        return {
          device_code: deviceCode,
          user_code: shown,
          verification_uri: base,
          verification_uri_complete: `${base}?user_code=${shown}`,
          expires_in: DEVICE_TTL_MS / 1000,
          interval: INTERVAL_S,
        };
      }
    }
    throw new OAuthError('server_error', 'não foi possível gerar o código', 500);
  }

  // ---- instalador: POST /token (grant device_code) ----

  async poll(p: { deviceCode?: string; clientId?: string }): Promise<{
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    scope: string;
  }> {
    const rec = p.deviceCode ? await this.repo.findByDeviceHash(sha256Base64Url(p.deviceCode)) : null;
    if (!rec || rec.clientId !== p.clientId) throw new OAuthError('invalid_grant', 'device_code inválido');
    const now = this.now();
    if (rec.expiresAt.getTime() <= now || rec.pollCount >= MAX_POLLS) {
      throw new OAuthError('expired_token', 'o código expirou; peça outro');
    }
    if (rec.status === 'issued' || rec.status === 'consumed') {
      throw new OAuthError('invalid_grant', 'device_code já usado');
    }
    if (rec.lastPolledAt && now - rec.lastPolledAt.getTime() < rec.intervalSec * 1000) {
      await this.repo.touchPoll(rec.deviceCodeHash, {
        lastPolledAt: new Date(now),
        intervalSec: rec.intervalSec + 5,
        pollCount: rec.pollCount + 1,
      });
      throw new OAuthError('slow_down', 'consulte mais devagar');
    }
    await this.repo.touchPoll(rec.deviceCodeHash, {
      lastPolledAt: new Date(now),
      intervalSec: rec.intervalSec,
      pollCount: rec.pollCount + 1,
    });
    if (rec.status === 'pending') throw new OAuthError('authorization_pending', 'aguardando a aprovação');
    if (rec.status === 'denied') throw new OAuthError('access_denied', 'a pessoa negou o pedido');

    const token = randomToken(32);
    const won = await this.repo.issueToken(
      rec.deviceCodeHash,
      sha256Base64Url(token),
      new Date(now + TOKEN_TTL_MS),
      new Date(now),
    );
    if (!won) throw new OAuthError('invalid_grant', 'device_code já usado');
    return { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_MS / 1000, scope: CONNECT_SCOPE };
  }

  // ---- tela /device (sessão do web) ----

  async lookup(userId: string, ip: string | null, userCode: unknown): Promise<DeviceLookup> {
    const rec = await this.findPending(userId, ip, userCode);
    const hint = ipHint(rec.requestIp);
    const mine = ipHint(ip);
    return {
      clientName: 'Instalador da memória da ufba.app',
      computerName: rec.computerName,
      os: rec.os,
      requestedAt: rec.createdAt,
      approxLocation: hint ? `rede ${hint}` : null,
      ipDiffers: Boolean(hint && mine && hint !== mine),
    };
  }

  async decide(userId: string, ip: string | null, userCode: unknown, decision: 'approve' | 'deny'): Promise<void> {
    const rec = await this.findPending(userId, ip, userCode);
    const ok = await this.repo.decide(
      rec.userCodeHash,
      userId,
      decision === 'approve' ? 'approved' : 'denied',
      new Date(this.now()),
    );
    if (!ok) throw invalidCode();
  }

  /** Pedido pendente e válido do código; erro conta contra o limite de palpites (por pessoa e por IP). */
  private async findPending(userId: string, ip: string | null, userCode: unknown): Promise<DeviceAuthorizationRecord> {
    if (this.badLookupsPerUser.isFull(userId) || (ip && this.badLookupsPerIp.isFull(ip))) {
      throw new ApiError(429, 'too_many_attempts', 'Muitas tentativas com código errado. Aguarde alguns minutos.');
    }
    const code = normalizeUserCode(userCode);
    const rec = code ? await this.repo.findByUserHash(sha256Base64Url(code)) : null;
    if (!rec || rec.status !== 'pending') {
      this.badLookupsPerUser.take(userId);
      if (ip) this.badLookupsPerIp.take(ip);
      throw invalidCode();
    }
    if (rec.expiresAt.getTime() <= this.now()) {
      throw new ApiError(410, 'device_code_expired', 'Este código expirou. Rode o instalador de novo para ver um novo.');
    }
    return rec;
  }

  // ---- instalador: Bearer = token curto ----

  /** Token curto válido (emitido, não expirado, não consumido) → quem aprovou. */
  async verifyToken(token: string): Promise<DeviceTokenGrant | null> {
    const rec = await this.repo.findByTokenHash(sha256Base64Url(token));
    if (!rec || rec.status !== 'issued' || !rec.userId || !rec.tokenExpiresAt) return null;
    if (rec.tokenExpiresAt.getTime() <= this.now()) return null;
    return { userId: rec.userId, deviceCodeHash: rec.deviceCodeHash };
  }

  /** O instalador confirmou a gravação da chave: só agora o token é consumido (correção 1 do spike). */
  consume(grant: DeviceTokenGrant): Promise<boolean> {
    return this.repo.consume(grant.deviceCodeHash, new Date(this.now()));
  }
}

const invalidCode = () =>
  new ApiError(404, 'device_code_invalid', 'Código não encontrado. Confira o que apareceu no seu terminal.');
