import { inspect } from 'node:util';

/**
 * Sessão do SIASB: o jar de cookies da pessoa. Os NOMES dos cookies também são sensíveis (um deles carrega a matrícula
 * no nome, `<matrícula>_idcurso`), por isso impressão, JSON e inspeção mostram só o resumo, nunca o jar.
 * Quem cifra e guarda o jar lê `cookies` de propósito.
 */
export class SiasbSession {
  constructor(
    public cookies: Record<string, string> = {},
    public expiresAt: Date | null = null,
    /** `true` quando uma resposta do SIASB renovou algum cookie e o jar precisa ser gravado de novo. */
    public dirty: boolean = false,
  ) {}

  toString(): string {
    return 'SiasbSession([redacted])';
  }

  toJSON(): { expiresAt: string | null; dirty: boolean } {
    return { expiresAt: this.expiresAt?.toISOString() ?? null, dirty: this.dirty };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export type SiasbErrorCode =
  | 'REAUTH_NEEDED'
  | 'PASSWORD_MIGRATION_REQUIRED'
  | 'CREDENTIAL_REJECTED'
  | 'UNAVAILABLE'
  | 'UNEXPECTED_FORMAT'
  | 'FORBIDDEN_ROUTE';

/** Erro do SIASB. A mensagem é fixa e nunca leva senha, cookie (valor ou nome), matrícula ou corpo de resposta. */
export class SiasbError extends Error {
  constructor(
    readonly code: SiasbErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SiasbError';
  }
}

export interface SiasbCourse {
  id: number;
  name: string;
  abbreviation: string;
  isDefault: boolean;
}
