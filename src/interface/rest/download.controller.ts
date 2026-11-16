import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ConsultaService,
  ContaAmbiguaError,
  FonteNaoConectadaError,
  FonteSemLeituraError,
} from '../../application/live/consulta.service';
import { DownloadLinks } from '../../application/live/download-links';
import { SourceError } from '../../application/ports/source-gateway';

/** `Content-Disposition` seguro: nome ASCII de reserva + `filename*` em UTF-8. */
export function contentDisposition(nome: string): string {
  const limpo = nome.replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'anexo';
  const ascii = limpo.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(limpo)}`;
}

/**
 * GET /download/:id — o link gerado por `baixar_anexo`. O próprio id (aleatório, uso único, ~10 min) é a
 * credencial; não há Bearer, para funcionar com curl/navegador na máquina da pessoa. O arquivo vem da fonte na hora
 * e é repassado sem ser guardado.
 */
@Controller('download')
export class DownloadController {
  constructor(
    private readonly links: DownloadLinks,
    private readonly consulta: ConsultaService,
  ) {}

  @Get(':id')
  async baixar(@Param('id') id: string, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const t = this.links.consumir(id);
    if (!t) {
      res.status(404).json({ erro: 'LINK_INVALIDO', mensagem: 'Link expirado, já usado ou inexistente: peça outro.' });
      return;
    }
    try {
      // O ticket guarda só o usuário (sem cliente nem K): basta para fontes com token guardado.
      const f = await this.consulta.baixar({ userId: t.userId }, t.provider, t.conta, t.ref);
      res.setHeader('Content-Type', f.mimeType);
      res.setHeader('Content-Disposition', contentDisposition(f.fileName ?? t.nome ?? 'anexo'));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(Buffer.from(f.bytes));
    } catch (e) {
      const status =
        e instanceof FonteNaoConectadaError || e instanceof ContaAmbiguaError
          ? 409
          : e instanceof FonteSemLeituraError
            ? 501
            : e instanceof SourceError && e.code === 'UNSUPPORTED_SCOPE'
              ? 400 // pedido inválido (ex.: arquivo que não é anexo do Classroom), não falha da fonte
              : e instanceof SourceError && e.code === 'NO_ACCESS'
                ? 403 // sem acesso ao arquivo (ex.: Drive não compartilhado), não falha da fonte
                : e instanceof SourceError
                  ? 502
                  : 500;
      const msg = e instanceof Error && status !== 500 ? e.message : 'Falha ao baixar o arquivo';
      res.status(status).json({ erro: e instanceof SourceError ? e.code : 'ERRO', mensagem: msg });
    }
  }
}
