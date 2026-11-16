import { Secret } from '../shared/secret';
import { Injectable, Optional } from '@nestjs/common';
import { DriveDownloader } from '../ports/drive-downloader';
import type { ClassSchedule } from '../../domain/academic/class-schedule';
import type { AttachmentContent } from '../ports/attachment-reader';
import type { DriveFileInfo, DriveFolderEntry } from '../ports/drive-downloader';
import type { AgendaSigaa, AnexoVivo, AtividadeViva, CursoVivo, DiscussaoViva, FrequenciaViva, LinkVivo, LiveSource, MensagemViva, ParticipanteVivo, PostagemFeita, PostagemForum, PrazoVivo } from '../ports/live-source';
import { LiveSources } from '../ports/live-source';
import { SourceAccountRecord, SourceAccountRepository } from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import { SourceError, type Provider, type SourceContext } from '../ports/source-gateway';
import { CofreSigaa, CredencialSigaaInvalidaError } from '../sigaa/cofre-sigaa';

/** Pastas do Drive expandidas por consulta de curso/fórum, e anexos novos no total: tetos de custo e de tamanho da resposta. */
export const MAX_PASTAS = 5;
export const MAX_ANEXOS_DE_PASTAS = 200;

const NOMES: Record<Provider, string> = {
  SIGAA: 'SIGAA',
  MOODLE: 'Moodle',
  SIASB: 'SIASB',
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
/** Publicação com destino, título ou mensagem fora da regra. Nada chega à fonte. */
export class PostagemInvalidaError extends Error {}

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
 * SIGAA: a sessão (cookie) é da pessoa; a senha vem do cofre, decifrada com a K do token do cliente, só em memória e só
 * quando é preciso logar. Nunca vai para log nem para mensagem de erro.
 */
@Injectable()
export class ConsultaService {
  constructor(
    private readonly sources: LiveSources,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
    private readonly cofre: CofreSigaa,
    /** Arquivos do Drive linkados no Moodle; sem ele, esses `ref` nem existem. */
    @Optional() private readonly drive?: DriveDownloader,
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

  async verCurso(quem: Quem, provider: Provider, conta: string | undefined, cursoId: string): Promise<AtividadeViva[]> {
    return this.expandirPastas(quem, provider, await this.com(quem, provider, conta, (s, ctx) => s.verCurso(ctx, cursoId)));
  }

  async verForum(quem: Quem, provider: Provider, conta: string | undefined, forumId: string): Promise<DiscussaoViva[]> {
    return this.expandirPastas(quem, provider, await this.com(quem, provider, conta, (s, ctx) => s.verForum(ctx, forumId)));
  }

  /** Participantes de UMA matéria (nome e papéis). Só fontes com `listarParticipantes` (hoje, o Moodle). */
  async listarParticipantes(quem: Quem, provider: Provider, conta: string | undefined, cursoId: string): Promise<ParticipanteVivo[]> {
    const source = this.sources.get(provider);
    if (!source?.listarParticipantes) throw new FonteSemLeituraError(`${NOMES[provider]}: listar participantes ainda não disponível`);
    return this.com(quem, provider, conta, (s, ctx) => s.listarParticipantes!(ctx, cursoId));
  }

  /** Mensagens de UM tópico, com as respostas. Só fontes com `verTopico` (hoje, o Moodle). */
  async verTopico(quem: Quem, provider: Provider, conta: string | undefined, discussaoId: string): Promise<MensagemViva[]> {
    const source = this.sources.get(provider);
    if (!source?.verTopico) throw new FonteSemLeituraError(`${NOMES[provider]}: ler um tópico ainda não disponível`);
    return this.com(quem, provider, conta, (s, ctx) => s.verTopico!(ctx, discussaoId));
  }

  /**
   * Turmas com horário E prazos do SIGAA numa passada, com UMA leitura do portal (1 + 2 por turma com Turma Virtual, até 8). Falha
   * nos prazos não derruba as turmas (`prazosCompletos: false`). Só o SIGAA.
   */
  async agendaSigaa(quem: Quem, conta?: string, opts?: { orcamentoMs?: number }): Promise<AgendaSigaa> {
    const source = this.sources.get('SIGAA');
    if (!source?.agendaSigaa) throw new FonteSemLeituraError('SIGAA: agenda das turmas ainda não disponível');
    return this.com(quem, 'SIGAA', conta, (s, ctx) => s.agendaSigaa!(ctx, opts));
  }

  /** Turmas do semestre com dia e horário (só o SIGAA). 1 requisição ao portal. */
  async turmasComHorario(quem: Quem, conta?: string): Promise<ClassSchedule[]> {
    const source = this.sources.get('SIGAA');
    if (!source?.turmasComHorario) throw new FonteSemLeituraError('SIGAA: horário das turmas ainda não disponível');
    return this.com(quem, 'SIGAA', conta, (s, ctx) => s.turmasComHorario!(ctx));
  }

  /**
   * Publica no fórum (escrita; a permissão `moodle.forum_write` é checada antes, na camada MCP). Só o Moodle.
   * Valida a forma aqui: exatamente um destino (`forumId` ou `postId`), título e mensagem não vazios e dentro do limite.
   */
  async postarForum(quem: Quem, conta: string | undefined, post: PostagemForum): Promise<PostagemFeita> {
    const destinos = [post.forumId, post.postId].filter((v) => v !== undefined).length;
    if (destinos !== 1) throw new PostagemInvalidaError('Informe `forumId` (nova discussão) ou `postId` (resposta), não os dois.');
    const titulo = post.titulo.trim();
    const mensagem = post.mensagem.trim();
    if (titulo === '' || titulo.length > 255) throw new PostagemInvalidaError('O título precisa ter de 1 a 255 caracteres.');
    if (mensagem === '' || mensagem.length > 10000) throw new PostagemInvalidaError('A mensagem precisa ter de 1 a 10000 caracteres.');
    const source = this.sources.get('MOODLE');
    if (!source?.postarForum) throw new FonteSemLeituraError('Moodle: postar no fórum ainda não disponível');
    return this.com(quem, 'MOODLE', conta, (s, ctx) => s.postarForum!(ctx, { ...post, titulo, mensagem }));
  }

  /** Texto completo de um aviso. Só fontes com `verAviso` (hoje, o SIGAA). */
  async verAviso(quem: Quem, provider: Provider, conta: string | undefined, avisoId: string): Promise<DiscussaoViva> {
    const source = this.sources.get(provider);
    if (source && !source.verAviso) {
      throw new FonteSemLeituraError(`${NOMES[provider]}: ver_aviso não disponível nesta fonte`);
    }
    return this.com(quem, provider, conta, (s, ctx) => s.verAviso!(ctx, avisoId));
  }

  /** Frequência de cada turma do semestre. Só o SIGAA tem (fonte fixa). */
  async frequencia(quem: Quem, conta?: string): Promise<FrequenciaViva[]> {
    const source = this.sources.get('SIGAA');
    if (source && !source.frequencia) {
      throw new FonteSemLeituraError('SIGAA: frequência não disponível nesta fonte');
    }
    return this.com(quem, 'SIGAA', conta, (s, ctx) => s.frequencia!(ctx));
  }

  baixar(quem: Quem, provider: Provider, conta: string | undefined, ref: string): Promise<AttachmentContent> {
    if (provider === 'SIGAA') return Promise.reject(semDownloadSigaa());
    if (provider === 'MOODLE' && this.drive?.owns(ref)) return this.baixarDoDrive(quem, conta, ref);
    return this.com(quem, provider, conta, (s, ctx) => s.baixar(ctx, ref));
  }

  /**
   * Arquivo do Drive linkado no Moodle: confere a conta do Moodle de onde ele veio e abre com as contas do Google da pessoa
   * (Classroom conectado, em memória), depois o link público. O `ref` assinado é a única entrada aceita.
   */
  private async baixarDoDrive(quem: Quem, conta: string | undefined, ref: string): Promise<AttachmentContent> {
    await this.conta(quem, 'MOODLE', conta);
    return this.drive!.download(quem.userId, ref, await this.contasGoogle(quem.userId));
  }

  /** As contas do Google da pessoa (Classroom conectado, token só em memória) que podem abrir arquivos do Drive. */
  private async contasGoogle(userId: string) {
    return (await this.accounts.findByUserAndProvider(userId, 'CLASSROOM'))
      .filter((a) => a.secret && a.status !== 'REAUTH_NEEDED')
      .map((a) => ({ accountKey: a.accountKey, refreshToken: Secret.of(this.cipher.decrypt(a.secret!)) }));
  }

  /**
   * Antes de gerar o link de um arquivo do Drive: o que ele é (nome, tipo, tamanho) para avisar, sem baixar, que vídeo e arquivo
   * grande não se baixam pelo serviço. `null` quando não é do Drive ou não há como saber (nada impede o link; o download confere de novo).
   */
  async driveInfo(quem: Quem, conta: string | undefined, ref: string): Promise<DriveFileInfo | null> {
    if (!this.drive?.owns(ref) || this.drive.isFolder(ref)) return null;
    try {
      await this.conta(quem, 'MOODLE', conta);
      return await this.drive.inspect(quem.userId, ref, await this.contasGoogle(quem.userId));
    } catch {
      return null;
    }
  }

  /**
   * Pasta do Drive no conteúdo do Moodle (o `ref` assinado que o extrator pôs) vira um anexo por arquivo de dentro, só o primeiro
   * nível: os `ref` dos filhos são assinados para esta pessoa (o da pasta, que veio do curso, autoriza os listados). Vídeo, arquivo
   * grande e subpasta não viram anexo: vão em `abrirNoNavegador` com o tipo e o tamanho. Pasta que não deu para listar vira só o link
   * para a pessoa abrir. Teto de pastas por chamada e de anexos novos; melhor esforço (nunca derruba a leitura do curso).
   */
  private async expandirPastas<T extends { anexos: AnexoVivo[]; abrirNoNavegador?: LinkVivo[] }>(quem: Quem, provider: Provider, items: T[]): Promise<T[]> {
    const drive = this.drive;
    if (provider !== 'MOODLE' || !drive) return items;
    const refs = [...new Set(items.flatMap((i) => i.anexos).filter((a) => drive.isFolder(a.ref)).map((a) => a.ref))];
    if (refs.length === 0) return items;
    const google = await this.contasGoogle(quem.userId);
    const listadas = new Map<string, DriveFolderEntry[] | null>();
    for (const ref of refs.slice(0, MAX_PASTAS)) {
      try {
        listadas.set(ref, await drive.listFolder(quem.userId, ref, google));
      } catch {
        listadas.set(ref, null);
      }
    }
    let restante = MAX_ANEXOS_DE_PASTAS;
    return items.map((item) => {
      if (!item.anexos.some((a) => drive.isFolder(a.ref))) return item;
      const anexos: AnexoVivo[] = [];
      const abrir: LinkVivo[] = [...(item.abrirNoNavegador ?? [])];
      for (const a of item.anexos) {
        if (!drive.isFolder(a.ref)) {
          anexos.push(a);
          continue;
        }
        const entries = listadas.get(a.ref) ?? null;
        if (!entries) {
          const url = drive.viewUrl(quem.userId, a.ref);
          if (url) abrir.push({ nome: `${a.nome} (não consegui listar os arquivos)`, url });
          continue;
        }
        for (const e of entries) {
          if (e.ref && restante > 0) {
            restante--;
            anexos.push({ nome: e.name, mimeType: e.mimeType, ...(e.sizeBytes !== null ? { tamanhoBytes: e.sizeBytes } : {}), ref: e.ref });
          } else {
            abrir.push({ nome: e.label, url: e.viewUrl });
          }
        }
      }
      return { ...item, anexos, ...(abrir.length ? { abrirNoNavegador: abrir } : {}) };
    });
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
      credentials: { kind: 'token', token: Secret.of(this.cipher.decrypt(account.secret!)) },
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

  /**
   * SIGAA: a sessão é da PESSOA e vale para qualquer cliente; a senha só é aberta (com a K do token de quem consulta,
   * como um refresh token) quando é preciso logar: sessão ausente, parada ou expirada. Sem K ou sem credencial guardada
   * para o cliente, falha antes de tocar a fonte.
   */
  private async comSigaa<T>(
    quem: Quem,
    source: LiveSource,
    conta: string | undefined,
    fn: (source: LiveSource, ctx: SourceContext) => Promise<T>,
  ): Promise<T> {
    const cliente = quem.cliente;
    if (!cliente?.chave) throw new FonteNaoConectadaError(SIGAA_NAO_CONECTADO);
    const doCliente = { userId: quem.userId, clientId: cliente.clientId };
    const chave = cliente.chave;

    const cred = await this.cofre.situacao(doCliente);
    if (!cred) throw new FonteNaoConectadaError(SIGAA_NAO_CONECTADO);
    // Credencial já recusada pelo SIGAA: nada de tentar de novo até a pessoa reconectar.
    if (cred.status === 'REAUTH_NEEDED') {
      throw new FonteNaoConectadaError(`SIGAA: o acesso guardado não vale mais: ${SIGAA_RECONECTAR}`);
    }
    if (conta !== undefined && conta.trim().toLowerCase() !== cred.login.toLowerCase()) {
      throw new FonteNaoConectadaError(
        `SIGAA: a conta "${conta}" não está conectada neste aplicativo. Conta: ${cred.login}`,
      );
    }

    const ctx: SourceContext = {
      userId: quem.userId,
      accountKey: `sigaa:${cred.login}`,
      credentials: {
        kind: 'password-on-demand',
        username: cred.login,
        open: async (): Promise<Secret> => {
          try {
            const aberta = await this.cofre.abrir(doCliente, chave);
            if (!aberta) throw new SourceError('CREDENTIAL_REJECTED', SIGAA_NAO_CONECTADO);
            return aberta.senha;
          } catch (e) {
            // K que não abre o cifrado (ex.: token de uma autorização substituída): nada do erro original vai adiante.
            if (e instanceof CredencialSigaaInvalidaError) throw new SourceError('CREDENTIAL_REJECTED', SIGAA_RECONECTAR);
            throw e;
          }
        },
      },
    };
    try {
      return await fn(source, ctx);
    } catch (e) {
      if (e instanceof SourceError && e.code === 'REAUTH_NEEDED') {
        await this.cofre.marcarInvalida(quem.userId);
        throw new FonteNaoConectadaError(`SIGAA (${cred.login}) recusou o login e a senha guardados: ${SIGAA_RECONECTAR}`);
      }
      if (e instanceof SourceError && e.code === 'CREDENTIAL_REJECTED') {
        throw new FonteNaoConectadaError(`SIGAA: o acesso guardado não vale mais: ${SIGAA_RECONECTAR}`);
      }
      throw e;
    }
  }
}

function semDownloadSigaa(): FonteSemLeituraError {
  return new FonteSemLeituraError('SIGAA: baixar anexos ainda não disponível');
}
