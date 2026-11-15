import { randomBytes } from 'node:crypto';
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LaunchError, SigaaLaunch, type LaunchForm } from '../../application/web/sigaa-launch.service';
import type { WebPrincipal } from '../../application/web/web-api';
import { SIGAA_ORIGIN } from '../../application/ports/sigaa-launch';
import { OptionalSessionGuard, Principal } from './web-auth';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const STYLE = 'body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#222}';

/**
 * Página que envia o login ao SIGAA. A senha só aparece AQUI (nesta resposta de navegação), nunca no JavaScript do painel.
 * O formulário vai em ISO-8859-1 (é como o SIGAA lê o corpo) e o script só o envia.
 */
export function renderLaunchPage(i: LaunchForm, nonce: string): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const action = i.form.action.startsWith('/') ? i.form.action : '/sigaa/logar.do?dispatch=logOn';
  const fields = Object.entries(i.form.fields).map(([k, v]) => hidden(k, v));
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Abrindo o SIGAA</title><style nonce="${nonce}">${STYLE}</style></head>
<body><p>Abrindo o SIGAA…</p>
<form id="f" method="post" action="${escapeHtml(SIGAA_ORIGIN + action)}" accept-charset="ISO-8859-1" autocomplete="off">
${fields.join('\n')}
${hidden('user.login', i.login)}
${hidden('user.senha', i.password.reveal())}
<noscript><button type="submit">Abrir o SIGAA</button></noscript>
</form>
<script nonce="${nonce}">document.getElementById('f').submit();</script>
</body></html>`;
}

export function renderLaunchError(message: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Não foi possível abrir o SIGAA</title><style>${STYLE}</style></head>
<body><h1>Não foi possível abrir o SIGAA</h1><p>${escapeHtml(message)}</p></body></html>`;
}

/**
 * `GET /sigaa/launch?t=`: a navegação do botão "Abrir o SIGAA já logado". Fora do contrato JSON (devolve uma página, como as
 * telas de redirecionamento do OAuth). Só atende navegação de página inteira da própria sessão, com o token de uso único.
 */
@Controller('sigaa/launch')
@UseGuards(OptionalSessionGuard)
export class SigaaLaunchController {
  constructor(private readonly launch: SigaaLaunch) {}

  @Get()
  async open(
    @Principal() p: WebPrincipal | null,
    @Query('t') token: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action ${SIGAA_ORIGIN}; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.type('html');

    const fail = (status: number, message: string) => {
      res.status(status).send(renderLaunchError(message));
    };

    // Só navegação de página inteira: `fetch`/XHR/iframe do painel (ou de outro site) não leem esta resposta.
    if (req.get('sec-fetch-mode') !== 'navigate' || req.get('sec-fetch-dest') !== 'document') {
      return fail(403, 'Esta página só abre pelo botão do painel.');
    }
    if (!p) return fail(401, 'Sua sessão venceu. Entre no painel de novo e clique no botão.');
    if (typeof token !== 'string' || !TOKEN.test(token)) return fail(400, 'Link de abertura inválido. Volte ao painel e clique de novo.');
    try {
      res.status(200).send(renderLaunchPage(await this.launch.redeem(p, token), nonce));
    } catch (e) {
      if (e instanceof LaunchError) return fail(e.status, e.message);
      return fail(500, 'Algo deu errado ao abrir o SIGAA. Tente de novo em instantes.');
    }
  }
}
