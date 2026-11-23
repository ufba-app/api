import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EntregaInvalidaError, FonteNaoConectadaError } from '../../application/live/consulta.service';
import { EntregaService, LinkUploadInvalidoError } from '../../application/live/entrega.service';
import { SourceError } from '../../application/ports/source-gateway';

/** Arquivo do multer (memória); tipado aqui para não depender de `@types/multer`. */
interface ArquivoRecebido {
  originalname: string;
  buffer: Buffer;
}

/** Parte mínima do multer usada aqui (sem `@types/multer` instalado). */
interface MulterLike {
  (opts: { storage: unknown; limits: { fileSize: number; files: number } }): {
    any(): (req: Request, res: Response, cb: (err?: unknown) => void) => void;
  };
  memoryStorage(): unknown;
  MulterError: new (...a: never[]) => Error & { code: string };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const multer = require('multer') as MulterLike;

const MAX_BYTES_ARQUIVO = 100 * 1024 * 1024;
const MAX_ARQUIVOS = 20;
/** Folga de multipart (fronteiras, cabeçalhos das partes e campos) sobre o total de arquivos. */
const FOLGA_MULTIPART = 64 * 1024;

/** Mesmos cabeçalhos dos downloads: nada de cache, indexação nem referer (o id é a credencial). */
function headersSeguros(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function lerArquivos(req: Request, res: Response, limits: { fileSize: number; files: number }): Promise<ArquivoRecebido[]> {
  const mw = multer({ storage: multer.memoryStorage(), limits }).any();
  return new Promise((resolve, reject) => {
    mw(req, res, (err: unknown) => (err ? reject(err) : resolve(((req as Request & { files?: ArquivoRecebido[] }).files) ?? [])));
  });
}

/**
 * POST /upload/:id — o link gerado por `preparar_envio_tarefa`. O id (aleatório, uso único) é a credencial; não há
 * Bearer. Os arquivos vão para a área de rascunho do Moodle e nada deles é guardado aqui. Fora do contrato OpenAPI.
 */
@Controller('upload')
export class UploadController {
  constructor(private readonly entrega: EntregaService) {}

  @Post(':id')
  @HttpCode(200)
  async enviar(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    headersSeguros(res);
    // Recusa antes de ler o corpo: link desconhecido não faz o servidor guardar nada em memória.
    const limites = this.entrega.espiarUpload(id);
    if (!limites) {
      res.status(404).json({ erro: 'LINK_INVALIDO', mensagem: 'Link expirado, já usado ou inexistente: peça outro.' });
      return;
    }
    const fileSize = Math.min(limites.maxBytesPorArquivo && limites.maxBytesPorArquivo > 0 ? limites.maxBytesPorArquivo : MAX_BYTES_ARQUIVO, MAX_BYTES_ARQUIVO);
    const files = Math.min(limites.maxArquivos && limites.maxArquivos > 0 ? limites.maxArquivos : MAX_ARQUIVOS, MAX_ARQUIVOS);
    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > files * fileSize + FOLGA_MULTIPART) {
      res.status(413).json({ erro: 'ARQUIVO_GRANDE_DEMAIS', mensagem: 'O envio passa do limite desta tarefa.' });
      return;
    }
    let recebidos: ArquivoRecebido[];
    try {
      recebidos = await lerArquivos(req, res, { fileSize, files });
    } catch (e) {
      if (e instanceof multer.MulterError && e.code === 'LIMIT_FILE_SIZE') {
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
      const r = await this.entrega.receberUpload(
        id,
        recebidos.map((f) => ({ nome: f.originalname, bytes: new Uint8Array(f.buffer) })),
      );
      res.status(200).json({ arquivos: r.arquivos });
    } catch (e) {
      // Mensagens de erro nunca citam id, nome nem conteúdo (o serviço só fala de regras); o resto vira texto fixo.
      if (e instanceof LinkUploadInvalidoError) {
        res.status(404).json({ erro: 'LINK_INVALIDO', mensagem: 'Link expirado, já usado ou inexistente: peça outro.' });
      } else if (e instanceof EntregaInvalidaError) {
        res.status(400).json({ erro: 'ENTREGA_INVALIDA', mensagem: e.message });
      } else if (e instanceof FonteNaoConectadaError || (e instanceof SourceError && (e.code === 'REAUTH_NEEDED' || e.code === 'CREDENTIAL_REJECTED'))) {
        res.status(409).json({ erro: e instanceof SourceError ? e.code : 'ERRO', mensagem: e.message });
      } else if (e instanceof SourceError) {
        res.status(502).json({ erro: e.code, mensagem: e.message });
      } else {
        res.status(500).json({ erro: 'ERRO', mensagem: 'Falha ao receber o arquivo' });
      }
    }
  }
}
