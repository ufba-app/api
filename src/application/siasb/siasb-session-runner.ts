import type { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, type SiasbSession } from '../ports/siasb-source';
import { decodeSession, encodeSession } from './session-codec';

/** A pessoa precisa entrar de novo no painel (sem conta SIASB, conta marcada ou 401 no meio da leitura). */
export class ReconectarError extends Error {
  readonly code = 'reconectar' as const;
  constructor() {
    super('Sua conexão com o SIASB expirou. Entre de novo no painel.');
    this.name = 'ReconectarError';
  }
}

const MESSAGES = {
  siasb_unavailable: 'O SIASB não respondeu agora. Tente de novo em instantes.',
  siasb_unexpected_format: 'O SIASB devolveu uma página que não conseguimos ler. Tente de novo mais tarde.',
  siasb_no_slot: 'Não achamos um horário de clínica conhecido para essa disciplina.',
  siasb_attendance_not_found:
    'Não achamos esse atendimento entre os seus atendimentos ativos. Confira o id em clinica_pacientes.',
} as const;

/** Falha de leitura sem relação com a sessão (SIASB fora do ar ou página diferente). Mensagem fixa, em pt-BR. */
export class SiasbReadError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'SiasbReadError';
  }
}

export interface SiasbRunOptions {
  /** Troca o mapeamento padrão (SiasbReadError) dos SiasbError que não sejam REAUTH_NEEDED. */
  mapError?: (e: SiasbError) => Error;
}

/**
 * Executor da sessão guardada da pessoa, compartilhado por leitura e escrita: abre o jar cifrado, roda `fn`,
 * marca a conta no 401 e, se o SIASB renovou cookie, regrava o jar (melhor esforço; last-write-wins).
 */
export class SiasbSessionRunner {
  constructor(
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
  ) {}

  async requireAccount(userId: string): Promise<SourceAccountRecord> {
    const account = (await this.accounts.findByUserAndProvider(userId, 'SIASB'))[0];
    if (!account || account.status === 'REAUTH_NEEDED' || !account.secret) throw new ReconectarError();
    return account;
  }

  async run<T>(userId: string, fn: (session: SiasbSession) => Promise<T>, opts: SiasbRunOptions = {}): Promise<T> {
    const account = await this.requireAccount(userId);
    let session: SiasbSession;
    try {
      session = decodeSession(this.cipher.decrypt(account.secret!), account.expiresAt);
    } catch {
      await this.accounts.setStatus(account.id, 'REAUTH_NEEDED');
      throw new ReconectarError();
    }
    let skipStore = false;
    try {
      return await fn(session);
    } catch (e) {
      if (e instanceof SiasbError) {
        if (e.code === 'REAUTH_NEEDED') {
          skipStore = true;
          await this.accounts.setStatus(account.id, 'REAUTH_NEEDED');
          throw new ReconectarError();
        }
        if (opts.mapError) throw opts.mapError(e);
        throw new SiasbReadError(e.code === 'UNEXPECTED_FORMAT' ? 'siasb_unexpected_format' : 'siasb_unavailable');
      }
      throw e;
    } finally {
      if (session.dirty && !skipStore) {
        // Melhor esforço: falha ao regravar (ex.: conta apagada no meio) nunca troca o resultado da operação.
        try {
          await this.accounts.updateSecret(account.id, this.cipher.encrypt(encodeSession(session)), session.expiresAt ?? undefined);
        } catch {
          /* ignorado de propósito */
        }
      }
    }
  }
}
