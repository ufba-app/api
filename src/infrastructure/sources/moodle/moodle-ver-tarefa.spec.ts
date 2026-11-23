import { Secret } from '../../../application/shared/secret';
import { SourceError, type SourceContext } from '../../../application/ports/source-gateway';
import { MoodleLive } from './moodle-live';

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

const CURSO = '359937';
const CMID = '4286503';
const ASSIGN_ID = '288097';
const PRAZO = 1791255540;

function assignments(duedate = PRAZO, extra: Record<string, unknown> = {}) {
  return { courses: [{ id: 359937, assignments: [{ id: 288097, cmid: 4286503, name: 'Avaliação 01', duedate, configs: [], ...extra }] }] };
}

function submission(extra: Record<string, unknown> = {}) {
  return {
    status: 'submitted',
    timemodified: PRAZO - 113,
    plugins: [{ type: 'file', fileareas: [{ area: 'submission_files', files: [{ filename: 'a.pdf', filesize: 10 }] }] }, { type: 'comments' }],
    ...extra,
  };
}

const feedbackAvaliado = (comentario = '<p>Excelente trabalho.</p>') => ({
  grade: { id: 1, grader: 4389, grade: '100.00000' },
  gradefordisplay: '100,00&nbsp;/&nbsp;100,00',
  gradeddate: 1795032983,
  plugins: [
    { type: 'comments', editorfields: [{ name: 'comments', text: comentario, format: 1 }] },
    { type: 'editpdf' },
  ],
});

const ver = (status: unknown, duedate?: number, extra: Record<string, unknown> = {}) => {
  const m = moodle({ mod_assign_get_assignments: assignments(duedate, extra), mod_assign_get_submission_status: status });
  return { ...m, run: (cmid = CMID) => m.live.verTarefa!(ctx, CURSO, cmid) };
};

describe('MoodleLive.verTarefa', () => {
  it('avaliada: nota (sem entidade HTML), comentário do professor e data', async () => {
    const { run, calls } = ver({ lastattempt: { graded: true, submission: submission() }, feedback: feedbackAvaliado() });
    const t = await run();
    expect(t).toMatchObject({
      tarefaId: CMID,
      titulo: 'Avaliação 01',
      estado: 'entregue',
      atrasada: false,
      arquivosAtuais: [{ nome: 'a.pdf', tamanhoBytes: 10 }],
      avaliacao: { avaliada: true, nota: '100,00 / 100,00', comentarios: ['Excelente trabalho.'] },
    });
    expect(t.avaliacao.avaliadaEm).toEqual(new Date(1795032983 * 1000));
    expect(t.enviadoEm).toEqual(new Date((PRAZO - 113) * 1000));
    expect(calls.map((c) => c.get('wsfunction'))).toEqual(['mod_assign_get_assignments', 'mod_assign_get_submission_status']);
    expect(calls[1].get('assignid')).toBe(ASSIGN_ID);
    expect(JSON.stringify(t)).not.toContain('4389');
  });

  it('entregue sem nota: sem a chave feedback, avaliada false e sem nota (nunca 0)', async () => {
    const { run } = ver({ lastattempt: { graded: false, gradingstatus: 'notgraded', submission: submission() } });
    const t = await run();
    expect(t.avaliacao).toEqual({ avaliada: false, comentarios: [] });
    expect(t.avaliacao).not.toHaveProperty('nota');
  });

  it('avaliada sem comentário do professor: comentarios vazio', async () => {
    const { run } = ver({ lastattempt: { graded: true, submission: submission() }, feedback: feedbackAvaliado('') });
    expect((await run()).avaliacao).toMatchObject({ avaliada: true, nota: '100,00 / 100,00', comentarios: [] });
  });

  it('atrasada: envio depois do prazo; a prorrogação adia; sem prazo nunca atrasa', async () => {
    const tarde = { lastattempt: { submission: submission({ timemodified: PRAZO + 60 }) } };
    expect((await ver(tarde).run()).atrasada).toBe(true);
    const prorrogada = { lastattempt: { extensionduedate: PRAZO + 3600, submission: submission({ timemodified: PRAZO + 60 }) } };
    expect((await ver(prorrogada).run()).atrasada).toBe(false);
    expect((await ver(tarde, 0).run()).atrasada).toBe(false);
  });

  it('sem entrega: estado nova, sem enviadoEm e não atrasada', async () => {
    const t = await ver({ lastattempt: { submission: { status: 'new', plugins: [] } } }).run();
    expect(t).toMatchObject({ estado: 'nova', atrasada: false, arquivosAtuais: [] });
    expect(t).not.toHaveProperty('enviadoEm');
  });

  it('rascunho é rascunho', async () => {
    expect((await ver({ lastattempt: { submission: submission({ status: 'draft' }) } }).run()).estado).toBe('rascunho');
  });

  it('o id interno no lugar do cmid não acha a tarefa; id inválido é recusado; nada vaza o token', async () => {
    const { run } = ver({ lastattempt: {} });
    const e1 = await run(ASSIGN_ID).then(() => new Error("não falhou"), (e: unknown) => e as SourceError);
    expect(e1).toBeInstanceOf(SourceError);
    expect(e1.message).toBe('tarefa não encontrada neste curso');
    const e2 = await run('abc').then(() => new Error("não falhou"), (e: unknown) => e as SourceError);
    expect(e2).toMatchObject({ code: 'UNSUPPORTED_SCOPE', message: 'tarefaId inválido' });
    expect(`${e1.message}${e2.message}`).not.toContain('SEGREDO123');
  });

  it('comentário do professor sem nota ("-"): aparece, mas avaliada continua false e sem nota', async () => {
    const fb = { gradefordisplay: '-', plugins: [{ type: 'comments', editorfields: [{ name: 'comments', text: '<p>Refaça a seção 2</p>' }] }] };
    const t = await ver({ lastattempt: { graded: false, submission: submission() }, feedback: fb }).run();
    expect(t.avaliacao).toEqual({ avaliada: false, comentarios: ['Refaça a seção 2'] });
  });

  it('graded sem feedback (nota ainda não liberada ao aluno): não afirma que foi avaliada', async () => {
    const t = await ver({ lastattempt: { graded: true, submission: submission() } }).run();
    expect(t.avaliacao).toEqual({ avaliada: false, comentarios: [] });
  });

  it('nova ou rascunho com timemodified depois do prazo: sem enviadoEm e não atrasada', async () => {
    for (const status of ['new', 'draft', 'reopened']) {
      const t = await ver({ lastattempt: { submission: submission({ status, timemodified: PRAZO + 60 }) } }).run();
      expect(t).not.toHaveProperty('enviadoEm');
      expect(t.atrasada).toBe(false);
    }
  });

  it('tarefa em grupo: lê a entrega do grupo (teamsubmission), não a do aluno', async () => {
    const t = await ver(
      { lastattempt: { submission: { status: 'new', plugins: [] }, teamsubmission: submission() } },
      PRAZO,
      { teamsubmission: 1 },
    ).run();
    expect(t).toMatchObject({ estado: 'entregue', arquivosAtuais: [{ nome: 'a.pdf', tamanhoBytes: 10 }] });
  });
});
