import { Logger } from '@nestjs/common';
import { SigaaLoginFormSource, type SigaaLoginForm } from '../ports/sigaa-launch';
import { SourceError } from '../ports/source-gateway';
import { Secret } from '../shared/secret';
import { LAUNCH_TTL_MS, LaunchError, SigaaLaunch } from './sigaa-launch.service';
import type { WebPrincipal } from './web-api';

const SENHA = 'senha-sintetica-123';
const P: WebPrincipal = { userId: 'u1', clientId: 'ufba-web', sessionKey: 's1', chave: Buffer.alloc(32, 1) };

class FakeForm extends SigaaLoginFormSource {
  calls = 0;
  fail = false;
  form: SigaaLoginForm = { action: '/sigaa/logar.do?dispatch=logOn', fields: { token: 't0k', width: '1920' } };
  async fetch() {
    this.calls++;
    if (this.fail) throw new SourceError('UNAVAILABLE', 'fora');
    return this.form;
  }
}

function make(open = true) {
  let t = 1_000_000;
  const form = new FakeForm();
  let aberto = open;
  const status = {
    openSigaa: async () => (aberto ? { login: '12345678901', senha: Secret.of(SENHA), credencialId: 'c', dk: Secret.of('x') } : null),
  };
  const svc = new SigaaLaunch(status as never, form, () => t);
  return { svc, form, avancar: (ms: number) => (t += ms), fechar: () => (aberto = false) };
}

describe('SigaaLaunch (abrir o SIGAA já logado)', () => {
  it('create: devolve um token de uso único e NÃO toca o SIGAA nem expõe a senha', async () => {
    const { svc, form } = make();
    const token = await svc.create(P);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(token).not.toContain(SENHA);
    expect(form.calls).toBe(0);
  });

  it('create: sem o SIGAA aberto nesta sessão, 409 source_not_connected; sem sessão do painel, 401', async () => {
    await expect(make(false).svc.create(P)).rejects.toMatchObject({ status: 409, code: 'source_not_connected' });
    await expect(make().svc.create({ ...P, sessionKey: undefined })).rejects.toMatchObject({ status: 401 });
  });

  it('redeem: entrega login, senha (Secret) e o formulário; gasta o token (segunda vez: 410)', async () => {
    const { svc, form } = make();
    const token = await svc.create(P);
    const r = await svc.redeem(P, token);
    expect(r.login).toBe('12345678901');
    expect(r.password.reveal()).toBe(SENHA);
    expect(JSON.stringify(r)).not.toContain(SENHA); // Secret: nunca vira texto por acidente
    expect(r.form).toEqual(form.form);
    await expect(svc.redeem(P, token)).rejects.toMatchObject({ status: 410 });
  });

  it('o token vence em 30 s', async () => {
    const { svc, avancar } = make();
    const token = await svc.create(P);
    avancar(LAUNCH_TTL_MS + 1);
    await expect(svc.redeem(P, token)).rejects.toMatchObject({ status: 410 });
  });

  it('o token é preso à pessoa e à sessão do painel que o pediu (e é gasto mesmo assim)', async () => {
    const { svc } = make();
    const t1 = await svc.create(P);
    await expect(svc.redeem({ ...P, sessionKey: 'outra' }, t1)).rejects.toMatchObject({ status: 403 });
    await expect(svc.redeem(P, t1)).rejects.toMatchObject({ status: 410 });
    const t2 = await svc.create(P);
    await expect(svc.redeem({ ...P, userId: 'u2' }, t2)).rejects.toMatchObject({ status: 403 });
  });

  it('token desconhecido: 410', async () => {
    await expect(make().svc.redeem(P, 'nao-existe-nao-existe')).rejects.toBeInstanceOf(LaunchError);
  });

  it('o SIGAA fecha entre o clique e a navegação: 409', async () => {
    const { svc, fechar } = make();
    const token = await svc.create(P);
    fechar();
    await expect(svc.redeem(P, token)).rejects.toMatchObject({ status: 409 });
  });

  it('SIGAA fora do ar ao ler o formulário: 503 com mensagem fixa', async () => {
    const { svc, form } = make();
    form.fail = true;
    const token = await svc.create(P);
    const erro = (await svc.redeem(P, token).catch((e: unknown) => e)) as LaunchError;
    expect(erro).toMatchObject({ status: 503 });
    expect(erro.message).not.toContain(SENHA);
  });

  it('limite por pessoa: 6 aberturas em 10 min; outra pessoa não é afetada; depois da janela volta', async () => {
    const { svc, avancar } = make();
    for (let i = 0; i < 6; i++) await svc.create(P);
    await expect(svc.create(P)).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });
    await expect(svc.create({ ...P, userId: 'u2' })).resolves.toBeTruthy();
    avancar(10 * 60_000 + 1);
    await expect(svc.create(P)).resolves.toBeTruthy();
  });

  it('a auditoria registra quem e quando, nunca a senha nem o token', async () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc } = make();
    const token = await svc.create(P);
    await svc.redeem(P, token);
    const linhas = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(linhas.some((l) => l.startsWith('sigaa-launch: user=u1 em='))).toBe(true);
    for (const l of linhas) {
      expect(l).not.toContain(SENHA);
      expect(l).not.toContain(token);
    }
  });
});
