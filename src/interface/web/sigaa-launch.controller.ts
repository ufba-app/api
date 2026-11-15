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
 * Brasão da UFBA (o mesmo de `brasao.svg` do web) em SVG inline: nada de recurso externo, e dentro da CSP da página
 * (`default-src 'none'`; as referências `#b-...` são do próprio documento). Os ids levam o prefixo `b-` para não colidirem.
 */
const BRASAO = '<svg class="mark" viewBox="0 0 256 256" fill="none" aria-hidden="true" focusable="false"><defs><path id="b-flameOuter" d="M0 -44 C 9 -33 17 -25 17 -12 C 17 1 9 9 0 9 C -9 9 -17 1 -17 -12 C -17 -25 -9 -33 0 -44 Z"></path><path id="b-flameInner" d="M0 -28 C 5 -21 10 -16 10 -8 C 10 0 5 5 0 5 C -5 5 -10 0 -10 -8 C -10 -16 -5 -21 0 -28 Z"></path><path id="b-leaf" d="M0 0 C 5 -17 18 -30 42 -33 C 39 -12 25 1 7 4 C 2 4 0 2 0 0 Z"></path><clipPath id="b-shieldClip"><path d="M60 92 C 82 86 174 86 196 92 L 196 150 C 196 180 166 194 128 202 C 90 194 60 180 60 150 Z"></path></clipPath></defs><g stroke="#4A4238" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><g fill="#D9C49C"><rect x="72" y="84" width="13" height="164" rx="6"></rect><rect x="121" y="84" width="13" height="164" rx="6"></rect><rect x="170" y="84" width="13" height="164" rx="6"></rect></g><g><use href="#b-flameOuter" x="78" y="58" fill="#F2A33C"></use><use href="#b-flameOuter" x="128" y="58" fill="#F2A33C"></use><use href="#b-flameOuter" x="178" y="58" fill="#F2A33C"></use><g stroke="none" fill="#F7E6A6"><use href="#b-flameInner" x="78" y="58"></use><use href="#b-flameInner" x="128" y="58"></use><use href="#b-flameInner" x="178" y="58"></use></g></g><g fill="#D9C49C"><rect x="63" y="58" width="30" height="20" rx="7"></rect><rect x="113" y="58" width="30" height="20" rx="7"></rect><rect x="163" y="58" width="30" height="20" rx="7"></rect></g><path fill="#2B3A8F" d="M60 92 C 82 86 174 86 196 92 L 196 150 C 196 180 166 194 128 202 C 90 194 60 180 60 150 Z"></path><g clip-path="url(#b-shieldClip)" stroke="none" fill="#FFFFFF"><path d="M96 188 C 118 164 140 142 164 112 L 172 118 C 148 148 124 170 104 194 Z"></path><use href="#b-leaf" transform="translate(164,116) rotate(-30)"></use><use href="#b-leaf" transform="translate(160,122) rotate(-95) scale(0.95)"></use><use href="#b-leaf" transform="translate(132,148) rotate(-120) scale(0.85)"></use><use href="#b-leaf" transform="translate(136,152) rotate(40) scale(0.8)"></use><use href="#b-leaf" transform="translate(106,176) rotate(-175) scale(0.75)"></use><use href="#b-leaf" transform="translate(110,180) rotate(70) scale(0.7)"></use></g><path fill="#F4F2EC" d="M18 156 C 44 178 84 188 128 188 C 172 188 212 178 238 156 L 238 186 C 212 204 172 212 128 212 C 84 212 44 204 18 186 Z"></path><path fill="#2B3A8F" d="M26 180 C 92 196 164 196 230 180 L 230 208 C 164 224 92 224 26 208 Z"></path><path fill="#2B3A8F" d="M90 222 C 114 229 142 229 166 222 L 166 242 C 142 249 114 249 90 242 Z"></path></g></svg>';

/**
 * Visual de espera igual ao do auth (`boot.css` do web): brasão centralizado pulsando. Só CSS (no <style> com nonce, que a
 * CSP já permitia); cores pelo tema do sistema; sem animação com `prefers-reduced-motion`.
 */
const LAUNCH_STYLE =
  'body{margin:0}' +
  '.boot{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#e3e8f6}' +
  '.mark{width:56px;height:56px;animation:pulse 1.8s ease-in-out infinite}' +
  '@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}' +
  '@media (prefers-color-scheme:dark){.boot{background:#12152b}}' +
  '@media (prefers-reduced-motion:reduce){.mark{animation:none}}';

/**
 * Página que envia o login ao SIGAA. A senha só aparece AQUI (nesta resposta de navegação), nunca no JavaScript do painel.
 * O formulário vai em ISO-8859-1 (é como o SIGAA lê o corpo) e o script só o envia.
 */
export function renderLaunchPage(i: LaunchForm, nonce: string): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const action = i.form.action.startsWith('/') ? i.form.action : '/sigaa/logar.do?dispatch=logOn';
  const fields = Object.entries(i.form.fields).map(([k, v]) => hidden(k, v));
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Abrindo o SIGAA</title><style nonce="${nonce}">${LAUNCH_STYLE}</style></head>
<body><div class="boot" role="status" aria-label="Abrindo o SIGAA">${BRASAO}</div>
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
