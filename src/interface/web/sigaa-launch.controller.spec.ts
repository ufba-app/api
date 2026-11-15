import { Secret } from '../../application/shared/secret';
import { renderLaunchError, renderLaunchPage } from './sigaa-launch.controller';

const form = { action: '/sigaa/logar.do?dispatch=logOn', fields: { token: 't0k', width: '1920' } };

describe('renderLaunchPage', () => {
  const html = renderLaunchPage({ login: '12345678901', password: Secret.of('s3nha-ç'), form }, 'NONCE123');

  it('envia ao login do SIGAA em ISO-8859-1, com os campos da própria página e o script com nonce', () => {
    expect(html).toContain('action="https://sigaa.ufba.br/sigaa/logar.do?dispatch=logOn"');
    expect(html).toContain('method="post"');
    expect(html).toContain('accept-charset="ISO-8859-1"');
    expect(html).toContain('name="token" value="t0k"');
    expect(html).toContain('name="user.login" value="12345678901"');
    expect(html).toContain('name="user.senha" value="s3nha-ç"');
    expect(html).toContain('<script nonce="NONCE123">document.getElementById(\'f\').submit();</script>');
    expect(html).toContain('<noscript>');
  });

  it('a senha aparece uma única vez e nada vai para fora do SIGAA', () => {
    expect(html.split('s3nha-ç').length - 1).toBe(1);
    expect(html.match(/action="/g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:\/\/(?!sigaa\.ufba\.br)/);
  });

  it('escapa aspas e sinais em qualquer valor (senha com "><script> não quebra o HTML)', () => {
    const evil = renderLaunchPage({ login: 'a"b', password: Secret.of('"><script>alert(1)</script>'), form }, 'N');
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(evil).toContain('value="a&quot;b"');
  });

  it('action vindo de fora do SIGAA (sem barra inicial) cai no padrão: nunca um endereço de terceiro', () => {
    const out = renderLaunchPage({ login: 'x', password: Secret.of('y'), form: { action: 'https://evil.test/x', fields: {} } }, 'N');
    expect(out).toContain('action="https://sigaa.ufba.br/sigaa/logar.do?dispatch=logOn"');
    expect(out).not.toContain('evil.test');
  });
});

describe('renderLaunchError', () => {
  it('mensagem em pt-BR escapada, sem formulário nem script', () => {
    const out = renderLaunchError('Link <inválido>');
    expect(out).toContain('Link &lt;inválido&gt;');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<script');
  });
});
