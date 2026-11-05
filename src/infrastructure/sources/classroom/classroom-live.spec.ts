import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { GoogleAuth, GoogleHttp } from '../google/google-http';
import { ClassroomLive, MAX_CURSOS_PRAZOS } from './classroom-live';

const gmail: SourceContext = {
  userId: 'u1',
  accountKey: 'aluno@gmail.com',
  credentials: { kind: 'token', token: 'RT-SEGREDO' },
};
const ufba: SourceContext = { ...gmail, accountKey: 'aluno@ufba.br' };

const HOJE = new Date('2026-11-04T12:00:00Z');
const DRIVE_ID = '1zpW7R5nvz7u1e5ufS6Zq7dhqbchC3jzo';

/** Fake do Google; registra, por app (client id), as chamadas de API e de token. */
function google(routes: (path: string, q: URLSearchParams) => unknown, opts: { tokenStatus?: number } = {}) {
  const api: string[] = [];
  const tokenPorApp: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === 'oauth2.googleapis.com') {
      tokenPorApp.push((init?.body as URLSearchParams).get('client_id')!);
      return new Response(JSON.stringify(opts.tokenStatus ? { error: 'invalid_grant' } : { access_token: 'AT' }), {
        status: opts.tokenStatus ?? 200,
      });
    }
    api.push(u.pathname.replace('/v1/', '') + (u.search ? '?' + u.searchParams.toString() : ''));
    const out = routes(u.pathname.replace('/v1/', ''), u.searchParams);
    return out instanceof Response ? out : new Response(JSON.stringify(out ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  const http = (clientId: string) => new GoogleHttp(new GoogleAuth({ clientId, clientSecret: 's', fetchFn }), fetchFn);
  const live = new ClassroomLive({ ufba: http('app-interno'), convidado: http('app-convidado') }, { now: () => new Date(HOJE) });
  return { live, api, tokenPorApp };
}

const caminhos = (api: string[]) => api.map((a) => a.split('?')[0]);

describe('ClassroomLive', () => {
  it('escolhe o app pelo domínio da conta: @ufba.br → interno, gmail → convidado', async () => {
    const { live, tokenPorApp } = google(() => ({ courses: [] }));
    await live.listarCursos(ufba);
    await live.listarCursos(gmail);
    expect(tokenPorApp).toEqual(['app-interno', 'app-convidado']);
  });

  it('app da conta não configurado: erro claro, sem chamada', async () => {
    const live = new ClassroomLive({ convidado: undefined });
    await expect(live.listarCursos(gmail)).rejects.toThrow('convidados não configurado');
  });

  it('listarCursos: 1 chamada, só as matérias ativas em que é aluna', async () => {
    const { live, api } = google(() => ({ courses: [{ id: '111', name: 'Cálculo', section: 'T01', alternateLink: 'https://c/1' }] }));
    await expect(live.listarCursos(gmail)).resolves.toEqual([{ id: '111', nome: 'Cálculo', codigo: 'T01', url: 'https://c/1' }]);
    expect(api).toEqual(['courses?studentId=me&courseStates=ACTIVE&pageSize=100']);
  });

  it('listarCursos com todas: sem filtro de estado', async () => {
    const { live, api } = google(() => ({ courses: [] }));
    await live.listarCursos(gmail, { todas: true });
    expect(api).toEqual(['courses?studentId=me&pageSize=100']);
  });

  it('prazos: 1 chamada de matérias + 1 por matéria; só o que vence de hoje em diante, em ordem', async () => {
    const { live, api } = google((path) => {
      if (path === 'courses') return { courses: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] };
      if (path === 'courses/1/courseWork') {
        return {
          courseWork: [
            { id: 'w1', title: 'Lista 2', dueDate: { year: 2026, month: 11, day: 20 }, dueTime: { hours: 2, minutes: 59 } },
            { id: 'w0', title: 'Lista 1 (passou)', dueDate: { year: 2026, month: 10, day: 1 } },
            { id: 'w9', title: 'Sem prazo' },
          ],
        };
      }
      return { courseWork: [{ id: 'w2', title: 'Seminário', dueDate: { year: 2026, month: 11, day: 4 } }] };
    });
    const r = await live.prazos(gmail);
    expect(r.map((p) => [p.titulo, p.cursoId, p.quando.toISOString()])).toEqual([
      ['Seminário', '2', '2026-11-04T23:59:00.000Z'],
      ['Lista 2', '1', '2026-11-20T02:59:00.000Z'],
    ]);
    expect(caminhos(api).sort()).toEqual(['courses', 'courses/1/courseWork', 'courses/2/courseWork']);
  });

  it(`prazos: no máximo ${MAX_CURSOS_PRAZOS} matérias, nunca uma varredura sem teto`, async () => {
    const muitos = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), name: `M${i}` }));
    const { live, api } = google((path) => (path === 'courses' ? { courses: muitos } : { courseWork: [] }));
    await live.prazos(gmail);
    expect(api).toHaveLength(1 + MAX_CURSOS_PRAZOS);
  });

  it('verCurso: 3 chamadas; arquivos do Drive viram anexos com ref <curso>:<tipo>:<post>:<arquivo>', async () => {
    const { live, api } = google((path) => {
      if (path.endsWith('/courseWork')) {
        return {
          courseWork: [
            {
              id: 'w1',
              title: 'Lista 1',
              description: 'Resolver 1 a 10',
              dueDate: { year: 2026, month: 11, day: 10 },
              materials: [{ driveFile: { driveFile: { id: 'd1', title: 'lista1.pdf', alternateLink: 'https://drive/d1' } } }],
            },
          ],
        };
      }
      if (path.endsWith('/courseWorkMaterials')) {
        return { courseWorkMaterial: [{ id: 'm1', title: 'Slides', materials: [{ link: { url: 'https://ex.com', title: 'Site' } }] }] };
      }
      return { announcements: [{ id: 'a1', text: 'Aula cancelada\nAté quinta', materials: [{ driveFile: { driveFile: { id: 'd2', title: 'print.png' } } }] }] };
    });
    const r = await live.verCurso(gmail, '111');
    expect(caminhos(api).sort()).toEqual(['courses/111/announcements', 'courses/111/courseWork', 'courses/111/courseWorkMaterials']);
    expect(r.find((a) => a.id === 'a1')).toMatchObject({ tipo: 'aviso', titulo: 'Aula cancelada', anexos: [{ nome: 'print.png', ref: '111:a:a1:d2' }] });
    expect(r.find((a) => a.id === 'w1')).toMatchObject({ tipo: 'tarefa', anexos: [{ nome: 'lista1.pdf', ref: '111:t:w1:d1' }] });
    expect(r.find((a) => a.id === 'm1')).toMatchObject({ tipo: 'material', anexos: [], abrirNoNavegador: [{ nome: 'Site', url: 'https://ex.com' }] });
  });

  it('ids e refs inválidos não chegam ao Google', async () => {
    const { live, api, tokenPorApp } = google(() => ({}));
    await expect(live.verCurso(gmail, '../courses')).rejects.toBeInstanceOf(SourceError);
    for (const ref of [DRIVE_ID, '1:x:2:3', '1:t:2', '1:t:../x:3', '1:t:2:3:4']) {
      await expect(live.baixar(gmail, ref)).rejects.toBeInstanceOf(SourceError);
    }
    expect(api).toHaveLength(0);
    expect(tokenPorApp).toHaveLength(0);
  });

  it('baixar: confere o anexo no post (1 chamada) e só então lê o Drive (metadados + conteúdo)', async () => {
    const { live, api } = google((path, q) => {
      if (path === 'courses/111/courseWork/w1') return { materials: [{ driveFile: { driveFile: { id: DRIVE_ID } } }] };
      if (q.get('alt') === 'media') return new Response('PDFDATA', { status: 200 });
      return { name: 'lista1.pdf', mimeType: 'application/pdf', size: '7' };
    });
    const f = await live.baixar(gmail, `111:t:w1:${DRIVE_ID}`);
    expect(f).toMatchObject({ mimeType: 'application/pdf', fileName: 'lista1.pdf' });
    expect(new TextDecoder().decode(f.bytes)).toBe('PDFDATA');
    expect(caminhos(api)).toEqual(['courses/111/courseWork/w1', `/drive/v3/files/${DRIVE_ID}`, `/drive/v3/files/${DRIVE_ID}`]);
  });

  it('baixar recusa arquivo que NÃO está anexado no post, sem tocar o Drive', async () => {
    const { live, api } = google(() => ({ materials: [{ driveFile: { driveFile: { id: 'outro-arquivo-123' } } }] }));
    await expect(live.baixar(gmail, `111:a:a1:${DRIVE_ID}`)).rejects.toThrow('não está anexado');
    expect(caminhos(api)).toEqual(['courses/111/announcements/a1']);
  });

  it('refresh token recusado (ex.: 7 dias no modo Teste) vira REAUTH_NEEDED sem vazar o token', async () => {
    const { live } = google(() => ({}), { tokenStatus: 400 });
    const err = (await live.listarCursos(gmail).catch((e) => e)) as SourceError;
    expect(err.code).toBe('REAUTH_NEEDED');
    expect(err.message).not.toContain('RT-SEGREDO');
  });

  it('fórum não existe no Classroom', async () => {
    const { live, api } = google(() => ({}));
    await expect(live.verForum()).rejects.toBeInstanceOf(SourceError);
    expect(api).toHaveLength(0);
  });
});
