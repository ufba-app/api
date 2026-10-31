import { Injectable } from '@nestjs/common';
import {
  ChangeView,
  CourseSpaceView,
  EventView,
  ItemFilter,
  ItemView,
  ProfileView,
  ReadRepository,
  SourceAccountRepository,
} from '../ports/repositories';
import type { Provider } from '../ports/source-gateway';

/** Toda leitura devolve `atualizadoEm`: quando o dado foi sincronizado pela última vez (null = nunca). */
export interface Lido<T> {
  atualizadoEm: Date | null;
  dados: T;
}

/**
 * Casos de leitura. Só consultam o banco: NUNCA vão a uma fonte (docs/ARQUITETURA.md §2.2). Quem lê decide, pela
 * idade de `atualizadoEm`, se precisa chamar `sincronizar`.
 */
@Injectable()
export class LeituraService {
  constructor(
    private readonly read: ReadRepository,
    private readonly accounts: SourceAccountRepository,
  ) {}

  async listarCursos(userId: string): Promise<Lido<CourseSpaceView[]>> {
    return {
      atualizadoEm: await this.ultimaSincronizacao(userId),
      dados: await this.read.listCourseSpaces(userId),
    };
  }

  async listarItens(filter: ItemFilter): Promise<Lido<ItemView[]>> {
    return {
      atualizadoEm: await this.ultimaSincronizacao(filter.userId, filter.provider),
      dados: await this.read.listItems(filter),
    };
  }

  /** Prazos (itens com vencimento) e eventos de calendário no intervalo, em ordem cronológica. */
  async agenda(input: {
    userId: string;
    de: Date;
    ate: Date;
  }): Promise<Lido<{ prazos: ItemView[]; eventos: EventView[] }>> {
    const [prazos, eventos] = await Promise.all([
      this.read.listItems({
        userId: input.userId,
        dueFrom: input.de,
        dueTo: input.ate,
        limit: 500,
      }),
      this.read.listEvents({ userId: input.userId, from: input.de, to: input.ate }),
    ]);
    return {
      atualizadoEm: await this.ultimaSincronizacao(input.userId),
      dados: { prazos, eventos },
    };
  }

  /** O que mudou desde `desde` (novo, alterado, removido). */
  async mudancas(input: {
    userId: string;
    desde: Date;
    limite?: number;
  }): Promise<Lido<ChangeView[]>> {
    return {
      atualizadoEm: await this.ultimaSincronizacao(input.userId),
      dados: await this.read.listChanges({
        userId: input.userId,
        since: input.desde,
        limit: input.limite,
      }),
    };
  }

  async perfil(userId: string): Promise<Lido<ProfileView | null>> {
    return {
      atualizadoEm: await this.ultimaSincronizacao(userId),
      dados: await this.read.getProfile(userId),
    };
  }

  /** Histórico acadêmico importado. `atualizadoEm` é a data da importação. */
  async historico(userId: string): Promise<Lido<unknown | null>> {
    const t = await this.read.getTranscript(userId);
    return { atualizadoEm: t?.importedAt ?? null, dados: t?.data ?? null };
  }

  private async ultimaSincronizacao(
    userId: string,
    provider?: Provider,
  ): Promise<Date | null> {
    const accounts = await this.accounts.listByUser(userId);
    const dates = accounts
      .filter((a) => !provider || a.provider === provider)
      .map((a) => a.lastSyncedAt)
      .filter((d): d is Date => d !== null);
    return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
  }
}
