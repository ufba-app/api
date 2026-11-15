import { FakeCatalogSource, InMemoryCatalog } from '../../../test/support/catalog-fake';
import {
  FakeExtractor,
  FakeReader,
  FakeTranscriptSource,
  InMemoryAcademic,
  TRANSCRIPT_ITEMS as ITEMS,
  curriculumOf,
  perfectTranscript as perfect,
} from '../../../test/support/academic-fake';
import type { CatalogProgram } from '../ports/catalog';
import { SourceError } from '../ports/source-gateway';
import { Secret } from '../shared/secret';
import type { WebPrincipal } from '../web/web-api';
import { CONSENT_VERSION, DAILY_LIMIT, DRAFT_TTL_MS, STALE_RUNNING_MS, AcademicImports } from './academic-imports';
import { CatalogService } from './catalog.service';

const PROGRAM: CatalogProgram = { sigaaId: '10', name: 'ENGENHARIA DA COMPUTAÇÃO', campus: 'SALVADOR', level: 'G' };
const P: WebPrincipal = { userId: 'u1', clientId: 'ufba-web', chave: Buffer.alloc(32, 1), sessionKey: 's1' };

function montar(opts: { semLeitor?: boolean; capUsd?: number } = {}) {
  let t = new Date('2026-11-15T12:00:00Z').getTime();
  const repo = new InMemoryAcademic();
  const source = new FakeTranscriptSource();
  const extractor = new FakeExtractor();
  const reader = new FakeReader();
  const catalogRepo = new InMemoryCatalog();
  const catalogSource = new FakeCatalogSource();
  catalogSource.programs = [PROGRAM];
  catalogSource.components = curriculumOf(perfect());
  const catalog = new CatalogService(catalogRepo, catalogSource, () => new Date(t));
  let sigaaAberto = true;
  const sigaa = {
    openSigaa: async () =>
      sigaaAberto ? { login: '12345678901', senha: Secret.of('senha-de-teste'), credencialId: 'c1', dk: Secret.of('x') } : null,
  };
  const svc = new AcademicImports(repo, source, extractor, opts.semLeitor ? null : reader, catalog, sigaa as never, () => new Date(t), {
    monthlyCapUsd: opts.capUsd ?? 5,
  });
  return {
    repo,
    source,
    extractor,
    reader,
    catalogRepo,
    catalogSource,
    svc,
    avancar: (ms: number) => (t += ms),
    fecharSigaa: () => (sigaaAberto = false),
  };
}

type Env = ReturnType<typeof montar>;

async function importar(m: Env) {
  await m.svc.setConsent(P, true);
  await m.svc.start(P);
  await m.svc.idle(P.userId);
}

describe('AcademicImports: pré-condições', () => {
  it('sem chave do provedor (leitor nulo): indisponível (503 import_unavailable) e a oferta some (available false)', async () => {
    const m = montar({ semLeitor: true });
    expect((await m.svc.state(P)).available).toBe(false);
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 503, code: 'import_unavailable' });
  });

  it('sem consentimento: 409 consent_required, e nada é lido', async () => {
    const m = montar();
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 409, code: 'consent_required' });
    expect(m.source.calls).toBe(0);
  });

  it('revogar o consentimento volta a exigi-lo', async () => {
    const m = montar();
    await m.svc.setConsent(P, true);
    expect((await m.svc.state(P)).consent).toBe(true);
    await m.svc.setConsent(P, false);
    expect((await m.svc.state(P)).consent).toBe(false);
    await expect(m.svc.start(P)).rejects.toMatchObject({ code: 'consent_required' });
  });

  it('consentimento de uma versão antiga do texto não vale', async () => {
    const m = montar();
    await m.repo.saveConsent(P.userId, CONSENT_VERSION - 1, new Date());
    expect((await m.svc.state(P)).consent).toBe(false);
  });

  it('SIGAA fechado nesta sessão: 409 source_not_connected', async () => {
    const m = montar();
    await m.svc.setConsent(P, true);
    m.fecharSigaa();
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 409, code: 'source_not_connected' });
    expect(m.source.calls).toBe(0);
  });
});

describe('AcademicImports: importar e confirmar', () => {
  it('fluxo feliz: lê, confere com o curso, guarda como rascunho e pede a confirmação', async () => {
    const m = montar();
    await importar(m);

    const s = await m.svc.state(P);
    expect(s).toMatchObject({ available: true, consent: true, status: 'NEEDS_CONFIRMATION', failure: null, verified: true, reader: 'ai', summary: null });
    expect(s.draft?.components).toHaveLength(49);
    expect(s.draft?.verification.verified).toBe(true);
    expect(m.source.calls).toBe(1);
    expect(m.reader.calls).toBe(1);
    // Nada de histórico gravado antes da confirmação.
    expect(m.repo.transcripts.size).toBe(0);
    expect(m.repo.profiles.size).toBe(0);
    // O curso foi importado em paralelo (o nome vem do portal) e fica ligado ao estado.
    expect(m.catalogSource.calls.fetch).toBe(1);
    expect((await m.repo.getImport(P.userId))?.programId).toBe('10');
    expect(s.curriculumStatus).toBe('READY');
  });

  it('registra a tentativa só com contagens, resultado e tokens (nunca conteúdo)', async () => {
    const m = montar();
    await importar(m);
    expect(m.repo.logs).toHaveLength(1);
    const log = m.repo.logs[0];
    expect(log).toMatchObject({ userId: 'u1', result: 'NEEDS_CONFIRMATION', verified: true, componentsCount: 49, inputTokens: 5000, outputTokens: 3000 });
    expect(Object.keys(log).sort()).toEqual(['componentsCount', 'inputTokens', 'latencyMs', 'outputTokens', 'result', 'startedAt', 'userId', 'verified']);
    expect(JSON.stringify(log)).not.toMatch(/FÍSICA|FISD36|senha-de-teste/);
  });

  it('a senha só é passada à fonte e nunca fica no estado, no rascunho nem no log', async () => {
    const m = montar();
    await importar(m);
    const all = JSON.stringify([...m.repo.imports.values()]) + JSON.stringify(m.repo.logs);
    expect(all).not.toContain('senha-de-teste');
    expect(all).not.toContain('12345678901');
  });

  it('confirmar grava o histórico (substitui) e o perfil do portal, e apaga o rascunho', async () => {
    const m = montar();
    await importar(m);
    await m.svc.confirm(P);

    expect(m.repo.transcripts.get('u1')?.components).toHaveLength(49);
    expect(m.repo.profiles.get('u1')).toEqual({ registration: '123456789', program: 'ENGENHARIA DE COMPUTAÇÃO/PGCOMP - Salvador', entryTerm: '2022.1' });
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'READY', draft: null, curriculumStatus: 'READY' });
    expect(s.importedAt).toBeInstanceOf(Date);
    expect(s.summary).toMatchObject({ programName: expect.any(String), currentTerm: expect.any(Number) });
    expect((await m.repo.getImport(P.userId))?.draft).toBeNull();
  });

  it('confirmar sem rascunho: 404 import_not_found', async () => {
    const m = montar();
    await expect(m.svc.confirm(P)).rejects.toMatchObject({ status: 404, code: 'import_not_found' });
    await importar(m);
    await m.svc.confirm(P);
    await expect(m.svc.confirm(P)).rejects.toMatchObject({ code: 'import_not_found' }); // já confirmado
  });

  it('o rascunho que passou de 7 dias some', async () => {
    const m = montar();
    await importar(m);
    m.avancar(DRAFT_TTL_MS + 60_000);
    expect((await m.svc.state(P)).status).toBe('NONE');
    await expect(m.svc.confirm(P)).rejects.toMatchObject({ code: 'import_not_found' });
  });

  it('leitura que não fecha: o rascunho vem com verified=false e os avisos (a confirmação passa a ser obrigatória)', async () => {
    const m = montar();
    m.reader.document.components[0] = { ...m.reader.document.components[0], grade: 1 };
    await importar(m);
    const s = await m.svc.state(P);
    expect(s.status).toBe('NEEDS_CONFIRMATION');
    expect(s.verified).toBe(false);
    expect(s.draft?.verification.warnings.join(' ')).toMatch(/CR recalculado/);
  });

  it('a conferência com o curso entra no rascunho (muitos obrigatórios fora do curso derrubam verified)', async () => {
    const m = montar();
    // O catálogo do curso "10" só tem um componente: quase todos os obrigatórios do histórico ficam sem par.
    m.catalogSource.components = curriculumOf(perfect()).slice(0, 1);
    await importar(m);
    const s = await m.svc.state(P);
    expect(s.verified).toBe(false);
    expect(s.draft?.verification.warnings.join(' ')).toMatch(/não existem no currículo do curso/);
  });

  it('falha ao importar o curso NÃO falha o histórico (a grade é um bônus)', async () => {
    const m = montar();
    m.catalogSource.fetchActiveCurriculum = async () => {
      throw new Error('SIGAA público fora');
    };
    await importar(m);
    const s = await m.svc.state(P);
    expect(s.status).toBe('NEEDS_CONFIRMATION');
    expect(s.draft?.verification.warnings).toEqual([]); // sem catálogo, a conferência é pulada
    expect((await m.repo.getImport(P.userId))?.programId).toBe('10'); // o curso foi reconhecido; a grade, não
  });

  it('curso que não existe no catálogo público: o histórico segue, sem programId', async () => {
    const m = montar();
    m.catalogSource.programs = [];
    m.source.snapshot = { ...m.source.snapshot, profile: { ...m.source.snapshot.profile, program: 'CURSO INEXISTENTE' } };
    await importar(m);
    const s = await m.svc.state(P);
    expect(s.status).toBe('NEEDS_CONFIRMATION');
    expect((await m.repo.getImport(P.userId))?.programId).toBeNull();
    expect(s.curriculumStatus).toBe('NONE');
  });

  it('uma nova importação substitui o histórico anterior só quando confirmada', async () => {
    const m = montar();
    await importar(m);
    await m.svc.confirm(P);
    m.reader.document = { ...perfect(), notes: ['- nota nova'] };
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    expect(m.repo.transcripts.get('u1')?.notes).not.toEqual(['- nota nova']); // ainda o antigo
    await m.svc.confirm(P);
    expect(m.repo.transcripts.get('u1')?.notes).toEqual(['- nota nova']);
  });
});

describe('AcademicImports: falhas, limites e concorrência', () => {
  it.each([
    ['a senha não vale (REAUTH_NEEDED)', (m: Env): void => void (m.source.error = new SourceError('REAUTH_NEEDED', 'login recusado')), 'SESSION_EXPIRED'],
    ['credencial recusada', (m: Env): void => void (m.source.error = new SourceError('CREDENTIAL_REJECTED', 'x')), 'SESSION_EXPIRED'],
    ['SIGAA fora do ar', (m: Env): void => void (m.source.error = new SourceError('UNAVAILABLE', 'fora')), 'SIGAA_UNAVAILABLE'],
    ['erro qualquer da fonte', (m: Env): void => void (m.source.error = new Error('boom')), 'SIGAA_UNAVAILABLE'],
    ['o arquivo não é um PDF', (m: Env): void => void (m.extractor.fail = true), 'PDF_INVALID'],
    ['a redação recusa (identidade sobraria)', (m: Env): void => void (m.extractor.items = ITEMS.filter((i) => !i.text.includes('Cursados/Cursando'))), 'REDACTION_REFUSED'],
    ['o provedor de IA falha', (m: Env): void => void (m.reader.fail = true), 'READER_FAILED'],
  ] as const)('%s: vira FAILED com o código %s, sem rascunho', async (_name, arrange, code) => {
    const m = montar();
    arrange(m);
    await importar(m);
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'FAILED', failure: code, draft: null });
    expect(m.repo.logs[0].result).toBe(code);
    // O estado de falha guarda só o código, nunca a mensagem do erro.
    expect(JSON.stringify(await m.repo.getImport(P.userId))).not.toMatch(/boom|sem crédito|login recusado/);
  });

  it('a redação recusando: o modelo nem é chamado', async () => {
    const m = montar();
    m.extractor.items = ITEMS.filter((i) => !i.text.includes('Cursados/Cursando'));
    await importar(m);
    expect(m.reader.calls).toBe(0);
  });

  it('depois de uma falha dá para tentar de novo', async () => {
    const m = montar();
    m.reader.fail = true;
    await importar(m);
    expect((await m.svc.state(P)).status).toBe('FAILED');
    m.reader.fail = false;
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    expect((await m.svc.state(P)).status).toBe('NEEDS_CONFIRMATION');
  });

  it('uma importação por pessoa por vez: a segunda enquanto roda dá 409 import_in_progress', async () => {
    const m = montar();
    await m.svc.setConsent(P, true);
    let solta!: () => void;
    const original = m.source.fetch.bind(m.source);
    m.source.fetch = () => new Promise((resolve) => (solta = () => resolve(original())));
    await m.svc.start(P);
    expect((await m.svc.state(P)).status).toBe('RUNNING');
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 409, code: 'import_in_progress' });
    solta();
    await m.svc.idle(P.userId);
    expect((await m.svc.state(P)).status).toBe('NEEDS_CONFIRMATION');
  });

  it('"rodando" parado há mais de 10 min (o processo reiniciou) falha sozinho com TIMEOUT e permite tentar de novo', async () => {
    const m = montar();
    await m.svc.setConsent(P, true);
    await m.repo.saveImport({
      userId: P.userId,
      status: 'RUNNING',
      failure: null,
      programId: null,
      draft: null,
      profile: null,
      verified: null,
      reader: null,
      componentsCount: null,
      startedAt: new Date(Date.now()),
      finishedAt: null,
      importedAt: null,
    });
    m.avancar(STALE_RUNNING_MS + 60_000);
    // O `startedAt` acima é "agora" do relógio real; o relógio do serviço andou para frente.
    const imp = await m.repo.getImport(P.userId);
    imp!.startedAt = new Date('2026-11-15T11:00:00Z');
    await m.repo.saveImport(imp!);
    expect(await m.svc.state(P)).toMatchObject({ status: 'FAILED', failure: 'TIMEOUT' });
    await expect(m.svc.start(P)).resolves.toBeUndefined();
    await m.svc.idle(P.userId);
  });

  it(`limite por pessoa: ${DAILY_LIMIT} leituras por dia (429 too_many_attempts); outra pessoa não é afetada; no dia seguinte volta`, async () => {
    const m = montar();
    await m.svc.setConsent(P, true);
    for (let i = 0; i < DAILY_LIMIT; i++) {
      await m.svc.start(P);
      await m.svc.idle(P.userId);
    }
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });

    const other: WebPrincipal = { ...P, userId: 'u2' };
    await m.svc.setConsent(other, true);
    await expect(m.svc.start(other)).resolves.toBeUndefined();
    await m.svc.idle('u2');

    m.avancar(25 * 60 * 60 * 1000);
    await expect(m.svc.start(P)).resolves.toBeUndefined();
    await m.svc.idle(P.userId);
  });

  it('teto de gasto do mês: ao atingir, 503 import_unavailable (e volta no mês seguinte)', async () => {
    const m = montar({ capUsd: 0.001 });
    await m.svc.setConsent(P, true);
    await m.repo.addLog({ userId: 'u9', startedAt: new Date('2026-11-02T10:00:00Z'), result: 'OK', verified: true, componentsCount: 1, inputTokens: 5000, outputTokens: 3000, latencyMs: 1 });
    // 5000*0,10/M + 3000*0,50/M = US$ 0,002 >= US$ 0,001
    await expect(m.svc.start(P)).rejects.toMatchObject({ status: 503, code: 'import_unavailable' });
    m.avancar(20 * 24 * 60 * 60 * 1000); // dezembro
    await expect(m.svc.start(P)).resolves.toBeUndefined();
    await m.svc.idle(P.userId);
  });
});

describe('AcademicImports: apagar e a grade do curso', () => {
  it('apagar remove histórico, rascunho e perfil, e mantém o aceite', async () => {
    const m = montar();
    await importar(m);
    await m.svc.confirm(P);
    await m.svc.remove(P);
    expect(m.repo.transcripts.size).toBe(0);
    expect(m.repo.imports.size).toBe(0);
    expect(m.repo.profiles.size).toBe(0);
    expect(await m.svc.state(P)).toMatchObject({ consent: true, status: 'NONE', summary: null, draft: null });
  });

  it('a grade do curso: adequada ao currículo Ativo, marcada com o que foi feito, sempre estimativa', async () => {
    const m = montar();
    await importar(m);
    await m.svc.confirm(P);
    const progress = await m.svc.progress(P);
    expect(progress).toMatchObject({ estimate: true, curriculumCode: 'G20251' });
    expect(progress.required.map((c) => c.code)).toContain('FISD36');
    expect(progress.required.find((c) => c.code === 'FISD36')?.state).toBe('DONE');
  });

  it('sem histórico gravado: 404 import_not_found; sem a grade do curso: 409 curriculum_unavailable', async () => {
    const m = montar();
    await expect(m.svc.progress(P)).rejects.toMatchObject({ status: 404, code: 'import_not_found' });
    m.catalogSource.programs = [];
    m.source.snapshot = { ...m.source.snapshot, profile: { ...m.source.snapshot.profile, program: 'CURSO INEXISTENTE' } };
    await importar(m);
    await m.svc.confirm(P);
    await expect(m.svc.progress(P)).rejects.toMatchObject({ status: 409, code: 'curriculum_unavailable' });
  });
});

describe('AcademicImports: Atualizar com histórico gravado e descartar o rascunho', () => {
  async function comHistorico() {
    const m = montar();
    await importar(m);
    await m.svc.confirm(P);
    const antes = await m.svc.state(P);
    return { m, antes };
  }

  it('primeira importação: sem histórico gravado o summary e o importedAt são nulos até confirmar', async () => {
    const m = montar();
    await importar(m);
    expect(await m.svc.state(P)).toMatchObject({ status: 'NEEDS_CONFIRMATION', summary: null, importedAt: null });
  });

  it('durante o Atualizar (rodando) o summary e o importedAt do histórico gravado continuam', async () => {
    const { m, antes } = await comHistorico();
    expect(antes.summary).not.toBeNull();
    let liberar!: (v: Awaited<ReturnType<typeof m.source.fetch>>) => void;
    const snapshot = m.source.snapshot;
    m.source.fetch = () => new Promise((r) => (liberar = r));
    m.avancar(60_000);
    await m.svc.start(P);
    const rodando = await m.svc.state(P);
    expect(rodando).toMatchObject({ status: 'RUNNING', draft: null, importedAt: antes.importedAt, curriculumStatus: 'READY' });
    expect(rodando.summary).toEqual(antes.summary);
    liberar(snapshot);
    await m.svc.idle(P.userId);
  });

  it('com o rascunho esperando confirmação o summary é o do histórico gravado, e a grade do curso continua', async () => {
    const { m, antes } = await comHistorico();
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'NEEDS_CONFIRMATION', importedAt: antes.importedAt });
    expect(s.draft).not.toBeNull();
    expect(s.summary).toEqual(antes.summary);
    expect((await m.svc.progress(P)).estimate).toBe(true);
  });

  it('se o Atualizar falha, o histórico gravado segue com summary e importedAt', async () => {
    const { m, antes } = await comHistorico();
    m.reader.fail = true;
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'FAILED', failure: 'READER_FAILED', importedAt: antes.importedAt, curriculumStatus: 'READY' });
    expect(s.summary).toEqual(antes.summary);
  });

  it('descartar o rascunho com histórico gravado volta a READY e não mexe no histórico', async () => {
    const { m, antes } = await comHistorico();
    m.reader.document = { ...perfect(), notes: ['- nota nova'] };
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    const guardado = JSON.stringify(m.repo.transcripts.get('u1'));
    await m.svc.discardDraft(P);
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'READY', failure: null, draft: null, importedAt: antes.importedAt, verified: true });
    expect(s.summary).toEqual(antes.summary);
    expect(JSON.stringify(m.repo.transcripts.get('u1'))).toBe(guardado);
    // E já dá para atualizar de novo.
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
  });

  it('descartar a falha de um Atualizar volta a READY', async () => {
    const { m } = await comHistorico();
    m.reader.fail = true;
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    await m.svc.discardDraft(P);
    expect(await m.svc.state(P)).toMatchObject({ status: 'READY', failure: null });
  });

  it('descartar sem histórico gravado volta a NONE (primeira importação)', async () => {
    const m = montar();
    await importar(m);
    await m.svc.discardDraft(P);
    expect(await m.svc.state(P)).toMatchObject({ status: 'NONE', summary: null, draft: null, importedAt: null });
    expect(m.repo.imports.size).toBe(0);
  });

  it('descartar: 404 sem rascunho nem falha (NONE ou READY); 409 durante a leitura', async () => {
    const m = montar();
    await expect(m.svc.discardDraft(P)).rejects.toMatchObject({ status: 404, code: 'import_not_found' });
    await importar(m);
    await m.svc.confirm(P);
    await expect(m.svc.discardDraft(P)).rejects.toMatchObject({ status: 404, code: 'import_not_found' });

    let liberar!: (v: Awaited<ReturnType<typeof m.source.fetch>>) => void;
    const snapshot = m.source.snapshot;
    m.source.fetch = () => new Promise((r) => (liberar = r));
    m.avancar(60_000);
    await m.svc.start(P);
    await expect(m.svc.discardDraft(P)).rejects.toMatchObject({ status: 409, code: 'import_in_progress' });
    liberar(snapshot);
    await m.svc.idle(P.userId);
  });

  it('o rascunho de um Atualizar que passou de 7 dias some e volta ao histórico gravado (READY), não a NONE', async () => {
    const { m, antes } = await comHistorico();
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    m.avancar(8 * 24 * 60 * 60_000);
    const s = await m.svc.state(P);
    expect(s).toMatchObject({ status: 'READY', draft: null, importedAt: antes.importedAt });
    expect(s.summary).toEqual(antes.summary);
  });

  it('confirmar o Atualizar troca o histórico e a data', async () => {
    const { m, antes } = await comHistorico();
    m.avancar(60_000);
    await m.svc.start(P);
    await m.svc.idle(P.userId);
    await m.svc.confirm(P);
    const s = await m.svc.state(P);
    expect(s.status).toBe('READY');
    expect(s.importedAt!.getTime()).toBeGreaterThan(antes.importedAt!.getTime());
  });
});

describe('AcademicImports: co-requisito e unidade responsável na grade do curso', () => {
  it('saem do catálogo importado em cada componente; nulos quando o SIGAA não imprime', async () => {
    const m = montar();
    const comps = curriculumOf(perfect());
    comps[0] = { ...comps[0]!, corequisiteExpr: 'FISD37', responsibleUnit: 'INSTITUTO DE FISICA' };
    m.catalogSource.components = comps;
    await importar(m);
    await m.svc.confirm(P);
    const progress = await m.svc.progress(P);
    const first = progress.required.find((c) => c.code === comps[0]!.code)!;
    expect(first).toMatchObject({ corequisiteExpr: 'FISD37', responsibleUnit: 'INSTITUTO DE FISICA' });
    const other = progress.required.find((c) => c.code === comps[1]!.code)!;
    expect(other).toMatchObject({ corequisiteExpr: null, responsibleUnit: null });
  });
});
