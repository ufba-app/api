import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Transform, type Writable } from 'node:stream';
import { EntregaInvalidaError, FonteNaoConectadaError } from '../../application/live/consulta.service';
import { EntregaService, LIMITES_UPLOAD, LinkUploadInvalidoError } from '../../application/live/entrega.service';
import { SourceError } from '../../application/ports/source-gateway';

/** Arquivo do multer (memória); tipado aqui para não depender de `@types/multer`. */
interface ArquivoRecebido {
  originalname: string;
  buffer: Buffer;
}

interface LimitesMulter {
  fileSize: number;
  files: number;
  fields: number;
  parts: number;
  fieldSize: number;
}

/** Parte mínima do multer usada aqui (sem `@types/multer` instalado). */
interface MulterLike {
  (opts: {
    storage: unknown;
    limits: LimitesMulter;
    defParamCharset: string;
    streamHandler: (req: Request, busboy: Writable) => void;
  }): {
    any(): (req: Request, res: Response, cb: (err?: unknown) => void) => void;
  };
  memoryStorage(): unknown;
  MulterError: new (...a: never[]) => Error & { code: string };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require('multer') as MulterLike;

/** Folga de multipart (fronteiras, cabeçalhos das partes e campos) sobre o total de arquivos. */
const FOLGA_MULTIPART = 64 * 1024;
/** Campos que não são arquivo: nenhum é usado; poucos e pequenos. */
const MAX_CAMPOS = 5;
const MAX_BYTES_CAMPO = 1024;
/** Envios lendo corpo ou subindo ao Moodle ao mesmo tempo, neste processo (cada um pode ter até 50 MB em memória). */
const MAX_EM_ANDAMENTO = 2;

/** O corpo passou do teto somado do envio (vale também sem Content-Length, em chunked). */
class CorpoGrandeDemaisError extends Error {}

/** Mesmos cabeçalhos dos downloads: nada de cache, indexação nem referer (o id é a credencial). */
function headersSeguros(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** Conta os bytes do corpo a caminho do busboy e corta quando passam de `max`. */
function corpoLimitado(max: number) {
  return (req: Request, busboy: Writable): void => {
    let total = 0;
    const contador = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > max) cb(new CorpoGrandeDemaisError('corpo grande demais'));
        else cb(null, chunk);
      },
    });
    contador.on('error', (e) => {
      req.unpipe(contador);
      busboy.destroy(e);
    });
    req.pipe(contador).pipe(busboy);
  };
}

function lerArquivos(req: Request, res: Response, limits: LimitesMulter, maxCorpo: number): Promise<ArquivoRecebido[]> {
  // Nomes de arquivo em UTF-8 (o padrão do multer 2.x é latin1, que estraga "relatório.pdf").
  const mw = multer({ storage: multer.memoryStorage(), limits, defParamCharset: 'utf8', streamHandler: corpoLimitado(maxCorpo) }).any();
  return new Promise((resolve, reject) => {
    mw(req, res, (err: unknown) => (err ? reject(err) : resolve(((req as Request & { files?: ArquivoRecebido[] }).files) ?? [])));
  });
}

const limite = (v: number | undefined, teto: number): number => (v !== undefined && v > 0 ? Math.min(v, teto) : teto);

/**
 * POST /upload/:id — o link gerado por `preparar_envio_tarefa`. O id (aleatório, uso único) é a credencial; não há
 * Bearer. Os arquivos vão para a área de rascunho do Moodle e nada deles é guardado aqui. Fora do contrato OpenAPI.
 */
@Controller('upload')
export class UploadController {
  private emAndamento = 0;

  constructor(private readonly entrega: EntregaService) {}

  @Post(':id')
  @HttpCode(200)
  async enviar(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    headersSeguros(res);
    if (this.emAndamento >= MAX_EM_ANDAMENTO) {
      res.status(429).json({ erro: 'ENVIO_OCUPADO', mensagem: 'Há envios demais em andamento: tente de novo em instantes.' });
      return;
    }
    // Recusa antes de ler o corpo: link desconhecido não faz o servidor guardar nada em memória.
    const limites = this.entrega.espiarUpload(id);
    if (!limites) {
      res.status(404).json({ erro: 'LINK_INVALIDO', mensagem: 'Link expirado, já usado ou inexistente: peça outro.' });
      return;
    }
    // Reserva antes de ler: N POSTs simultâneos no mesmo link não guardam N corpos.
    if (!this.entrega.reservarUpload(id)) {
      res.status(429).json({ erro: 'ENVIO_OCUPADO', mensagem: 'Já há um envio em andamento por este link: espere ele terminar.' });
      return;
    }
    this.emAndamento++;
    try {
      await this.receber(id, limites, req, res);
    } finally {
      this.emAndamento--;
      // Sem efeito se o link já foi gasto pelo serviço; senão (corpo inválido, conexão caída) o link volta a valer.
      this.entrega.liberarUpload(id);
    }
  }

  private async receber(
    id: string,
    limites: { maxArquivos?: number; maxBytesPorArquivo?: number; maxBytesTotal?: number },
    req: Request,
    res: Response,
  ): Promise<void> {
    const fileSize = limite(limites.maxBytesPorArquivo, LIMITES_UPLOAD.maxBytesPorArquivo);
    const files = limite(limites.maxArquivos, LIMITES_UPLOAD.maxArquivos);
    const maxCorpo = Math.min(files * fileSize, limite(limites.maxBytesTotal, LIMITES_UPLOAD.maxBytesTotal)) + FOLGA_MULTIPART;
    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > maxCorpo) {
      res.status(413).json({ erro: 'ARQUIVO_GRANDE_DEMAIS', mensagem: 'O envio passa do limite desta tarefa.' });
      return;
    }
    let recebidos: ArquivoRecebido[];
    try {
      recebidos = await lerArquivos(req, res, { fileSize, files, fields: MAX_CAMPOS, parts: files + MAX_CAMPOS, fieldSize: MAX_BYTES_CAMPO }, maxCorpo);
    } catch (e) {
      if (e instanceof CorpoGrandeDemaisError) {
        res.status(413).json({ erro: 'ARQUIVO_GRANDE_DEMAIS', mensagem: 'O envio passa do limite desta tarefa.' });
      } else if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ erro: 'ARQUIVO_GRANDE_DEMAIS', mensagem: 'Algum arquivo passa do limite desta tarefa.' });
      } else if (e instanceof multer.MulterError) {
        res.status(400).json({ erro: 'ENVIO_INVALIDO', mensagem: 'Envio fora dos limites desta tarefa (arquivos demais ou campos inesperados).' });
      } else {
        res.status(400).json({ erro: 'ENVIO_INVALIDO', mensagem: 'Envio multipart inválido.' });
      }
      return;
    }
    if (recebidos.length === 0) {
      res.status(400).json({ erro: 'SEM_ARQUIVO', mensagem: 'Nenhum arquivo recebido: envie ao menos um arquivo (multipart).' });
      return;
    }
    try {
      // O Buffer do multer já é um Uint8Array: vai direto, sem cópia.
      const r = await this.entrega.receberUpload(
        id,
        recebidos.map((f) => ({ nome: f.originalname, bytes: f.buffer })),
      );
      res.status(200).json({ arquivos: r.arquivos });
    } catch (e) {
      // Mensagens de erro nunca citam id, nome, conta nem conteúdo (o serviço só fala de regras); o resto vira texto fixo.
      if (e instanceof LinkUploadInvalidoError) {
        res.status(404).json({ erro: 'LINK_INVALIDO', mensagem: 'Link expirado, já usado ou inexistente: peça outro.' });
      } else if (e instanceof EntregaInvalidaError) {
        res.status(400).json({ erro: 'ENTREGA_INVALIDA', mensagem: e.message });
      } else if (e instanceof FonteNaoConectadaError || (e instanceof SourceError && (e.code === 'REAUTH_NEEDED' || e.code === 'CREDENTIAL_REJECTED'))) {
        res.status(409).json({
          erro: e instanceof SourceError ? e.code : 'ERRO',
          mensagem: 'O AVA precisa ser reconectado no ufba.app antes de enviar arquivos: reconecte e peça outro link.',
        });
      } else if (e instanceof SourceError) {
        res.status(502).json({ erro: e.code, mensagem: e.message });
      } else {
        res.status(500).json({ erro: 'ERRO', mensagem: 'Falha ao receber o arquivo' });
      }
    }
  }
}
