import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { MoodleLive } from './moodle-live';
import { nomeSeguro } from './moodle-client';

const ctx: SourceContext = {
  userId: 'u1',
  accountKey: 'ava.test:aluno',
  siteUrl: 'https://ava.test',
  credentials: { kind: 'token', token: Secret.of('SEGREDO123') },
};

function moodle(responses: Record<string, unknown>) {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    calls.push(body);
    return new Response(JSON.stringify(responses[body.get('wsfunction') as string] ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { live: new MoodleLive(fetchFn), calls };
}

const cfg = (plugin: string, name: string, value: string) => ({ plugin, subtype: 'assignsubmission', name, value });

function assignments(extra: Record<string, unknown> = {}, filetypes = '') {
  return {
    courses: [
      {
        id: 359934,
        assignments: [
          {
            id: 286293,
            name: 'ED1',
            duedate: 1796266620,
            cutoffdate: 0,
            allowsubmissionsfromdate: 0,
            submissiondrafts: 0,
            teamsubmission: 0,
            requiresubmissionstatement: 0,
            configs: [
              cfg('file', 'enabled', '1'),
              cfg('file', 'maxfilesubmissions', '20'),
              cfg('file', 'maxsubmissionsizebytes', '52428800'),
              cfg('file', 'filetypeslist', filetypes),
              cfg('onlinetext', 'enabled', '0'),
            ],
            ...extra,
          },
        ],
      },
    ],
  };
}

const statusNovo = { lastattempt: { canedit: true, submission: { status: 'new', plugins: [] } } };

describe('MoodleLive.requisitosEntrega', () => {
  it('lê get_assignments do curso e o status, e mapeia as configs', async () => {
    const { live, calls } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    const r = await live.requisitosEntrega!(ctx, '359934', '286293');
    expect(calls[0].get('courseids[0]')).toBe('359934');
    expect(calls[1].get('assignid')).toBe('286293');
    expect(r).toMatchObject({
      aceitaArquivo: true,
      aceitaTexto: false,
      maxArquivos: 20,
      maxBytesPorArquivo: 52428800,
      extensoes: [],
      exigeBotaoEnviar: false,
      estado: 'nova',
      podeEditar: true,
      limite: undefined,
      prazo: new Date(1796266620 * 1000),
    });
  });

  it('status draft/submitted vira rascunho/entregue e lista os arquivos atuais', async () => {
    const plugins = [{ type: 'file', fileareas: [{ area: 'submission_files', files: [{ filename: 'a.zip', filesize: 10 }] }] }];
    for (const [status, estado] of [['draft', 'rascunho'], ['submitted', 'entregue']] as const) {
      const { live } = moodle({
        mod_assign_get_assignments: assignments({ submissiondrafts: 1 }),
        mod_assign_get_submission_status: { lastattempt: { canedit: true, submission: { status, plugins } } },
      });
      const r = await live.requisitosEntrega!(ctx, '359934', '286293');
      expect(r.estado).toBe(estado);
      expect(r.exigeBotaoEnviar).toBe(true);
      expect(r.arquivosAtuais).toEqual([{ nome: 'a.zip', tamanhoBytes: 10 }]);
    }
  });

  it('extensões: ".pdf, .zip" vira [".pdf",".zip"]', async () => {
    const { live } = moodle({ mod_assign_get_assignments: assignments({}, '.PDF, .zip'), mod_assign_get_submission_status: statusNovo });
    expect((await live.requisitosEntrega!(ctx, '359934', '286293')).extensoes).toEqual(['.pdf', '.zip']);
  });

  it('tarefa que não está no curso: SourceError UNSUPPORTED_SCOPE', async () => {
    const { live } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    const err = (await live.requisitosEntrega!(ctx, '359934', '999').catch((e) => e)) as SourceError;
    expect(err).toBeInstanceOf(SourceError);
    expect(err.code).toBe('UNSUPPORTED_SCOPE');
  });

  it('ids que não são inteiros não chegam ao Moodle', async () => {
    const { live, calls } = moodle({});
    await expect(live.requisitosEntrega!(ctx, '1;2', '5')).rejects.toBeInstanceOf(SourceError);
    await expect(live.requisitosEntrega!(ctx, '1', 'abc')).rejects.toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(0);
  });
});

function moodleUpload(resposta: unknown) {
  const reqs: { url: string; body: FormData }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    reqs.push({ url, body: init.body as FormData });
    return new Response(JSON.stringify(resposta), { status: 200 });
  }) as unknown as typeof fetch;
  return { live: new MoodleLive(fetchFn), reqs };
}

const bytes = (...n: number[]) => new Uint8Array(n);

describe('MoodleLive.subirArquivosEntrega', () => {
  it('um POST multipart com token, filearea=draft, itemid=0 e file_1', async () => {
    const { live, reqs } = moodleUpload([{ filename: 'a.zip', filesize: 3, itemid: 137294331 }]);
    const r = await live.subirArquivosEntrega!(ctx, [{ nome: 'a.zip', bytes: bytes(1, 2, 3) }]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].url.endsWith('/webservice/upload.php')).toBe(true);
    expect(reqs[0].body).toBeInstanceOf(FormData);
    expect(reqs[0].body.get('token')).toBe('SEGREDO123');
    expect(reqs[0].body.get('filearea')).toBe('draft');
    expect(reqs[0].body.get('itemid')).toBe('0');
    expect((reqs[0].body.get('file_1') as File).name).toBe('a.zip');
    expect(r).toEqual({ itemId: '137294331', arquivos: [{ nome: 'a.zip', tamanhoBytes: 3 }] });
  });

  it('vários arquivos vão no mesmo POST como file_1, file_2', async () => {
    const { live, reqs } = moodleUpload([
      { filename: 'a.zip', filesize: 1, itemid: 7 },
      { filename: 'b.pdf', filesize: 2, itemid: 7 },
    ]);
    const r = await live.subirArquivosEntrega!(ctx, [
      { nome: 'a.zip', bytes: bytes(1) },
      { nome: '../b.pdf', bytes: bytes(1, 2) },
    ]);
    expect(reqs).toHaveLength(1);
    expect((reqs[0].body.get('file_1') as File).name).toBe('a.zip');
    expect((reqs[0].body.get('file_2') as File).name).toBe('b.pdf');
    expect(r.arquivos).toHaveLength(2);
    expect(r.itemId).toBe('7');
  });

  it('resposta com exception vira SourceError sem o token', async () => {
    const { live } = moodleUpload({ error: 'falhou SEGREDO123', exception: 'moodle_exception', errorcode: 'x' });
    const e = await live.subirArquivosEntrega!(ctx, [{ nome: 'a', bytes: bytes(1) }]).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).not.toContain('SEGREDO123');
  });

  it('resposta que não é lista com itemid vira SourceError UNAVAILABLE', async () => {
    for (const resp of [{}, [], [{ filename: 'a' }]]) {
      const { live } = moodleUpload(resp);
      const e = await live.subirArquivosEntrega!(ctx, [{ nome: 'a', bytes: bytes(1) }]).catch((x) => x);
      expect(e).toBeInstanceOf(SourceError);
      expect(e.code).toBe('UNAVAILABLE');
    }
  });
});

describe('nomeSeguro', () => {
  it('tira diretórios e caracteres de controle', () => {
    expect(nomeSeguro('../../etc/passwd')).toBe('passwd');
    expect(nomeSeguro('a/b\\c.pdf')).toBe('c.pdf');
    expect(nomeSeguro('a\r\nb\0.txt')).toBe('ab.txt');
    expect(nomeSeguro('')).toBe('arquivo');
  });
  it('corta em 255 preservando a extensão', () => {
    const r = nomeSeguro('x'.repeat(300) + '.pdf');
    expect(r).toHaveLength(255);
    expect(r.endsWith('.pdf')).toBe(true);
  });
});
