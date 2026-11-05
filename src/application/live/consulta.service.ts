import { Injectable } from '@nestjs/common';
import type { AttachmentContent } from '../ports/attachment-reader';
import type { AtividadeViva, CursoVivo, DiscussaoViva, LiveSource, PrazoVivo } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';
import { CofreSigaa, CredencialSigaaInvalidaError } from '../sigaa/cofre-sigaa';

const NOMES: Record<Provider, string> = {
  SIGAA: 'SIGAA',
  MOODLE: 'Moodle',
  CLASSROOM: 'Google Classroom',
  CALENDAR: 'Google Calendar',
};

const SIGAA_NAO_CONECTADO = 'SIGAA não conectado neste aplicativo: conecte na tela de autorização do serviço';
const SIGAA_RECONECTAR = 'conecte o SIGAA de novo na tela de autorização do serviço';

/** A fonte não tem leitura ao vivo neste servidor. */
export class FonteSemLeituraError extends Error {}
/** A pessoa não conectou essa fonte (ou essa conta), ou o token foi recusado. */
export class FonteNaoConectadaError extends Error {}
/** Mais de uma conta conectada na fonte e nenhuma escolhida. */
export class ContaAmbiguaError extends Error {}

/**
 * Quem consulta. `cliente` só existe em tokens OAuth: o SIGAA é lido com a senha guardada PARA AQUELE cliente,
 * aberta com a chave `chave` (K) que só o token carrega. Chave de API `plt_` não tem cliente: não lê o SIGAA.
 */
export interface Quem {
  userId: string;
  cliente?: { clientId: string; chave?: Buffer };
}

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
 *
 * SIGAA: não há token guardado; a senha vem do cofre, decifrada com a K do token do cliente, só em memória e só
 * para esta consulta. Nunca vai para log nem para mensagem de erro.
 */
@Injectable()
export class ConsultaService {
  constructor(
    private readonly sources: LiveSources,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
    private readonly cofre: CofreSigaa,
  ) {}

  /** Contas conectadas (com acesso guardado) nas fontes com leitura ao vivo. Só lê o banco: não chama fonte. */
  async contas(quem: Quem): Promise<ContaConectada[]> {
    const contas: ContaConectada[] = (await this.accounts.listByUser(quem.userId))
      .filter((a) => a.provider !== 'SIGAA' && a.secret && this.sources.get(a.provider))
      .map((a) => ({ provider: a.provider, conta: a.accountKey, status: a.status }));
    // Sem K no token o SIGAA não abre (ver `comSigaa`): então nem aparece, para não listar o que não dá para ler.
    if (quem.cliente?.chave && this.sources.get('SIGAA')) {
      const sigaa = await this.cofre.situacao({ userId: quem.userId, clientId: quem.cliente.clientId });
      if (sigaa) contas.push({ provider: 'SIGAA', conta: sigaa.login, status: sigaa.status });
    }
    return contas;
  }

  listarCursos(quem: Quem, provider: Provider, conta?: string, opts?: { todas?: boolean }): Promise<CursoVivo[]> {
    return this.com(quem, provider, conta, (s, ctx) => s.listarCursos(ctx, opts));
  }

  prazos(quem: Quem, provider: Provider, conta?: string): Promise<PrazoVivo[]> {
    return this.com(quem, provider, conta, (s, ctx) => s.prazos(ctx));
  }

  verCurso(quem: Quem, provider: Provider, conta: string | undefined, cursoId: string): Promise<AtividadeViva[]> {
    return this.com(quem, provider, conta, (s, ctx) => s.verCurso(ctx, cursoId));
  }

  verForum(quem: Quem, provider: Provider, conta: string | undefined, forumId: string): Promise<DiscussaoViva[]> {
    return this.com(quem, provider, conta, (s, ctx) => s.verForum(ctx, forumId));
  }

  /** Texto completo de um aviso. Só fontes com `verAviso` (hoje, o SIGAA). */
  async verAviso(quem: Quem, provider: Provider, conta: string | undefined, avisoId: string): Promise<DiscussaoViva> {
    const source = this.sources.get(provider);
    if (source && !source.verAviso) {
      throw new FonteSemLeituraError(`${NOMES[provider]}: ver_aviso não disponível nesta fonte`);
    }
    return this.com(quem, provider, conta, (s, ctx) => s.verAviso!(ctx, avisoId));
  }

  baixar(quem: Quem, provider: Provider, conta: string | undefined, ref: string): Promise<AttachmentContent> {
    if (provider === 'SIGAA') return Promise.reject(semDownloadSigaa());
    return this.com(quem, provider, conta, (s, ctx) => s.baixar(ctx, ref));
  }

  /** A conta da consulta: a pedida, ou a única conectada. Sem chamar a fonte. (Só fontes com token guardado.) */
  async conta(quem: Quem, provider: Provider, conta?: string): Promise<SourceAccountRecord> {
    if (provider === 'SIGAA') throw semDownloadSigaa();
    const contas = (await this.accounts.findByUserAndProvider(quem.userId, provider)).filter((a) => a.secret);
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
    quem: Quem,
    provider: Provider,
    conta: string | undefined,
    fn: (source: LiveSource, ctx: SourceContext) => Promise<T>,
  ): Promise<T> {
    const source = this.sources.get(provider);
    if (!source) throw new FonteSemLeituraError(`${NOMES[provider]}: leitura ainda não disponível`);
    if (provider === 'SIGAA') return this.comSigaa(quem, source, conta, fn);
    const account = await this.conta(quem, provider, conta);
    const ctx: SourceContext = {
      userId: quem.userId,
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

  /** SIGAA: abre a senha do cliente com a K do token. Sem K ou sem credencial, falha antes de tocar a fonte. */
  private async comSigaa<T>(
    quem: Quem,
    source: LiveSource,
    conta: string | undefined,
    fn: (source: LiveSource, ctx: SourceContext) => Promise<T>,
  ): Promise<T> {
    const cliente = quem.cliente;
    if (!cliente?.chave) throw new FonteNaoConectadaError(SIGAA_NAO_CONECTADO);
    const doCliente = { userId: quem.userId, clientId: cliente.clientId };

    let cred: Awaited<ReturnType<CofreSigaa['abrir']>>;
    try {
      cred = await this.cofre.abrir(doCliente, cliente.chave);
    } catch (e) {
      // Credencial já recusada, ou K que não abre o cifrado: nada do erro original vai adiante.
      if (e instanceof CredencialSigaaInvalidaError) {
        throw new FonteNaoConectadaError(`SIGAA: o acesso guardado não vale mais: ${SIGAA_RECONECTAR}`);
      }
      throw e;
    }
    if (!cred) throw new FonteNaoConectadaError(SIGAA_NAO_CONECTADO);
    if (conta !== undefined && conta.trim().toLowerCase() !== cred.login.toLowerCase()) {
      throw new FonteNaoConectadaError(
        `SIGAA: a conta "${conta}" não está conectada neste aplicativo. Conta: ${cred.login}`,
      );
    }

    const ctx: SourceContext = {
      userId: quem.userId,
      accountKey: `sigaa:${cred.login}`,
      // Inclui o login: reautorizar o mesmo cliente com outro login do SIGAA não reaproveita a sessão do anterior.
      sessaoKey: `${quem.userId}:${cliente.clientId}:${cred.login}`,
      credentials: { kind: 'password', username: cred.login, password: cred.senha },
    };
    try {
      return await fn(source, ctx);
    } catch (e) {
      if (e instanceof SourceError && e.code === 'REAUTH_NEEDED') {
        await this.cofre.marcarInvalida(cred.credencialId);
        throw new FonteNaoConectadaError(`SIGAA (${cred.login}) recusou o login e a senha guardados: ${SIGAA_RECONECTAR}`);
      }
      throw e;
    }
  }
}

function semDownloadSigaa(): FonteSemLeituraError {
  return new FonteSemLeituraError('SIGAA: baixar anexos ainda não disponível');
}
