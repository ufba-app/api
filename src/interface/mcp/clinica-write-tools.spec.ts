import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReconectarError } from '../../application/siasb/siasb-session-runner';
import { WriteFailedError, WriteInputError, type WriteOutcome } from '../../application/siasb/siasb-writer';
import { FERRAMENTAS_ESCRITA_AGENDA, FERRAMENTAS_ESCRITA_PROCEDIMENTOS } from './clinica-write-tools';
import { buildMcpServer } from './mcp-tools';
import type { McpClinica, McpClinicaWrite, McpPrincipal, McpUseCases } from './mcp-ports';

const OBS_CANARIO = 'OBS-CANARIO-777';

class FakeWrite implements McpClinicaWrite {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  outcome: WriteOutcome = { status: 'preview', summary: 'Vai fazer algo.', details: { x: 1 } };
  failure: Error | null = null;
  private go(name: string, args: Record<string, unknown>): Promise<WriteOutcome> {
    this.calls.push({ name, args });
    return this.failure ? Promise.reject(this.failure) : Promise.resolve(this.outcome);
  }
  scheduleSession(_u: string, i: Parameters<McpClinicaWrite['scheduleSession']>[1]) {
    return this.go('schedule', i as unknown as Record<string, unknown>);
  }
  unscheduleSession(_u: string, i: Parameters<McpClinicaWrite['unscheduleSession']>[1]) {
    return this.go('unschedule', i as unknown as Record<string, unknown>);
  }
  addProcedure(_u: string, i: Parameters<McpClinicaWrite['addProcedure']>[1]) {
    return this.go('add', i as unknown as Record<string, unknown>);
  }
  removeProcedure(_u: string, i: Parameters<McpClinicaWrite['removeProcedure']>[1]) {
    return this.go('remove', i as unknown as Record<string, unknown>);
  }
}

const clinicaWith = (w?: McpClinicaWrite): McpClinica => ({ writes: () => w }) as unknown as McpClinica;

async function connect(p: McpPrincipal, clinica?: McpClinica): Promise<Client> {
  const server = buildMcpServer({} as McpUseCases, p, undefined, clinica);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const both = { userId: 'u1', siasb: true, permissions: new Set(['siasb.schedule_write', 'siasb.procedures_write']) };
const texto = (res: unknown) => (res as { content: { text: string }[] }).content[0].text;
const isError = (res: unknown) => (res as { isError?: boolean }).isError === true;
const ALL = [...FERRAMENTAS_ESCRITA_AGENDA, ...FERRAMENTAS_ESCRITA_PROCEDIMENTOS] as string[];
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).filter((n) => ALL.includes(n));

const FUTURO = '2026-11-20T14:00:00-03:00';

describe('visibilidade das ferramentas de escrita', () => {
  it('sem permissão, sem siasb ou sem a dependência de escrita nenhuma aparece', async () => {
    const w = new FakeWrite();
    expect(await names(await connect({ userId: 'u1', siasb: true }, clinicaWith(w)))).toEqual([]);
    expect(await names(await connect({ ...both, siasb: false }, clinicaWith(w)))).toEqual([]);
    expect(await names(await connect(both, clinicaWith(undefined)))).toEqual([]);
    expect(await names(await connect(both, {} as McpClinica))).toEqual([]);
  });

  it('cada chave libera só as suas duas ferramentas', async () => {
    const w = new FakeWrite();
    const agenda = await names(await connect({ ...both, permissions: new Set(['siasb.schedule_write']) }, clinicaWith(w)));
    expect(agenda.sort()).toEqual([...FERRAMENTAS_ESCRITA_AGENDA].sort());
    const proc = await names(await connect({ ...both, permissions: new Set(['siasb.procedures_write']) }, clinicaWith(w)));
    expect(proc.sort()).toEqual([...FERRAMENTAS_ESCRITA_PROCEDIMENTOS].sort());
    expect((await names(await connect(both, clinicaWith(w)))).length).toBe(4);
  });
});

describe('metadados das ferramentas de escrita', () => {
  it('title, annotations, descrição com a exigência de confirmação e params com type', async () => {
    const c = await connect(both, clinicaWith(new FakeWrite()));
    const tools = (await c.listTools()).tools.filter((t) => ALL.includes(t.name));
    expect(tools).toHaveLength(4);
    for (const t of tools) {
      expect(t.title!.length).toBeGreaterThan(2);
      expect((t.annotations as { title?: string }).title).toBe(t.title);
      expect(t.annotations?.readOnlyHint).toBe(false);
      expect(t.annotations?.idempotentHint).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(t.name === 'clinica_desmarcar_sessao' || t.name === 'clinica_excluir_procedimento');
      const d = t.description!;
      expect(d).toContain('confirmado');
      expect(d).toContain('MOSTRE');
      expect(d).toContain('OK');
      expect(d).toContain('não se repete automaticamente');
      const props = (t.inputSchema as { properties: Record<string, { type?: unknown }> }).properties;
      for (const [k, v] of Object.entries(props)) expect([k, v.type]).not.toEqual([k, undefined]);
      expect((props.confirmado as { default?: unknown }).default).toBe(false);
    }
    const byName = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(byName('clinica_desmarcar_sessao')).toContain('FUTURAS');
    expect(byName('clinica_desmarcar_sessao')).toContain('difícil de desfazer');
    expect(byName('clinica_desmarcar_sessao')).toContain('nunca registra falta');
    expect(byName('clinica_incluir_procedimento')).toContain('PREVISTO');
    expect(byName('clinica_excluir_procedimento')).toContain('não dá para desfazer');
  });
});

describe('chamadas', () => {
  it('sem confirmado o fake recebe confirmed false; com true recebe true; quantidade padrão 1', async () => {
    const w = new FakeWrite();
    const c = await connect(both, clinicaWith(w));
    const base = { atendimentoId: '10', inicio: FUTURO, duracaoMin: 60 };
    await c.callTool({ name: 'clinica_agendar_sessao', arguments: base });
    await c.callTool({
      name: 'clinica_agendar_sessao',
      arguments: { ...base, quantidade: 3, confirmado: true, professorId: '1', localId: '2', grupoId: '3' },
    });
    expect(w.calls[0].args).toMatchObject({ confirmed: false, count: 1, attendanceId: '10', durationMin: 60 });
    expect((w.calls[0].args.start as Date).toISOString()).toBe('2026-11-20T17:00:00.000Z');
    expect(w.calls[1].args).toMatchObject({ confirmed: true, count: 3, professorId: '1', localId: '2', grupoId: '3' });
  });

  it('confirmado ausente nunca confirma e true repassa true (as outras três também)', async () => {
    const w = new FakeWrite();
    const c = await connect(both, clinicaWith(w));
    await c.callTool({ name: 'clinica_desmarcar_sessao', arguments: { sessaoId: '5' } });
    await c.callTool({ name: 'clinica_incluir_procedimento', arguments: { atendimentoId: '1', procedimentoId: '2' } });
    await c.callTool({ name: 'clinica_excluir_procedimento', arguments: { atendimentoId: '1', procedimentoId: '2' } });
    expect(w.calls.map((x) => x.args.confirmed)).toEqual([false, false, false]);
    await c.callTool({ name: 'clinica_desmarcar_sessao', arguments: { sessaoId: '5', motivo: 'm', confirmado: true } });
    await c.callTool({
      name: 'clinica_incluir_procedimento',
      arguments: { atendimentoId: '1', procedimentoId: '2', dente: '11', face: 'M', confirmado: true },
    });
    await c.callTool({ name: 'clinica_excluir_procedimento', arguments: { atendimentoId: '1', procedimentoId: '9', confirmado: true } });
    expect(w.calls.slice(3).map((x) => x.args.confirmed)).toEqual([true, true, true]);
    expect(w.calls[3].args).toMatchObject({ sessionId: '5', motivo: 'm' });
    expect(w.calls[4].args).toMatchObject({ attendanceId: '1', serviceId: '2', teeth: '11', faces: 'M' });
    expect(w.calls[5].args).toMatchObject({ attendanceId: '1', procedureId: '9' });
  });

  it('inicio sem fuso ou inválido vira erro de entrada, sem eco e sem chamar o escritor', async () => {
    const w = new FakeWrite();
    const c = await connect(both, clinicaWith(w));
    for (const inicio of ['2026-11-20T14:00:00', '2026-11-20', 'amanha-SEGREDO']) {
      const r = await c.callTool({ name: 'clinica_agendar_sessao', arguments: { atendimentoId: '10', inicio, duracaoMin: 60 } });
      expect(isError(r)).toBe(true);
      expect(texto(r)).toMatch(/^entrada_invalida: /);
      expect(texto(r)).not.toContain(inicio);
    }
    expect(w.calls).toEqual([]);
  });

  it('os resultados resumo, escolher e feito chegam em português', async () => {
    const w = new FakeWrite();
    const c = await connect(both, clinicaWith(w));
    const args = { atendimentoId: '10', inicio: FUTURO, duracaoMin: 60 };
    let r = JSON.parse(texto(await c.callTool({ name: 'clinica_agendar_sessao', arguments: args })));
    expect(r).toEqual({ status: 'resumo', resumo: 'Vai fazer algo.', detalhes: { x: 1 } });
    w.outcome = {
      status: 'choose',
      options: { professors: [{ id: '1', name: 'Prof', preferred: false }], locations: [], groups: [] },
      missing: ['professor', 'local'],
    };
    r = JSON.parse(texto(await c.callTool({ name: 'clinica_agendar_sessao', arguments: args })));
    expect(r.status).toBe('escolher');
    expect(r.faltando).toEqual(['professor', 'local']);
    expect(r.opcoes.professors).toEqual([{ id: '1', name: 'Prof', preferred: false }]);
    w.outcome = { status: 'done', summary: 'Feito.', details: { verificado: true } };
    r = JSON.parse(texto(await c.callTool({ name: 'clinica_agendar_sessao', arguments: { ...args, confirmado: true } })));
    expect(r).toEqual({ status: 'feito', resumo: 'Feito.', detalhes: { verificado: true } });
  });

  it('erros do escritor viram codigo: mensagem fixa', async () => {
    const w = new FakeWrite();
    const c = await connect(both, clinicaWith(w));
    const call = () =>
      c.callTool({ name: 'clinica_excluir_procedimento', arguments: { atendimentoId: '1', procedimentoId: '2', confirmado: true } });
    w.failure = new WriteFailedError('siasb_write_unknown', 'O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo.');
    const r = await call();
    expect(isError(r)).toBe(true);
    expect(texto(r)).toBe('siasb_write_unknown: O SIASB não confirmou a operação. Confira no site do SIASB antes de tentar de novo.');
    w.failure = new WriteInputError('Mensagem fixa.');
    expect(texto(await call())).toBe('entrada_invalida: Mensagem fixa.');
    w.failure = new ReconectarError();
    expect(texto(await call())).toMatch(/^reconectar: /);
  });

  it('a observação não aparece em log nem na resposta de erro', async () => {
    const w = new FakeWrite();
    w.failure = new WriteInputError('Mensagem fixa.');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const c = await connect(both, clinicaWith(w));
      const r = await c.callTool({
        name: 'clinica_agendar_sessao',
        arguments: { atendimentoId: '10', inicio: FUTURO, duracaoMin: 60, observacao: OBS_CANARIO, confirmado: true },
      });
      expect(texto(r)).not.toContain(OBS_CANARIO);
      const logged = [...spies.flatMap((s) => s.mock.calls), ...out.mock.calls, ...err.mock.calls]
        .map((x) => JSON.stringify(x))
        .join('\n');
      expect(logged).not.toContain(OBS_CANARIO);
    } finally {
      [...spies, out, err].forEach((s) => s.mockRestore());
    }
  });
});
