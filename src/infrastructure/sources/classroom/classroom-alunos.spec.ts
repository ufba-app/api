import { Secret } from '../../../application/shared/secret';
import type { SourceContext } from '../../../application/ports/source-gateway';
import { GoogleAuth, GoogleHttp } from '../google/google-http';
import { ClassroomLive } from './classroom-live';

const ufba: SourceContext = {
  userId: 'u1',
  accountKey: 'aluno@ufba.br',
  credentials: { kind: 'token', token: Secret.of('RT-SEGREDO') },
};

/** Fake do Google: API por caminho e token por app; devolve o que `routes` mandar. */
function google(routes: (path: string, q: URLSearchParams) => unknown) {
  const api: Array<{ path: string; q: URLSearchParams }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 });
    }
    const path = u.pathname.replace('/v1/', '');
    api.push({ path, q: u.searchParams });
    return new Response(JSON.stringify(routes(path, u.searchParams) ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  const http = new GoogleHttp(new GoogleAuth({ clientId: 'app-interno', clientSecret: 's', fetchFn }), fetchFn);
  return { live: new ClassroomLive({ ufba: http }), api };
}

describe('ClassroomLive.listarParticipantes', () => {
  it('lê courses/{id}/students e devolve só nome e papel de aluno', async () => {
    const { live, api } = google(() => ({
      students: [
        { userId: '1', profile: { id: '1', name: { fullName: 'Ana Souza' }, emailAddress: 'ana@ufba.br' } },
        { userId: '2', profile: { id: '2', name: { fullName: 'Bruno Alves' }, emailAddress: 'bruno@ufba.br' } },
      ],
    }));
    const r = await live.listarParticipantes(ufba, '111');
    expect(api.map((a) => a.path)).toEqual(['courses/111/students']);
    expect(r).toEqual([
      { nome: 'Ana Souza', papeis: ['student'] },
      { nome: 'Bruno Alves', papeis: ['student'] },
    ]);
    expect(JSON.stringify(r)).not.toContain('@ufba.br');
  });

  it('segue nextPageToken até acabar, com o teto de páginas', async () => {
    const { live, api } = google((_path, q) => {
      if (!q.get('pageToken')) return { students: [{ profile: { name: { fullName: 'Primeira' } } }], nextPageToken: 'P2' };
      return { students: [{ profile: { name: { fullName: 'Segunda' } } }] };
    });
    const r = await live.listarParticipantes(ufba, '111');
    expect(r.map((x) => x.nome)).toEqual(['Primeira', 'Segunda']);
    expect(api).toHaveLength(2);
    expect(api[1].q.get('pageToken')).toBe('P2');
  });

  it('id de matéria inválido não chega à API', async () => {
    const { live, api } = google(() => ({}));
    await expect(live.listarParticipantes(ufba, '1/../x')).rejects.toBeDefined();
    expect(api).toHaveLength(0);
  });
});
