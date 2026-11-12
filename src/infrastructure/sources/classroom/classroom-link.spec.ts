import { Secret } from '../../../application/shared/secret';
import { GoogleLinkError } from '../google/google-oauth-flow';
import { appDaConta, ClassroomLink, CLASSROOM_LINK_SCOPES } from './classroom-link';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function build(cfg: { email?: string; refresh?: boolean; classroomStatus?: number; semConvidado?: boolean } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/token')) {
      return jsonRes({ access_token: 'AT', ...(cfg.refresh === false ? {} : { refresh_token: 'RT-SEGREDO' }) });
    }
    if (u.includes('userinfo')) return jsonRes({ email: cfg.email ?? 'Aluno@Gmail.com', email_verified: true });
    if (u.includes('classroom.googleapis.com')) return jsonRes({ courses: [] }, cfg.classroomStatus ?? 200);
    return jsonRes({}, 404);
  }) as typeof fetch;
  const conectarConta = jest.fn().mockResolvedValue(undefined);
  const findByUserAndProvider = jest.fn().mockResolvedValue([
    { accountKey: 'a@gmail.com', secret: {}, status: 'OK' },
    { accountKey: 'velha@gmail.com', secret: {}, status: 'REAUTH_NEEDED' },
    { accountKey: 'sem-segredo@gmail.com', secret: null, status: 'OK' },
  ]);
  const link = new ClassroomLink({ conectarConta } as never, { findByUserAndProvider } as never, {
    ufba: { clientId: 'cid-interno', clientSecret: 'sec' },
    convidado: cfg.semConvidado ? undefined : { clientId: 'cid-convidado', clientSecret: 'sec' },
    fetchFn,
  });
  return { link, conectarConta, calls };
}

describe('ClassroomLink', () => {
  it('appDaConta: o domínio decide o app', () => {
    expect(appDaConta('x@ufba.br')).toBe('ufba');
    expect(appDaConta('X@UFBA.BR')).toBe('ufba');
    expect(appDaConta('x@gmail.com')).toBe('convidado');
    expect(appDaConta('x@ufba.br.evil.com')).toBe('convidado');
  });

  it('apps: só os configurados', () => {
    expect(build().link.apps()).toEqual(['ufba', 'convidado']);
    expect(build({ semConvidado: true }).link.apps()).toEqual(['ufba']);
    expect(new ClassroomLink({} as never, {} as never, {}).enabled()).toBe(false);
  });

  it('URL: Classroom readonly + drive.readonly (nunca o drive inteiro com escrita), offline, app certo', async () => {
    const { link } = build();
    const ufba = new URL(await link.startUrl('ufba', 'http://localhost:3000/oauth/callback/google', 't1'));
    const conv = new URL(await link.startUrl('convidado', 'http://localhost:3000/oauth/callback/classroom', 't1'));
    expect(ufba.searchParams.get('client_id')).toBe('cid-interno');
    expect(ufba.searchParams.get('hd')).toBe('ufba.br');
    expect(conv.searchParams.get('client_id')).toBe('cid-convidado');
    expect(conv.searchParams.get('hd')).toBeNull();
    for (const u of [ufba, conv]) {
      expect(u.searchParams.get('scope')).toBe(CLASSROOM_LINK_SCOPES.join(' '));
      const drive = u.searchParams.get('scope')!.split(' ').filter((s) => s.includes('/auth/drive'));
      expect(drive).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
      expect(u.searchParams.get('access_type')).toBe('offline');
    }
  });

  it('convidado com gmail: 1 leitura de teste e guarda o refresh token na conta do e-mail', async () => {
    const { link, conectarConta, calls } = build();
    await expect(link.handleCallback('convidado', 'u1', 'code', 'cb')).resolves.toEqual({ email: 'aluno@gmail.com' });
    expect(calls.filter((c) => c.includes('classroom.googleapis.com'))).toEqual([
      'https://classroom.googleapis.com/v1/courses?pageSize=1',
    ]);
    expect(conectarConta).toHaveBeenCalledWith({
      userId: 'u1',
      provider: 'CLASSROOM',
      accountKey: 'aluno@gmail.com',
      secretPlain: expect.any(Secret),
    });
    expect((conectarConta.mock.calls.at(-1)![0] as { secretPlain: Secret }).secretPlain.reveal()).toBe('RT-SEGREDO');
  });

  it('ufba com conta @ufba.br: guarda', async () => {
    const { link, conectarConta } = build({ email: 'aluno@ufba.br' });
    await expect(link.handleCallback('ufba', 'u1', 'code', 'cb')).resolves.toEqual({ email: 'aluno@ufba.br' });
    expect(conectarConta).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['gmail pelo botão @ufba.br', 'ufba', 'aluno@gmail.com'],
    ['@ufba.br pelo botão de convidados', 'convidado', 'aluno@ufba.br'],
  ] as const)('recusa %s (o token não renovaria pelo app certo)', async (_n, app, email) => {
    const { link, conectarConta } = build({ email });
    await expect(link.handleCallback(app, 'u1', 'code', 'cb')).rejects.toThrow(GoogleLinkError);
    expect(conectarConta).not.toHaveBeenCalled();
  });

  it('se o teste de leitura falhar (ex.: conta fora da lista de teste), nada é guardado', async () => {
    const { link, conectarConta } = build({ classroomStatus: 403 });
    await expect(link.handleCallback('convidado', 'u1', 'code', 'cb')).rejects.toThrow('Classroom');
    expect(conectarConta).not.toHaveBeenCalled();
  });

  it('sem refresh token, explica e não guarda', async () => {
    const { link, conectarConta } = build({ refresh: false });
    await expect(link.handleCallback('convidado', 'u1', 'code', 'cb')).rejects.toThrow(GoogleLinkError);
    expect(conectarConta).not.toHaveBeenCalled();
  });
});
