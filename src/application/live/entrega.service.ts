import { Injectable } from '@nestjs/common';
import type { ArquivoParaEnvio, RequisitosEntrega } from '../ports/live-source';
import { ConsultaService, EntregaInvalidaError, type Quem } from './consulta.service';
import { ConfirmacoesEntrega, UploadLinks } from './entrega-links';
import { nomeSeguro } from './nome-seguro';

/** Teto dos arquivos mandados em base64 direto no pedido (soma de todos). Arquivo maior vai pelo link de upload. */
export const MAX_BYTES_INLINE = 2 * 1024 * 1024;

/** Tetos do serviço por envio (o arquivo fica em memória até subir ao Moodle), valendo junto com os limites da tarefa. */
export const LIMITES_UPLOAD = { maxArquivos: 20, maxBytesPorArquivo: 25 * 1024 * 1024, maxBytesTotal: 50 * 1024 * 1024 } as const;

type Acao = 'rascunho' | 'enviar';
type ArquivoResumo = { nome: string; tamanhoBytes: number };

export interface LimitesArquivos {
  maxArquivos: number;
  maxBytesPorArquivo: number;
  maxBytesTotal: number;
  /** Como a tarefa guarda (`[]` = qualquer); só uma lista só de extensões é conferida aqui. */
  extensoes: string[];
}

/** `tarefaId` nos pedidos e alvos é sempre o id público da atividade em `ver_curso` (cmid), nunca o id interno do Moodle. */
export interface PedidoEntrega {
  conta?: string;
  cursoId: string;
  tarefaId: string;
  texto?: string;
  uploadId?: string;
  arquivos?: ArquivoParaEnvio[];
}

export interface PreparoEntrega {
  requisitos: RequisitosEntrega;
  /** `false` = este serviço não entrega esta tarefa (o `motivo` diz por quê) e nenhum link de upload é aberto. */
  podeEntregar: boolean;
  motivo?: string;
  atrasada: boolean;
  /** Fora da janela de entrega (ainda não abriu ou o limite passou). */
  fechada: boolean;
  limitesArquivos?: LimitesArquivos;
  uploadId?: string;
  expiraEm?: Date;
}

export interface ResumoEntrega {
  confirmacaoId: string;
  expiraEm: Date;
  acao: Acao;
  tarefa: string;
  arquivos: ArquivoResumo[];
  texto?: string;
  efeito: string;
  prazo?: Date;
  atrasada: boolean;
  substituiEntrega: boolean;
  /** Só quando a ação apenas manda para avaliação o que já está no AVA: o que vai ser entregue. */
  arquivosAtuais?: ArquivoResumo[];
  temTextoAtual?: boolean;
}

/**
 * `desconhecido`: a escrita deu certo, mas a leitura do estado logo depois falhou (o `aviso` manda conferir no AVA);
 * `motivoLeitura`, quando a fonte deu, é só o código do porquê (`EstadoEntrega.motivoLeitura`).
 */
export type EntregaFeita =
  | { estado: 'nova' | 'rascunho' | 'entregue'; entregue: boolean }
  | { estado: 'desconhecido'; aviso: string; motivoLeitura?: string };

export interface AlvoConfirmacao {
  conta?: string;
  cursoId: string;
  tarefaId: string;
}

/** Link de upload inexistente, expirado ou já usado (a interface responde 404, não 400). */
export class LinkUploadInvalidoError extends EntregaInvalidaError {}

/** A entrega foi salva no AVA, mas o envio para avaliação falhou: o MCP mostra a mensagem como está. */
export class EntregaParcialError extends Error {
  readonly code = 'ENTREGA_PARCIAL';
}

const SALVO_SEM_ENVIAR =
  'Foi salvo como rascunho no AVA, mas NÃO foi enviado para avaliação (o professor ainda não recebe): ' +
  'chame enviar_tarefa sem conteúdo para pedir um novo resumo e enviar o rascunho.';
const GRAVADO_SEM_ESTADO = 'A entrega foi gravada no AVA, mas não consegui ler o estado logo depois: confira o estado no AVA.';

const PELO_AVA = 'entregue direto pelo AVA';

/**
 * Entrega de tarefa do Moodle em duas fases: `solicitar` valida tudo e devolve um resumo com `confirmacaoId` SEM gravar a entrega
 * (só sobe arquivos à área de rascunho do próprio Moodle, invisível ao professor); `confirmar`, com o "sim" da pessoa, grava.
 * Nada do trabalho (texto ou arquivo) é guardado aqui nem vai para log ou mensagem de erro: só nomes e tamanhos.
 */
@Injectable()
export class EntregaService {
  constructor(
    private readonly consulta: ConsultaService,
    private readonly uploads: UploadLinks,
    private readonly confirmacoes: ConfirmacoesEntrega,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Lê o que a tarefa pede e diz se este serviço pode entregá-la (`podeEntregar`, `motivo`). Só quando pode e ela aceita
   * arquivo abre um link de upload de uso único. Não escreve nada.
   */
  async preparar(quem: Quem, i: { conta?: string; cursoId: string; tarefaId: string }): Promise<PreparoEntrega> {
    const conta = (await this.consulta.conta(quem, 'MOODLE', i.conta)).accountKey;
    const requisitos = await this.consulta.requisitosEntrega(quem, conta, i.cursoId, i.tarefaId);
    const agora = this.now();
    const motivo = this.motivoRecusa(requisitos);
    const preparo: PreparoEntrega = {
      requisitos,
      podeEntregar: motivo === undefined,
      ...(motivo !== undefined ? { motivo } : {}),
      atrasada: requisitos.prazo !== undefined && requisitos.prazo.getTime() < agora,
      fechada: (requisitos.abreEm !== undefined && requisitos.abreEm.getTime() > agora) || (requisitos.limite !== undefined && requisitos.limite.getTime() <= agora),
      ...(requisitos.aceitaArquivo ? { limitesArquivos: limitesEfetivos(requisitos) } : {}),
    };
    if (motivo !== undefined || !requisitos.aceitaArquivo) return preparo;
    const link = this.uploads.abrir({ userId: quem.userId, conta, cursoId: i.cursoId, cmid: i.tarefaId, requisitos });
    return { ...preparo, uploadId: link.id, expiraEm: link.expiresAt };
  }

  /** Limites efetivos do link de upload, sem gastá-lo (a interface recusa cedo, antes de ler o corpo). `undefined` = link inválido. */
  espiarUpload(uploadId: string): { maxArquivos: number; maxBytesPorArquivo: number; maxBytesTotal: number } | undefined {
    const t = this.uploads.espiar(uploadId);
    if (!t) return undefined;
    const { maxArquivos, maxBytesPorArquivo, maxBytesTotal } = limitesEfetivos(t.requisitos);
    return { maxArquivos, maxBytesPorArquivo, maxBytesTotal };
  }

  /** Reserva o link antes de ler o corpo: um segundo POST simultâneo no mesmo link é recusado sem guardar nada. */
  reservarUpload(uploadId: string): boolean {
    return this.uploads.reservar(uploadId);
  }

  /** Solta a reserva quando o corpo não chegou inteiro ou era inválido (link já gasto continua gasto). */
  liberarUpload(uploadId: string): void {
    this.uploads.liberar(uploadId);
  }

  /** Arquivos chegados pelo link de upload: valida contra a tarefa, sobe à área de rascunho do Moodle e guarda o resultado. */
  async receberUpload(uploadId: string, arquivos: ArquivoParaEnvio[]): Promise<{ arquivos: ArquivoResumo[] }> {
    const ticket = this.uploads.consumir(uploadId);
    if (!ticket) throw new LinkUploadInvalidoError('Link de upload inválido, expirado ou já usado: chame preparar_envio_tarefa de novo.');
    if (arquivos.length === 0) throw new EntregaInvalidaError('Nenhum arquivo recebido.');
    validarArquivos(ticket.requisitos, arquivos);
    const quem: Quem = { userId: ticket.userId };
    const subido = await this.consulta.subirArquivosEntrega(quem, ticket.conta, arquivos);
    this.uploads.guardar(uploadId, {
      userId: ticket.userId,
      conta: ticket.conta,
      cmid: ticket.cmid,
      itemId: subido.itemId,
      arquivos: subido.arquivos,
    });
    return { arquivos: subido.arquivos.map((a) => ({ ...a })) };
  }

  /** Primeira fase: valida e devolve o resumo com `confirmacaoId`. Nunca grava a entrega. */
  async solicitar(quem: Quem, acao: Acao, p: PedidoEntrega): Promise<ResumoEntrega> {
    const conta = (await this.consulta.conta(quem, 'MOODLE', p.conta)).accountKey;
    const r = await this.consulta.requisitosEntrega(quem, conta, p.cursoId, p.tarefaId);
    this.validarTarefa(r, acao);

    const inline = p.arquivos ?? [];
    if (p.uploadId !== undefined && inline.length > 0) {
      throw new EntregaInvalidaError('Mande os arquivos pelo link de upload (`uploadId`) ou em `arquivos`, não pelos dois.');
    }
    const texto = p.texto !== undefined && p.texto.trim() !== '' ? p.texto.trim() : undefined;
    const vaiArquivo = p.uploadId !== undefined || inline.length > 0;
    if (texto !== undefined && !r.aceitaTexto) throw new EntregaInvalidaError('Esta tarefa não aceita texto online: entregue só arquivos.');
    if (vaiArquivo && !r.aceitaArquivo) throw new EntregaInvalidaError('Esta tarefa não aceita arquivos: entregue só o texto online.');
    // Sem conteúdo novo, só faz sentido mandar para avaliação o rascunho que já está no AVA.
    const soFinaliza = !vaiArquivo && texto === undefined && acao === 'enviar' && r.exigeBotaoEnviar && r.estado === 'rascunho';
    if (!vaiArquivo && texto === undefined && !soFinaliza) {
      throw new EntregaInvalidaError('Informe o que entregar: arquivos (`uploadId` ou `arquivos`) e/ou `texto`.');
    }
    if (inline.reduce((soma, a) => soma + a.bytes.length, 0) > MAX_BYTES_INLINE) {
      throw new EntregaInvalidaError(
        'Arquivos em `arquivos` passam do teto do serviço para base64 (2 MB somados; pelo MCP o atalho só cabe arquivo de ~64 KB): ' +
          'use o link de upload de preparar_envio_tarefa.',
      );
    }

    let itemId: string | undefined;
    let arquivos: ArquivoResumo[] = [];
    if (p.uploadId !== undefined) {
      const guardado = this.uploads.ler(p.uploadId, quem.userId);
      if (!guardado || guardado.cmid !== p.tarefaId || guardado.conta !== conta) {
        throw new EntregaInvalidaError('Upload não encontrado para esta tarefa (expirado ou de outra tarefa): envie os arquivos de novo.');
      }
      itemId = guardado.itemId;
      arquivos = guardado.arquivos;
    } else if (inline.length > 0) {
      validarArquivos(r, inline);
      const subido = await this.consulta.subirArquivosEntrega(quem, conta, inline);
      itemId = subido.itemId;
      arquivos = subido.arquivos;
    }

    const agora = this.now();
    const atrasada = r.prazo !== undefined && r.prazo.getTime() < agora;
    const substituiArquivos = itemId !== undefined && r.arquivosAtuais.length > 0;
    const substituiEntrega = !soFinaliza && (r.estado === 'entregue' || substituiArquivos);
    const c = this.confirmacoes.criar({
      userId: quem.userId,
      acao,
      conta,
      cursoId: p.cursoId,
      cmid: p.tarefaId,
      assignId: r.tarefaId,
      ...(itemId !== undefined ? { itemId } : {}),
      ...(texto !== undefined ? { texto } : {}),
      estado: r.estado,
      arquivosAtuais: digital(r.arquivosAtuais),
    });
    return {
      confirmacaoId: c.id,
      expiraEm: c.expiresAt,
      acao,
      tarefa: r.titulo,
      arquivos: arquivos.map((a) => ({ ...a })),
      ...(texto !== undefined ? { texto } : {}),
      efeito: efeito(r, acao, { soFinaliza, substituiArquivos, substituiEntrega, atrasada }),
      ...(r.prazo ? { prazo: r.prazo } : {}),
      atrasada,
      substituiEntrega,
      ...(soFinaliza ? { arquivosAtuais: r.arquivosAtuais.map((a) => ({ ...a })), temTextoAtual: r.temTextoAtual } : {}),
    };
  }

  /**
   * Segunda fase, com o "sim" da pessoa: confere que a confirmação é desta tarefa (sem gastá-la se não for), relê a tarefa
   * (pode ter fechado ou mudado no AVA), grava e, se a tarefa tem o botão de enviar, entrega. Depois de uma escrita que deu
   * certo nunca lança erro comum: o que falhar depois vira `EntregaParcialError` ou `estado: 'desconhecido'`.
   */
  async confirmar(quem: Quem, acao: Acao, confirmacaoId: string, alvo: AlvoConfirmacao): Promise<EntregaFeita> {
    const contaAlvo = alvo.conta !== undefined ? (await this.consulta.conta(quem, 'MOODLE', alvo.conta)).accountKey : undefined;
    // Sem `await` entre ler e consumir: duas confirmações simultâneas não gravam duas vezes.
    const lida = this.confirmacoes.ler(confirmacaoId, quem.userId, acao);
    if (!lida) throw new EntregaInvalidaError('Confirmação inválida, expirada ou já usada: peça o resumo de novo.');
    if (lida.cursoId !== alvo.cursoId || lida.cmid !== alvo.tarefaId || (contaAlvo !== undefined && contaAlvo !== lida.conta)) {
      throw new EntregaInvalidaError('Essa confirmação é de outra tarefa: peça um novo resumo.');
    }
    const c = this.confirmacoes.consumir(confirmacaoId, quem.userId, acao)!;
    const r = await this.consulta.requisitosEntrega(quem, c.conta, c.cursoId, c.cmid);
    this.validarTarefa(r, acao);
    if (r.tarefaId !== c.assignId || r.estado !== c.estado || digital(r.arquivosAtuais) !== c.arquivosAtuais) {
      throw new EntregaInvalidaError('A entrega mudou no AVA desde o resumo: peça um novo resumo.');
    }

    let estado: 'nova' | 'rascunho' | 'entregue' | undefined = r.estado;
    // O motivo vale só para a ÚLTIMA leitura: se o envio leu o estado, a falha da leitura depois do salvar não importa mais.
    let motivoLeitura: string | undefined;
    const salva = c.itemId !== undefined || c.texto !== undefined;
    if (salva) {
      ({ estado, motivoLeitura } = await this.consulta.salvarEntrega(quem, c.conta, {
        tarefaId: c.assignId,
        ...(c.itemId !== undefined ? { itemId: c.itemId } : {}),
        ...(c.texto !== undefined ? { texto: c.texto } : {}),
      }));
    }
    if (acao === 'enviar' && r.exigeBotaoEnviar) {
      try {
        ({ estado, motivoLeitura } = await this.consulta.finalizarEntrega(quem, c.conta, c.assignId));
      } catch (e) {
        // Salvou agora e o envio falhou: dizer só "falhou" faria a pessoa achar que nada foi gravado.
        if (salva) throw new EntregaParcialError(SALVO_SEM_ENVIAR);
        throw e;
      }
    }
    if (estado === undefined) {
      return { estado: 'desconhecido', aviso: GRAVADO_SEM_ESTADO, ...(motivoLeitura !== undefined ? { motivoLeitura } : {}) };
    }
    return { estado, entregue: estado === 'entregue' };
  }

  /** Regras da tarefa para gravar com esta ação: as de `motivoRecusa` mais rascunho só com o botão de enviar. */
  private validarTarefa(r: RequisitosEntrega, acao: Acao): void {
    if (acao === 'rascunho' && !r.exigeBotaoEnviar) {
      throw new EntregaInvalidaError('Nesta tarefa salvar já entrega ao professor (não há rascunho): use enviar_tarefa.');
    }
    const motivo = this.motivoRecusa(r);
    if (motivo !== undefined) throw new EntregaInvalidaError(motivo);
  }

  /**
   * Por que este serviço não entrega a tarefa (ou `undefined` se pode): v1 sem grupo, declaração nem tarefa que aceita
   * arquivo E texto (não se sabe se omitir um apaga o outro já entregue), janela aberta e entrega editável.
   */
  private motivoRecusa(r: RequisitosEntrega): string | undefined {
    if (r.aceitaArquivo && r.aceitaTexto) return `O envio dessa tarefa (aceita arquivo e texto) ainda não é suportado: precisa ser ${PELO_AVA}.`;
    if (r.emGrupo) return `Tarefa em grupo ainda não é suportada: precisa ser ${PELO_AVA}.`;
    if (r.exigeDeclaracao) return `Tarefa que exige declaração de autoria ainda não é suportada: precisa ser ${PELO_AVA}.`;
    const agora = this.now();
    if (r.abreEm && r.abreEm.getTime() > agora) return 'A tarefa ainda não está aberta para entrega.';
    if (r.limite && r.limite.getTime() <= agora) return 'O prazo final da tarefa já passou: o AVA não aceita mais entregas.';
    if (!r.podeEditar) return 'O AVA não permite alterar a entrega desta tarefa.';
    return undefined;
  }
}

/** O menor entre o limite da tarefa e o teto do serviço (limite ausente ou 0 da tarefa = só o teto). */
function limitesEfetivos(r: RequisitosEntrega): LimitesArquivos {
  const menor = (daTarefa: number | undefined, teto: number) => (daTarefa !== undefined && daTarefa > 0 ? Math.min(daTarefa, teto) : teto);
  return {
    maxArquivos: menor(r.maxArquivos, LIMITES_UPLOAD.maxArquivos),
    maxBytesPorArquivo: menor(r.maxBytesPorArquivo, LIMITES_UPLOAD.maxBytesPorArquivo),
    maxBytesTotal: LIMITES_UPLOAD.maxBytesTotal,
    extensoes: [...r.extensoes],
  };
}

/** Impressão digital dos arquivos atuais (nomes e tamanhos), para notar mudança entre o resumo e a confirmação. */
function digital(arquivos: ArquivoResumo[]): string {
  return JSON.stringify(arquivos.map((a) => [a.nome, a.tamanhoBytes]));
}

/**
 * Quantidade, tamanho por arquivo, soma e extensão, conforme a tarefa e os tetos do serviço. A extensão é a do nome que o
 * Moodle recebe (`nomeSeguro`) e só é conferida quando a lista da tarefa é só de extensões (grupos, MIME e `*` o Moodle julga).
 * Mensagens só com os limites (sem nomes nem conteúdo).
 */
function validarArquivos(r: RequisitosEntrega, arquivos: ArquivoParaEnvio[]): void {
  if (!r.aceitaArquivo) throw new EntregaInvalidaError('Esta tarefa não aceita arquivos: entregue só o texto online.');
  const l = limitesEfetivos(r);
  if (arquivos.length > l.maxArquivos) {
    throw new EntregaInvalidaError(`A tarefa aceita no máximo ${l.maxArquivos} arquivo(s) por envio.`);
  }
  if (arquivos.some((a) => a.bytes.length > l.maxBytesPorArquivo)) {
    throw new EntregaInvalidaError(`Algum arquivo passa do limite (${l.maxBytesPorArquivo} bytes por arquivo).`);
  }
  if (arquivos.reduce((soma, a) => soma + a.bytes.length, 0) > l.maxBytesTotal) {
    throw new EntregaInvalidaError(`Os arquivos passam do limite de ${l.maxBytesTotal} bytes somados por envio.`);
  }
  const soExtensoes = r.extensoes.length > 0 && r.extensoes.every((e) => e.startsWith('.'));
  if (soExtensoes && arquivos.some((a) => !r.extensoes.includes(extensao(nomeSeguro(a.nome))))) {
    throw new EntregaInvalidaError(`Algum arquivo tem extensão não aceita. Aceitas: ${r.extensoes.join(', ')}.`);
  }
}

function extensao(nome: string): string {
  const i = nome.lastIndexOf('.');
  return i <= 0 ? '' : nome.slice(i).toLowerCase();
}

/** O que a confirmação vai fazer, sem prometer rascunho quando salvar entrega: `entrega = acao==='enviar' || !exigeBotaoEnviar`. */
function efeito(
  r: RequisitosEntrega,
  acao: Acao,
  o: { soFinaliza: boolean; substituiArquivos: boolean; substituiEntrega: boolean; atrasada: boolean },
): string {
  const partes: string[] = [];
  if (!r.exigeBotaoEnviar) partes.push('Salvar nesta tarefa já entrega ao professor (ela não tem o botão de enviar).');
  else if (acao === 'rascunho') partes.push('Só salva como rascunho: o professor ainda não recebe. Para mandar, use enviar_tarefa.');
  else if (o.soFinaliza) partes.push('Manda para avaliação o rascunho que já está no AVA: é a entrega ao professor.');
  else partes.push('Salva e entrega ao professor para avaliação.');
  if (o.substituiArquivos) partes.push(`Os arquivos novos substituem os ${r.arquivosAtuais.length} arquivo(s) atuais.`);
  else if (o.substituiEntrega) partes.push('Substitui a entrega atual.');
  if (o.atrasada) partes.push('Já passou do prazo: fica marcada como atrasada.');
  return partes.join(' ');
}
