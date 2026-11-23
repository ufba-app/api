import { Controller, HttpCode, Param, Post, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { EntregaInvalidaError, FonteNaoConectadaError } from '../../application/live/consulta.service';
import { EntregaService, LinkUploadInvalidoError } from '../../application/live/entrega.service';
import { SourceError } from '../../application/ports/source-gateway';

/** Arquivo do multer (memória); tipado aqui para não depender de `@types/multer`. */
interface ArquivoRecebido {
  originalname: string;
  buffer: Buffer;
}

/** Mesmos cabeçalhos dos downloads: nada de cache, indexação nem referer (o id é a credencial). */
function headersSeguros(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 100 * 1024 * 1024, files: 20 } }))
  async enviar(@Param('id') id: string, @UploadedFiles() files: ArquivoRecebido[] | undefined, @Res() res: Response): Promise<void> {
    headersSeguros(res);
    if (!files || files.length === 0) {
      res.status(400).json({ erro: 'SEM_ARQUIVO', mensagem: 'Nenhum arquivo recebido: envie ao menos um arquivo (multipart).' });
      return;
    }
    try {
      const r = await this.entrega.receberUpload(
        id,
        files.map((f) => ({ nome: f.originalname, bytes: new Uint8Array(f.buffer) })),
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
