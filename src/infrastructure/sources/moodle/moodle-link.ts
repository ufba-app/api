import { createHmac } from 'node:crypto';
import type { IdentityService } from '../../../application/identity/identity.service';
import type { LinkStatus, MoodleLinkPort } from '../../../application/oauth/oauth-ports';
import type { SourceAccountRepository } from '../../../application/ports/repositories';
import { deriveKey } from '../../crypto/keys';
import { MoodleClient, MoodleError, type FetchFn } from './moodle-client';
import { buildLaunchUrl, extractReturnedToken, parseReturnedToken, verifyPassport } from './token-launch';

export class MoodleLinkError extends Error {}

const DEFAULT_SITE = 'https://ava.ufba.br';
/**
 * `web+ufba`: navegadores só deixam um site tratar esquemas `web+...` (registerProtocolHandler), e o AVA aceita
 * esse urlscheme (testado em 04/11/2026). Com `moodlemobile` o token ia para o Windows e se perdia.
 */
const DEFAULT_SCHEME = 'web+ufba';
const PASSPORT_KEY_PURPOSE = 'ufba-platform/moodle-passport/v1';

/**
 * Vínculo do Moodle pela tela de /authorize, com o login feito no navegador da própria pessoa:
 *  1. `launchUrl`: link do `launch.php` do Moodle, com um passport derivado (HMAC) de usuário + transação, sem estado;
 *  2. a pessoa faz o login institucional lá e o Moodle termina em `moodlemobile://token=<base64>`;
 *  3. ela copia esse link e cola na tela; `connect` extrai o token, CONFERE a assinatura do passport, valida o token
 *     chamando o Moodle e guarda só o `wstoken`, cifrado (o `privatetoken` é descartado). O token nunca é logado.
 */
export class MoodleLink implements MoodleLinkPort {
  private readonly siteUrl: string;
  private readonly fixedKey?: string;
  private readonly client: MoodleClient;
  private readonly urlScheme: string;

  constructor(
    private readonly accounts: SourceAccountRepository,
    private readonly identity: IdentityService,
    cfg: { siteUrl?: string; passportKey?: string; urlScheme?: string; fetchFn?: FetchFn } = {},
  ) {
    this.siteUrl = (cfg.siteUrl ?? process.env.MOODLE_SITE_URL ?? DEFAULT_SITE).replace(/\/+$/, '');
    this.urlScheme = cfg.urlScheme ?? process.env.MOODLE_URL_SCHEME ?? DEFAULT_SCHEME;
    this.fixedKey = cfg.passportKey;
    this.client = new MoodleClient(cfg.fetchFn);
  }

  /** Chave só do passport, derivada da `SECRETS_KEY` (HKDF); a mestra fica só para cifrar os tokens guardados. */
  private key(): string | Buffer {
    if (this.fixedKey) return this.fixedKey;
    try {
      return deriveKey(process.env.SECRETS_KEY, PASSPORT_KEY_PURPOSE);
    } catch {
      throw new MoodleLinkError('Servidor sem SECRETS_KEY válida: não dá para conectar o Moodle');
    }
  }

  async status(userId: string): Promise<LinkStatus> {
    const accounts = await this.accounts.findByUserAndProvider(userId, 'MOODLE');
    return { connected: accounts.some((a) => a.secret !== null) };
  }

  host(): string {
    return new URL(this.siteUrl).host;
  }

  scheme(): string {
    return this.urlScheme;
  }

  private passport(userId: string, txn: string): string {
    return createHmac('sha256', this.key()).update(`moodle-passport:${userId}:${txn}`).digest('hex').slice(0, 24);
  }

  async launchUrl(userId: string, txn: string): Promise<string> {
    return buildLaunchUrl(this.siteUrl, this.passport(userId, txn), this.urlScheme);
  }

  async connect(userId: string, txn: string, pasted: string): Promise<void> {
    const text = (pasted ?? '').trim();
    // Aceita o link inteiro (moodlemobile://token=...) ou só o trecho base64.
    const b64 = extractReturnedToken(text) ?? (/^[A-Za-z0-9+/=_-]{16,}$/.test(text) ? text : undefined);
    if (!b64) throw new MoodleLinkError(`Não encontrei o token nesse texto. Cole o link que começa com ${this.urlScheme}://token=`);

    let parsed;
    try {
      parsed = parseReturnedToken(b64);
    } catch {
      throw new MoodleLinkError('O link colado está incompleto ou em formato inesperado. Copie de novo, inteiro.');
    }
    if (!verifyPassport(parsed.signature, this.siteUrl, this.passport(userId, txn))) {
      throw new MoodleLinkError('Esse link não é deste pedido. Refaça desde o passo 1 e cole o link novo.');
    }

    // Prova de que o token funciona e de quem é (accountKey = host:usuário).
    const access = { baseUrl: this.siteUrl, token: parsed.wstoken };
    let username: string;
    try {
      const info = await this.client.call<{ username?: string }>(access, 'core_webservice_get_site_info');
      if (!info.username) throw new MoodleLinkError('O Moodle não informou o usuário deste token');
      username = info.username;
    } catch (e) {
      if (e instanceof MoodleLinkError) throw e;
      if (e instanceof MoodleError) {
        throw new MoodleLinkError('O Moodle recusou esse token. Refaça o login e tente de novo.');
      }
      // Rede/TLS: o código da causa (ex.: UNABLE_TO_VERIFY_LEAF_SIGNATURE) não contém o token e ajuda no diagnóstico.
      const cause = (e as { cause?: { code?: string } })?.cause?.code;
      throw new MoodleLinkError(`Não consegui falar com o Moodle agora${cause ? ` (${cause})` : ''}`);
    }

    await this.identity.conectarConta({
      userId,
      provider: 'MOODLE',
      accountKey: `${this.host()}:${username}`,
      siteUrl: this.siteUrl,
      secretPlain: parsed.wstoken,
    });
  }
}
