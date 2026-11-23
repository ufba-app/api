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
            cmid: 4258935,
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

/** Como no AVA real: o id da atividade em `ver_curso` (cmid) não é o id interno da tarefa (assign id). */
const CMID = '4258935';
const ASSIGN_ID = '286293';

const statusNovo = { lastattempt: { canedit: true, submission: { status: 'new', plugins: [] } } };

describe('MoodleLive.requisitosEntrega', () => {
  it('lê get_assignments do curso e o status, e mapeia as configs', async () => {
    const { live, calls } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    const r = await live.requisitosEntrega!(ctx, '359934', CMID);
    expect(calls[0].get('courseids[0]')).toBe('359934');
    expect(calls[1].get('assignid')).toBe(ASSIGN_ID);
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

  it('acha a tarefa pelo cmid de ver_curso e devolve o assign id interno (tarefaId) e o cmid', async () => {
    const { live, calls } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    const r = await live.requisitosEntrega!(ctx, '359934', CMID);
    expect(r.tarefaId).toBe(ASSIGN_ID);
    expect(r.cmid).toBe(CMID);
    expect(calls[1].get('assignid')).toBe(ASSIGN_ID);
  });

  it('o assign id interno como tarefaId não é achado (sem fallback para o id interno)', async () => {
    const { live, calls } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    const err = (await live.requisitosEntrega!(ctx, '359934', ASSIGN_ID).catch((e) => e)) as SourceError;
    expect(err).toBeInstanceOf(SourceError);
    expect(err.code).toBe('UNSUPPORTED_SCOPE');
    expect(calls.some((c) => c.get('wsfunction') === 'mod_assign_get_submission_status')).toBe(false);
  });

  it('status draft/submitted vira rascunho/entregue e lista os arquivos atuais', async () => {
    const plugins = [{ type: 'file', fileareas: [{ area: 'submission_files', files: [{ filename: 'a.zip', filesize: 10 }] }] }];
    for (const [status, estado] of [['draft', 'rascunho'], ['submitted', 'entregue']] as const) {
      const { live } = moodle({
        mod_assign_get_assignments: assignments({ submissiondrafts: 1 }),
        mod_assign_get_submission_status: { lastattempt: { canedit: true, submission: { status, plugins } } },
      });
      const r = await live.requisitosEntrega!(ctx, '359934', CMID);
      expect(r.estado).toBe(estado);
      expect(r.exigeBotaoEnviar).toBe(true);
      expect(r.arquivosAtuais).toEqual([{ nome: 'a.zip', tamanhoBytes: 10 }]);
    }
  });

  it('extensões: ".pdf, .zip" vira [".pdf",".zip"]', async () => {
    const { live } = moodle({ mod_assign_get_assignments: assignments({}, '.PDF, .zip'), mod_assign_get_submission_status: statusNovo });
    expect((await live.requisitosEntrega!(ctx, '359934', CMID)).extensoes).toEqual(['.pdf', '.zip']);
  });

  it('filetypeslist com grupo ou MIME passa como está (sem descartar tokens) e aceita ";" como separador', async () => {
    const { live } = moodle({ mod_assign_get_assignments: assignments({}, 'document; image/PNG .pdf'), mod_assign_get_submission_status: statusNovo });
    expect((await live.requisitosEntrega!(ctx, '359934', CMID)).extensoes).toEqual(['document', 'image/png', '.pdf']);
  });

  it('temTextoAtual: true quando a entrega tem texto online, false sem texto', async () => {
    const com = { type: 'onlinetext', editorfields: [{ name: 'onlinetext', text: '<p>minha resposta</p>' }] };
    const vazio = { type: 'onlinetext', editorfields: [{ name: 'onlinetext', text: '' }] };
    for (const [plugins, esperado] of [[[com], true], [[vazio], false], [[], false]] as const) {
      const { live } = moodle({
        mod_assign_get_assignments: assignments(),
        mod_assign_get_submission_status: { lastattempt: { canedit: true, submission: { status: 'draft', plugins } } },
      });
      const r = await live.requisitosEntrega!(ctx, '359934', CMID);
      expect(r.temTextoAtual).toBe(esperado);
      expect(JSON.stringify(r)).not.toContain('minha resposta');
    }
  });

  it('id com mais de 15 dígitos não chega ao Moodle', async () => {
    const { live, calls } = moodle({});
    const e = (await live.requisitosEntrega!(ctx, '1234567890123456', '1').catch((x) => x)) as SourceError;
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(calls).toHaveLength(0);
    const { live: ok, calls: c2 } = moodle({ mod_assign_get_assignments: assignments(), mod_assign_get_submission_status: statusNovo });
    await ok.requisitosEntrega!(ctx, '123456789012345', CMID).catch(() => undefined);
    expect(c2.length).toBeGreaterThan(0);
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
    for (const ruim of ['', '0', '1e3', '-1', '0x10', ' ', '01']) {
      for (const [c, t] of [[ruim, '5'], ['1', ruim]]) {
        const e = (await live.requisitosEntrega!(ctx, c, t).catch((x) => x)) as SourceError;
        expect(e).toBeInstanceOf(SourceError);
        expect(e.code).toBe('UNSUPPORTED_SCOPE');
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('maxsubmissionsizebytes 0 (limite do site) vira undefined', async () => {
    const a = assignments();
    a.courses[0].assignments[0].configs[2] = cfg('file', 'maxsubmissionsizebytes', '0');
    const { live } = moodle({ mod_assign_get_assignments: a, mod_assign_get_submission_status: statusNovo });
    expect((await live.requisitosEntrega!(ctx, '359934', CMID)).maxBytesPorArquivo).toBeUndefined();
  });

  it('mapeia texto, datas, grupo e declaração', async () => {
    const a = assignments({ allowsubmissionsfromdate: 1700000000, cutoffdate: 1800000000, teamsubmission: 1, requiresubmissionstatement: 1 });
    a.courses[0].assignments[0].configs[4] = cfg('onlinetext', 'enabled', '1');
    const { live } = moodle({ mod_assign_get_assignments: a, mod_assign_get_submission_status: statusNovo });
    expect(await live.requisitosEntrega!(ctx, '359934', CMID)).toMatchObject({
      aceitaTexto: true,
      abreEm: new Date(1700000000 * 1000),
      limite: new Date(1800000000 * 1000),
      emGrupo: true,
      exigeDeclaracao: true,
    });
  });
});

function moodleUpload(resposta: unknown) {
  const reqs: { url: string; body: FormData; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    reqs.push({ url, body: init.body as FormData, init });
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

  it('o POST do upload tem tempo limite e não segue redirecionamento', async () => {
    const { live, reqs } = moodleUpload([{ filename: 'a.zip', filesize: 3, itemid: 1 }]);
    await live.subirArquivosEntrega!(ctx, [{ nome: 'a.zip', bytes: bytes(1, 2, 3) }]);
    expect(reqs[0].init.redirect).toBe('error');
    expect(reqs[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(reqs[0].init.signal!.aborted).toBe(false);
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

describe('MoodleLive.subirArquivosEntrega (guardas)', () => {
  it('lista vazia falha sem chamar a rede', async () => {
    const { live, reqs } = moodleUpload([]);
    const e = await live.subirArquivosEntrega!(ctx, []).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(reqs).toHaveLength(0);
  });

  it('invalidtoken no upload vira REAUTH_NEEDED', async () => {
    const { live } = moodleUpload({ error: 'token ruim', errorcode: 'invalidtoken' });
    const e = await live.subirArquivosEntrega!(ctx, [{ nome: 'a', bytes: bytes(1) }]).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('REAUTH_NEEDED');
  });

  it('item de erro dentro da lista é detectado', async () => {
    const { live } = moodleUpload([{ filename: 'a', filesize: 1, itemid: 5 }, { error: 'quota', errorcode: 'x' }]);
    const e = await live.subirArquivosEntrega!(ctx, [{ nome: 'a', bytes: bytes(1) }, { nome: 'b', bytes: bytes(1) }]).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('UNAVAILABLE');
  });

  it('itemids diferentes ou quantidade diferente do enviado falham', async () => {
    const dois = [{ nome: 'a', bytes: bytes(1) }, { nome: 'b', bytes: bytes(1) }];
    for (const resp of [
      [{ filename: 'a', filesize: 1, itemid: 1 }, { filename: 'b', filesize: 1, itemid: 2 }],
      [{ filename: 'a', filesize: 1, itemid: 1 }],
    ]) {
      const { live } = moodleUpload(resp);
      const e = await live.subirArquivosEntrega!(ctx, dois).catch((x) => x);
      expect(e).toBeInstanceOf(SourceError);
      expect(e.code).toBe('UNAVAILABLE');
    }
  });
});

describe('MoodleLive.salvarEntrega', () => {
  const statusDe = (status: string) => ({ lastattempt: { canedit: true, submission: { status, plugins: [] } } });

  it('com arquivos: save_submission com plugindata[files_filemanager]=itemId', async () => {
    const { live, calls } = moodle({ mod_assign_save_submission: [], mod_assign_get_submission_status: statusDe('submitted') });
    const r = await live.salvarEntrega!(ctx, { tarefaId: '286293', itemId: '137294331' });
    const save = calls.find((c) => c.get('wsfunction') === 'mod_assign_save_submission')!;
    expect(save.get('assignmentid')).toBe('286293');
    expect(save.get('plugindata[files_filemanager]')).toBe('137294331');
    expect(calls[calls.length - 1].get('wsfunction')).toBe('mod_assign_get_submission_status');
    expect(calls[calls.length - 1].get('assignid')).toBe('286293');
    expect(r).toEqual({ estado: 'entregue' });
  });

  it('com texto: plugindata[onlinetext_editor][text] em HTML escapado, [format]=1 e [itemid]', async () => {
    const { live, calls } = moodle({ mod_assign_save_submission: [], mod_assign_get_submission_status: statusDe('draft') });
    const r = await live.salvarEntrega!(ctx, { tarefaId: '5', texto: '<script>x</script>' });
    const save = calls.find((c) => c.get('wsfunction') === 'mod_assign_save_submission')!;
    expect(save.get('plugindata[onlinetext_editor][text]')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(save.get('plugindata[onlinetext_editor][format]')).toBe('1');
    expect(save.get('plugindata[onlinetext_editor][itemid]')).toBe('0');
    expect(save.get('plugindata[files_filemanager]')).toBeNull();
    expect(r).toEqual({ estado: 'rascunho' });
  });

  it('resposta com warnings não vazio é SourceError com a mensagem do Moodle', async () => {
    const { live } = moodle({ mod_assign_save_submission: [{ item: 'x', warningcode: '1', message: 'Prazo encerrado' }] });
    const e = await live.salvarEntrega!(ctx, { tarefaId: '5', itemId: '9' }).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.message).toContain('Prazo encerrado');
  });

  it('salvarEntrega sem arquivos nem texto é recusado antes de chamar o Moodle', async () => {
    const { live, calls } = moodle({});
    const e = (await live.salvarEntrega!(ctx, { tarefaId: '5' }).catch((x) => x)) as SourceError;
    expect(e).toBeInstanceOf(SourceError);
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(calls).toHaveLength(0);
  });

  it('id não inteiro não chega ao Moodle', async () => {
    const { live, calls } = moodle({});
    for (const id of ['', '0', '1e3', '-1', '0x10', 'abc']) {
      const e = (await live.salvarEntrega!(ctx, { tarefaId: id, itemId: '9' }).catch((x) => x)) as SourceError;
      expect(e.code).toBe('UNSUPPORTED_SCOPE');
    }
    const e = (await live.salvarEntrega!(ctx, { tarefaId: '5', itemId: 'x;1' }).catch((x) => x)) as SourceError;
    expect(e.code).toBe('UNSUPPORTED_SCOPE');
    expect(calls).toHaveLength(0);
  });
});

/** Moodle falso em que a leitura do estado (get_submission_status) falha depois da escrita. */
function moodleLeituraFalha(escrita: string) {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const f = (init.body as URLSearchParams).get('wsfunction') as string;
    calls.push(f);
    if (f === escrita) return new Response('[]', { status: 200 });
    return new Response('erro', { status: 503 });
  }) as unknown as typeof fetch;
  return { live: new MoodleLive(fetchFn), calls };
}

describe('MoodleLive: leitura do estado falha depois de uma escrita que deu certo', () => {
  it('salvarEntrega devolve estado ausente (não lança) e grava uma vez só', async () => {
    const { live, calls } = moodleLeituraFalha('mod_assign_save_submission');
    await expect(live.salvarEntrega!(ctx, { tarefaId: '5', itemId: '9' })).resolves.toEqual({});
    expect(calls.filter((c) => c === 'mod_assign_save_submission')).toHaveLength(1);
  });

  it('finalizarEntrega devolve estado ausente (não lança) e envia uma vez só', async () => {
    const { live, calls } = moodleLeituraFalha('mod_assign_submit_for_grading');
    await expect(live.finalizarEntrega!(ctx, '5')).resolves.toEqual({});
    expect(calls.filter((c) => c === 'mod_assign_submit_for_grading')).toHaveLength(1);
  });
});

describe('MoodleLive: avisos da escrita', () => {
  it('resposta que não é lista de avisos é falha', async () => {
    for (const resp of [{}, null, 'ok']) {
      const { live } = moodle({ mod_assign_save_submission: resp });
      const e = await live.salvarEntrega!(ctx, { tarefaId: '5', itemId: '9' }).catch((x) => x);
      expect(e).toBeInstanceOf(SourceError);
    }
  });

  it('texto do aviso do Moodle sai sem o token', async () => {
    const { live } = moodle({ mod_assign_submit_for_grading: [{ message: 'token SEGREDO123 inválido' }] });
    const e = (await live.finalizarEntrega!(ctx, '5').catch((x) => x)) as SourceError;
    expect(e).toBeInstanceOf(SourceError);
    expect(e.message).not.toContain('SEGREDO123');
    expect(e.message).toContain('inválido');
  });
});

describe('MoodleLive.finalizarEntrega', () => {
  it('chama mod_assign_submit_for_grading com assignmentid e acceptsubmissionstatement=0 e devolve o estado lido', async () => {
    const { live, calls } = moodle({
      mod_assign_submit_for_grading: [],
      mod_assign_get_submission_status: { lastattempt: { submission: { status: 'submitted' } } },
    });
    const r = await live.finalizarEntrega!(ctx, '286293');
    const c = calls.find((x) => x.get('wsfunction') === 'mod_assign_submit_for_grading')!;
    expect(c.get('assignmentid')).toBe('286293');
    expect(c.get('acceptsubmissionstatement')).toBe('0');
    expect(r).toEqual({ estado: 'entregue' });
  });

  it('warnings não vazio é falha; id ruim não chega ao Moodle', async () => {
    const { live, calls } = moodle({ mod_assign_submit_for_grading: [{ message: 'Não pode enviar' }] });
    const e = await live.finalizarEntrega!(ctx, '5').catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.message).toContain('Não pode enviar');
    const n = calls.length;
    const e2 = (await live.finalizarEntrega!(ctx, '0').catch((x) => x)) as SourceError;
    expect(e2.code).toBe('UNSUPPORTED_SCOPE');
    expect(calls).toHaveLength(n);
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
