import { Injectable } from '@nestjs/common';
import type { ArquivoParaEnvio, RequisitosEntrega } from '../ports/live-source';
import { ConsultaService, EntregaInvalidaError, type Quem } from './consulta.service';
import { ConfirmacoesEntrega, UploadLinks } from './entrega-links';

/** Teto dos arquivos mandados em base64 direto no pedido (soma de todos). Arquivo maior vai pelo link de upload. */
export const MAX_BYTES_INLINE = 2 * 1024 * 1024;

type Acao = 'rascunho' | 'enviar';
type ArquivoResumo = { nome: string; tamanhoBytes: number };

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
}

export interface EntregaFeita {
  estado: 'nova' | 'rascunho' | 'entregue';
  entregue: boolean;
}

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

  /** Lê o que a tarefa pede e, se ela aceita arquivo, abre um link de upload de uso único. Não escreve nada. */
  async preparar(quem: Quem, i: { conta?: string; cursoId: string; tarefaId: string }): Promise<PreparoEntrega> {
    const conta = (await this.consulta.conta(quem, 'MOODLE', i.conta)).accountKey;
    const requisitos = await this.consulta.requisitosEntrega(quem, conta, i.cursoId, i.tarefaId);
    if (!requisitos.aceitaArquivo) return { requisitos };
    const link = this.uploads.abrir({ userId: quem.userId, conta, cursoId: i.cursoId, tarefaId: i.tarefaId, requisitos });
    return { requisitos, uploadId: link.id, expiraEm: link.expiresAt };
  }

  /** Arquivos chegados pelo link de upload: valida contra a tarefa, sobe à área de rascunho do Moodle e guarda o resultado. */
  async receberUpload(uploadId: string, arquivos: ArquivoParaEnvio[]): Promise<{ arquivos: ArquivoResumo[] }> {
    const ticket = this.uploads.consumir(uploadId);
    if (!ticket) throw new EntregaInvalidaError('Link de upload inválido, expirado ou já usado: chame preparar_envio_tarefa de novo.');
    if (arquivos.length === 0) throw new EntregaInvalidaError('Nenhum arquivo recebido.');
    validarArquivos(ticket.requisitos, arquivos);
    const quem: Quem = { userId: ticket.userId };
    const subido = await this.consulta.subirArquivosEntrega(quem, ticket.conta, arquivos);
    this.uploads.guardar(uploadId, {
      userId: ticket.userId,
      conta: ticket.conta,
      tarefaId: ticket.tarefaId,
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
      throw new EntregaInvalidaError('Arquivos em `arquivos` passam de 2 MB somados: use o link de upload de preparar_envio_tarefa.');
    }

    let itemId: string | undefined;
    let arquivos: ArquivoResumo[] = [];
    if (p.uploadId !== undefined) {
      const guardado = this.uploads.ler(p.uploadId, quem.userId);
      if (!guardado || guardado.tarefaId !== p.tarefaId || guardado.conta !== conta) {
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
      tarefaId: p.tarefaId,
      ...(itemId !== undefined ? { itemId } : {}),
      ...(texto !== undefined ? { texto } : {}),
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
    };
  }

  /** Segunda fase, com o "sim" da pessoa: relê a tarefa (pode ter fechado), grava e, se a tarefa tem o botão de enviar, entrega. */
  async confirmar(quem: Quem, acao: Acao, confirmacaoId: string): Promise<EntregaFeita> {
    const c = this.confirmacoes.consumir(confirmacaoId, quem.userId, acao);
    if (!c) throw new EntregaInvalidaError('Confirmação inválida, expirada ou já usada: peça o resumo de novo.');
    const r = await this.consulta.requisitosEntrega(quem, c.conta, c.cursoId, c.tarefaId);
    this.validarTarefa(r, acao);
    let estado: EntregaFeita['estado'] = r.estado;
    if (c.itemId !== undefined || c.texto !== undefined) {
      estado = (
        await this.consulta.salvarEntrega(quem, c.conta, {
          tarefaId: c.tarefaId,
          ...(c.itemId !== undefined ? { itemId: c.itemId } : {}),
          ...(c.texto !== undefined ? { texto: c.texto } : {}),
        })
      ).estado;
    }
    if (acao === 'enviar' && r.exigeBotaoEnviar) estado = (await this.consulta.finalizarEntrega(quem, c.conta, c.tarefaId)).estado;
    return { estado, entregue: estado === 'entregue' };
  }

  /** Regras da tarefa que valem para qualquer conteúdo: v1 sem grupo nem declaração, janela aberta, entrega editável, rascunho só com botão. */
  private validarTarefa(r: RequisitosEntrega, acao: Acao): void {
    if (acao === 'rascunho' && !r.exigeBotaoEnviar) {
      throw new EntregaInvalidaError('Nesta tarefa salvar já entrega ao professor (não há rascunho): use enviar_tarefa.');
    }
    if (r.emGrupo) throw new EntregaInvalidaError(`Tarefa em grupo ainda não é suportada: precisa ser ${PELO_AVA}.`);
    if (r.exigeDeclaracao) throw new EntregaInvalidaError(`Tarefa que exige declaração de autoria ainda não é suportada: precisa ser ${PELO_AVA}.`);
    const agora = this.now();
    if (r.abreEm && r.abreEm.getTime() > agora) throw new EntregaInvalidaError('A tarefa ainda não está aberta para entrega.');
    if (r.limite && r.limite.getTime() <= agora) throw new EntregaInvalidaError('O prazo final da tarefa já passou: o AVA não aceita mais entregas.');
    if (!r.podeEditar) throw new EntregaInvalidaError('O AVA não permite alterar a entrega desta tarefa.');
  }
}

/** Quantidade, tamanho por arquivo e extensão, conforme a tarefa. Mensagens só com os limites (sem nomes nem conteúdo). */
function validarArquivos(r: RequisitosEntrega, arquivos: ArquivoParaEnvio[]): void {
  if (!r.aceitaArquivo) throw new EntregaInvalidaError('Esta tarefa não aceita arquivos: entregue só o texto online.');
  if (r.maxArquivos !== undefined && arquivos.length > r.maxArquivos) {
    throw new EntregaInvalidaError(`A tarefa aceita no máximo ${r.maxArquivos} arquivo(s).`);
  }
  if (r.maxBytesPorArquivo !== undefined && arquivos.some((a) => a.bytes.length > r.maxBytesPorArquivo!)) {
    throw new EntregaInvalidaError(`Algum arquivo passa do limite da tarefa (${r.maxBytesPorArquivo} bytes por arquivo).`);
  }
  if (r.extensoes.length > 0 && arquivos.some((a) => !r.extensoes.includes(extensao(a.nome)))) {
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
