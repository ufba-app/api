import { GoogleAuth, GoogleHttp } from '../google/google-http';
import { fakeFetch, tokenRoute } from '../../../../test/support/fake-fetch';
import { ClassroomGateway } from './classroom.gateway';
import { DriveAttachmentReader, UnsupportedAttachmentError } from './drive-attachment-reader';

function build(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch([tokenRoute, ...routes]);
  const http = new GoogleHttp(new GoogleAuth({ clientId: 'id', clientSecret: 'sec', fetchFn: f }), f);
  return { f, http };
}

const ctx = { userId: 'u', accountKey: 'a@x', credentials: { kind: 'token' as const, token: 'RT' } };

describe('ClassroomGateway', () => {
  const routes = [
    {
      match: '/courses?',
      body: { courses: [{ id: 'c1', name: 'Cálculo A', section: 'T01', alternateLink: 'https://x/c1' }] },
    },
    {
      match: '/courses/c1/announcements',
      body: {
        announcements: [
          { id: 'a1', text: 'Prova adiada\nNova data em breve', creationTime: '2026-10-01T10:00:00Z', materials: [] },
        ],
      },
    },
    {
      match: '/courses/c1/courseWork/-/studentSubmissions',
      body: { studentSubmissions: [{ id: 's1', courseWorkId: 'w1', assignedGrade: 8.5, updateTime: '2026-10-05T00:00:00Z' }, { id: 's2', courseWorkId: 'w1' }] },
    },
    {
      match: '/courses/c1/courseWorkMaterials',
      body: {
        courseWorkMaterial: [
          {
            id: 'm1',
            title: 'Slides 1',
            materials: [
              { driveFile: { driveFile: { id: 'D1', title: 'slides.pdf', alternateLink: 'https://drive/D1' } } },
              { link: { url: 'https://site', title: 'Site' } },
            ],
          },
        ],
      },
    },
    {
      match: '/courses/c1/courseWork',
      body: {
        courseWork: [
          {
            id: 'w1',
            title: 'Lista 1',
            maxPoints: 10,
            workType: 'ASSIGNMENT',
            dueDate: { year: 2026, month: 11, day: 5 },
            dueTime: { hours: 20, minutes: 30 },
          },
        ],
      },
    },
  ];

  it('mapeia cursos, avisos, tarefas, materiais e notas', async () => {
    const { http } = build(routes);
    const r = await new ClassroomGateway(http).fetch(ctx);

    expect(r.courseSpaces!).toEqual([
      expect.objectContaining({ externalId: 'c1', name: 'Cálculo A', extra: expect.objectContaining({ section: 'T01' }) }),
    ]);
    const byKind = (k: string) => r.items!.filter((i) => i.kind === k);
    expect(byKind('ANNOUNCEMENT')[0]).toMatchObject({ externalId: 'a1', title: 'Prova adiada', courseExternalId: 'c1' });
    const w = byKind('ASSIGNMENT')[0];
    expect(w.dueAt?.toISOString()).toBe('2026-11-05T20:30:00.000Z');
    expect(w.extra).toMatchObject({ maxPoints: 10, workType: 'ASSIGNMENT' });
    const m = byKind('MATERIAL')[0];
    expect(m.attachments).toEqual([
      expect.objectContaining({ externalId: 'D1', name: 'slides.pdf', sourceUrl: 'https://drive/D1'}),
      expect.objectContaining({ name: 'Site', sourceUrl: 'https://site' }),
    ]);
    expect(r.grades!).toEqual([
      expect.objectContaining({ externalId: 's1', itemExternalId: 'w1', label: 'Lista 1', score: 8.5, maxScore: 10 }),
    ]);
  });

  it('pagina e reaproveita o access token', async () => {
    let page = 0;
    const { f, http } = build([
      { match: '/announcements', body: {} },
      { match: '/courseWorkMaterials', body: {} },
      { match: '/studentSubmissions', body: {} },
      { match: '/courseWork', body: {} },
      { match: '/courses?', body: () => (page++ === 0 ? { courses: [{ id: 'c1', name: 'A' }], nextPageToken: 'p2' } : { courses: [{ id: 'c2', name: 'B' }] }) },
    ]);
    const r = await new ClassroomGateway(http).fetch(ctx);
    expect(r.courseSpaces!.map((c) => c.externalId)).toEqual(['c1', 'c2']);
    expect(f.mock.calls.filter(([u]) => String(u).includes('oauth2')).length).toBe(1);
  });

  it('escopo item filtra o item pedido', async () => {
    const { http } = build([...routes.slice(1), { match: '/courses/c1', body: { id: 'c1', name: 'A' } }]);
    const r = await new ClassroomGateway(http).fetch(ctx, { kind: 'item', courseExternalId: 'c1', itemExternalId: 'w1' });
    expect(r.items!.map((i) => i.externalId)).toEqual(['w1']);
  });

  it('propaga erro HTTP sem vazar token', async () => {
    const { http } = build([{ match: '/courses?', body: {}, status: 403 }]);
    await expect(new ClassroomGateway(http).fetch(ctx)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });
});

const ctxRT = { refreshToken: 'RT' };

describe('DriveAttachmentReader', () => {
  it('baixa arquivo binário (PDF) como bytes', async () => {
    const { http, f } = build([
      { match: 'alt=media', body: null, raw: new Uint8Array([37, 80, 68, 70]) },
      { match: '/files/D1', body: { name: 'a.pdf', mimeType: 'application/pdf', size: '4' } },
    ]);
    const c = await new DriveAttachmentReader(http).read(ctxRT, { externalId: 'D1' });
    expect(c.mimeType).toBe('application/pdf');
    expect(Array.from(c.bytes)).toEqual([37, 80, 68, 70]);
    expect(f).toHaveBeenCalled();
  });

  it('exporta Google Docs como PDF', async () => {
    const { http } = build([
      { match: '/export', body: null, raw: new Uint8Array([1, 2]) },
      { match: '/files/D2', body: { name: 'Doc', mimeType: 'application/vnd.google-apps.document' } },
    ]);
    const c = await new DriveAttachmentReader(http).read(ctxRT, { sourceUrl: 'https://docs.google.com/file/d/D2/view' });
    expect(c).toMatchObject({ mimeType: 'application/pdf', fileName: 'Doc.pdf' });
  });

  it('recusa tipo não exportável e anexo sem id', async () => {
    const { http } = build([{ match: '/files/D3', body: { mimeType: 'application/vnd.google-apps.form' } }]);
    const r = new DriveAttachmentReader(http);
    await expect(r.read(ctxRT, { externalId: 'D3' })).rejects.toBeInstanceOf(UnsupportedAttachmentError);
    await expect(r.read(ctxRT, {})).rejects.toBeInstanceOf(UnsupportedAttachmentError);
  });
});
