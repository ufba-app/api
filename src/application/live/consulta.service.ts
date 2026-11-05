import { Injectable } from '@nestjs/common';
import type { AttachmentContent } from '../ports/attachment-reader';
import type { AtividadeViva, CursoVivo, DiscussaoViva, LiveSource, PrazoVivo } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';

const NOMES: Record<Provider, string> = {
  SIGAA: 'SIGAA',
  MOODLE: 'Moodle',
  CLASSROOM: 'Google Classroom',
  CALENDAR: 'Google Calendar',
};

/** A fonte não tem leitura ao vivo neste servidor. */
export class FonteSemLeituraError extends Error {}
/** A pessoa não conectou essa fonte (ou essa conta), ou o token foi recusado. */
export class FonteNaoConectadaError extends Error {}
/** Mais de uma conta conectada na fonte e nenhuma escolhida. */
export class ContaAmbiguaError extends Error {}

export interface ContaConectada {
  provider: Provider;
  conta: string;
  /** `REAUTH_NEEDED`: a fonte recusou o acesso guardado; conectar de novo. */
  status: SourceAccountRecord['status'];
}

/**
 * Consultas AO VIVO em UMA conta: resolve a conta da pessoa (a indicada em `conta`, ou a única conectada), decifra
 * o token só em memória e pergunta à fonte. Não grava nada (a única escrita é marcar a conta como REAUTH_NEEDED
 * quando a fonte recusa o token). Para ler várias contas, quem chama lista com `contas` e consulta uma a uma.
 */
@Injectable()
export class ConsultaService {
  constructor(
    private readonly sources: LiveSources,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
  ) {}

  /** Contas conectadas (com acesso guardado) nas fontes com leitura ao vivo. Só lê o banco: não chama fonte. */
  async contas(userId: string): Promise<ContaConectada[]> {
    return (await this.accounts.listByUser(userId))
      .filter((a) => a.secret && this.sources.get(a.provider))
      .map((a) => ({ provider: a.provider, conta: a.accountKey, status: a.status }));
  }

  listarCursos(userId: string, provider: Provider, conta?: string, opts?: { todas?: boolean }): Promise<CursoVivo[]> {
    return this.com(userId, provider, conta, (s, ctx) => s.listarCursos(ctx, opts));
  }

  prazos(userId: string, provider: Provider, conta?: string): Promise<PrazoVivo[]> {
    return this.com(userId, provider, conta, (s, ctx) => s.prazos(ctx));
  }

  verCurso(userId: string, provider: Provider, conta: string | undefined, cursoId: string): Promise<AtividadeViva[]> {
    return this.com(userId, provider, conta, (s, ctx) => s.verCurso(ctx, cursoId));
  }

  verForum(userId: string, provider: Provider, conta: string | undefined, forumId: string): Promise<DiscussaoViva[]> {
    return this.com(userId, provider, conta, (s, ctx) => s.verForum(ctx, forumId));
  }

  baixar(userId: string, provider: Provider, conta: string | undefined, ref: string): Promise<AttachmentContent> {
    return this.com(userId, provider, conta, (s, ctx) => s.baixar(ctx, ref));
  }

  /** A conta da consulta: a pedida, ou a única conectada. Sem chamar a fonte. */
  async conta(userId: string, provider: Provider, conta?: string): Promise<SourceAccountRecord> {
    const contas = (await this.accounts.findByUserAndProvider(userId, provider)).filter((a) => a.secret);
    if (contas.length === 0) {
      throw new FonteNaoConectadaError(`${NOMES[provider]} não conectado: conecte na tela de autorização do serviço`);
    }
    if (conta !== undefined) {
      const alvo = conta.trim().toLowerCase();
      const achada = contas.find((a) => a.accountKey.toLowerCase() === alvo);
      if (!achada) {
        throw new FonteNaoConectadaError(
          `${NOMES[provider]}: a conta "${conta}" não está conectada. Contas: ${contas.map((a) => a.accountKey).join(', ')}`,
        );
      }
      return achada;
    }
    if (contas.length > 1) {
      throw new ContaAmbiguaError(
        `${NOMES[provider]}: há ${contas.length} contas conectadas (${contas.map((a) => a.accountKey).join(', ')}). ` +
          'Passe `conta` com uma delas (veja `listar_contas`).',
      );
    }
    return contas[0];
  }

  private async com<T>(
    userId: string,
    provider: Provider,
    conta: string | undefined,
    fn: (source: LiveSource, ctx: SourceContext) => Promise<T>,
  ): Promise<T> {
    const source = this.sources.get(provider);
    if (!source) throw new FonteSemLeituraError(`${NOMES[provider]}: leitura ainda não disponível`);
    const account = await this.conta(userId, provider, conta);
    const ctx: SourceContext = {
      userId,
      accountKey: account.accountKey,
      siteUrl: account.siteUrl ?? undefined,
      credentials: { kind: 'token', token: this.cipher.decrypt(account.secret!) },
    };
    try {
      return await fn(source, ctx);
    } catch (e) {
      if (e instanceof SourceError && e.code === 'REAUTH_NEEDED') {
        await this.accounts.setStatus(account.id, 'REAUTH_NEEDED', e.code);
        throw new FonteNaoConectadaError(
          `${NOMES[provider]} (${account.accountKey}) recusou o acesso guardado: conecte de novo na tela de autorização do serviço`,
        );
      }
      throw e;
    }
  }
}
