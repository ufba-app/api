import { siasbSubject } from '../../domain/identity/source-binding';
import type { SourceBindings } from '../identity/source-bindings';
import { LinkError } from '../oauth/oauth-ports';
import type { SourceAccountRepository, StudentRegistrations } from '../ports/repositories';
import type { SecretCipher } from '../ports/secret-cipher';
import { SiasbError, type SiasbCourse, type SiasbSource } from '../ports/siasb-source';
import type { SiasbCopyRepository } from '../ports/siasb-copy';
import type { Secret } from '../shared/secret';
import { encodeSession } from './session-codec';

const COURSES_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const ACCOUNT_KEY = 'siasb';

export type SiasbLinkState = 'disconnected' | 'connected' | 'reconnect_required';

const NO_REGISTRATION_MESSAGE =
  'Para conectar o SIASB, importe antes a sua vida acadêmica no painel: é de lá que vem a sua matrícula.';

const digits = (s: string) => s.replace(/[^0-9]/g, '');

/** Mensagens em pt-BR por falha do SIASB. Nunca levam senha, cookie nem matrícula. */
function toLinkError(e: unknown): LinkError {
  if (e instanceof LinkError) return e;
  if (e instanceof SiasbError) {
    if (e.code === 'PASSWORD_MIGRATION_REQUIRED') {
      return new LinkError('Entre uma vez no SIASB para atualizar sua senha e volte aqui.', 'siasb_password_migration_required');
    }
    if (e.code === 'CREDENTIAL_REJECTED') {
      return new LinkError('Matrícula ou senha do SIASB incorretas.', 'siasb_credentials_rejected');
    }
  }
  return new LinkError('O SIASB não respondeu agora. Tente de novo em instantes.', 'siasb_unavailable');
}

/**
 * Oferecer, conectar e desconectar o SIASB (clínicas). O vínculo é pela matrícula do perfil: `assertCompatible` antes
 * de falar com o SIASB, `bind` só depois de a sessão provar o `username`. A senha é usada uma única vez (um login);
 * o que se guarda é o jar de cookies, cifrado.
 */
export class SiasbLink {
  private readonly coursesCache = new Map<string, { courses: SiasbCourse[]; expiresAt: number }>();
  /** Falha recente ao listar cursos (só para `offer`): evita bater no SIASB a cada /me enquanto ele está fora. */
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly siasb: SiasbSource,
    private readonly registrations: StudentRegistrations,
    private readonly bindings: SourceBindings,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
    private readonly copy: SiasbCopyRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async offer(userId: string): Promise<{ offered: boolean; courses: SiasbCourse[] }> {
    const none = { offered: false, courses: [] as SiasbCourse[] };
    const registration = await this.registration(userId);
    if (!registration) return none;
    const hit = this.coursesCache.get(userId);
    const cached = !!hit && hit.expiresAt > this.now();
    if (!cached && (this.failures.get(userId) ?? 0) > this.now()) return none;
    try {
      const courses = await this.courses(userId, registration);
      this.failures.delete(userId);
      return courses.length > 0 ? { offered: true, courses } : none;
    } catch {
      this.failures.set(userId, this.now() + FAILURE_TTL_MS);
      return none;
    }
  }

  /** A pessoa tem matrícula importada (vida acadêmica confirmada)? Só olha o banco; nunca fala com o SIASB. */
  async hasRegistration(userId: string): Promise<boolean> {
    return (await this.registration(userId)) !== null;
  }

  async connect(userId: string, password: Secret): Promise<void> {
    const registration = await this.registration(userId);
    if (!registration) {
      throw new LinkError(NO_REGISTRATION_MESSAGE, 'invalid_request');
    }
    const subject = siasbSubject(registration);
    await this.bindings.assertCompatible(userId, subject);

    let session, username;
    try {
      const courses = await this.courses(userId, registration);
      const course = courses.find((c) => c.isDefault) ?? courses[0];
      if (!course) throw new SiasbError('UNAVAILABLE');
      ({ session, username } = await this.siasb.login(registration, password, course.id));
    } catch (e) {
      throw toLinkError(e);
    }

    if (digits(username) !== subject.value) {
      throw new LinkError(
        'Essa conta do SIASB não é a da sua matrícula. Confira a matrícula e a senha.',
        'source_account_mismatch',
      );
    }
    await this.bindings.bind(userId, subject);
    await this.accounts.upsert({
      userId,
      provider: 'SIASB',
      accountKey: ACCOUNT_KEY,
      secret: this.cipher.encrypt(encodeSession(session)),
      // null limpa o fim antigo: reconectar sem expiração nova não pode herdar a anterior.
      expiresAt: session.expiresAt,
    });
    // Reconectar zera o sinal de quebra da cópia: sem isso, até a próxima sincronização o aviso de reconexão ainda
    // usaria a âncora antiga (RECONNECT_REQUIRED) e um "venceu" sairia depois da volta. Nunca derruba a conexão.
    try {
      await this.copy.resetState(userId);
    } catch {
      /* a conexão já está feita; no pior caso o aviso espera a próxima sincronização */
    }
  }

  async disconnect(userId: string): Promise<void> {
    for (const a of await this.accounts.findByUserAndProvider(userId, 'SIASB')) await this.accounts.delete(a.id);
    // Ordem obrigatória: conta primeiro, cópia depois. `replaceWindow` trava a linha da conta (FOR SHARE); uma gravação
    // em curso termina antes e esta limpeza a apaga. Se a limpeza falhar, o erro propaga: a pessoa tenta de novo
    // (desconectar é idempotente) e a cópia não fica órfã sem aviso.
    await this.copy.deleteAll(userId);
  }

  /** syncedAt: último sucesso da sincronização (cópia); null se nunca houve ou se o estado não pôde ser lido. */
  async status(userId: string): Promise<{ state: SiasbLinkState; expiresAt: Date | null; syncedAt: Date | null }> {
    const account = (await this.accounts.findByUserAndProvider(userId, 'SIASB'))[0];
    if (!account) return { state: 'disconnected', expiresAt: null, syncedAt: null };
    const syncedAt = (await this.copy.state(userId).catch(() => null))?.lastSuccessAt ?? null;
    return {
      state: account.status === 'OK' ? 'connected' : 'reconnect_required',
      expiresAt: account.expiresAt,
      syncedAt,
    };
  }

  /** Matrícula só com dígitos; `null` se não há ou não tem dígito (tratada como ausente). */
  private async registration(userId: string): Promise<string | null> {
    const r = await this.registrations.find(userId);
    const only = r ? digits(r) : '';
    return only === '' ? null : only;
  }

  private async courses(userId: string, registration: string): Promise<SiasbCourse[]> {
    const hit = this.coursesCache.get(userId);
    if (hit && hit.expiresAt > this.now()) return hit.courses;
    const courses = await this.siasb.courseOptions(registration);
    this.coursesCache.set(userId, { courses, expiresAt: this.now() + COURSES_TTL_MS });
    return courses;
  }
}
