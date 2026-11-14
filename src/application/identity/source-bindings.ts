import { decideBinding, type BoundSource, type SourceSubject } from '../../domain/identity/source-binding';
import { LinkError } from '../oauth/oauth-ports';
import type { SourceBindingRepository, SubjectHasher } from '../ports/repositories';

const NAME: Record<BoundSource, string> = { SIGAA: 'SIGAA', MOODLE: 'AVA (Moodle)' };

const mismatch = (s: BoundSource) =>
  new LinkError(
    `Sua conta já está ligada a outro ${NAME[s]}. Para usar outro, exclua sua conta do ufba.app e entre de novo.`,
    'source_account_mismatch',
  );
const taken = (s: BoundSource) =>
  new LinkError(
    `Este ${NAME[s]} já está ligado a outra conta do ufba.app. Se ele é seu, fale com a gente.`,
    'source_account_taken',
  );

/**
 * Caso de uso do vínculo fixo conta ↔ titular na fonte (regras em domain/identity/source-binding). Quem conecta uma
 * fonte chama `assertCompatible` ANTES de falar com ela (sem revelar nada de outras contas) e `bind` DEPOIS de a fonte
 * provar que a pessoa é dona da conta (senha certa, token válido).
 */
export class SourceBindings {
  constructor(
    private readonly repo: SourceBindingRepository,
    private readonly hasher: SubjectHasher,
  ) {}

  /** Esta conta já está ligada a outro titular nesta fonte? Só olha o vínculo da própria conta. */
  async assertCompatible(userId: string, subject: SourceSubject): Promise<void> {
    const mine = await this.repo.findMine(userId, subject.source);
    if (mine !== null && mine !== this.hasher.hash(subject)) throw mismatch(subject.source);
  }

  /** Liga (ou confirma) esta conta ao titular. Lança `LinkError` se o titular é de outra conta ou se esta já tem outro. */
  async bind(userId: string, subject: SourceSubject): Promise<void> {
    const h = this.hasher.hash(subject);
    // Duas rodadas: se outro vínculo nascer entre a leitura e a escrita, a segunda leitura decide.
    for (let round = 0; round < 2; round++) {
      const [mine, ownerOfSubject] = await Promise.all([
        this.repo.findMine(userId, subject.source),
        this.repo.findOwner(subject.source, h),
      ]);
      switch (decideBinding(userId, h, { mine, ownerOfSubject })) {
        case 'already_bound':
          return;
        case 'mismatch':
          throw mismatch(subject.source);
        case 'taken':
          throw taken(subject.source);
        case 'bind':
          if (await this.repo.create(userId, subject.source, h)) return;
      }
    }
    throw new LinkError('Não consegui concluir a conexão agora. Tente de novo.', 'source_unavailable');
  }
}
