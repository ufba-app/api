import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession, Procedure } from '../../domain/siasb/types';
import { AcademicCalendar } from '../../application/ports/academic-calendar';
import {
  SourceAccountRepository,
  type EncryptedSecret,
  type SourceAccountRecord,
  type UpsertSourceAccountInput,
} from '../../application/ports/repositories';
import { SecretCipher } from '../../application/ports/secret-cipher';
import { SiasbError, SiasbSession, SiasbSource } from '../../application/ports/siasb-source';
import { ReconectarError, SiasbReadError, SiasbReader } from '../../application/siasb/siasb-reader';
import { FERRAMENTAS_CLINICA, resolveSiasbFlag, toBahiaIso } from './clinica-tools';
import { buildMcpServer } from './mcp-tools';
import type { McpClinica, McpPrincipal, McpUseCases } from './mcp-ports';

const NOW = new Date('2026-11-23T12:00:00Z'); // segunda
const d = (iso: string) => new Date(iso);

const PACIENTE = 'Fulano Beltrano da Silva';
const PRONTUARIO = 'PRONT-998877';

function sess(id: string, disc: string, att: string, startIso: string, label = 'Confirmado', resched: string | null = null): ClinicalSession {
  const startAt = d(startIso);
  return {
    id,
    attendanceId: att,
    disciplineId: disc,
    disciplineName: `Disc ${disc}`,
    initials: 'FB',
    professorName: 'Profa Maria',
    locationName: 'Clínica 2',
    startAt,
    endAt: new Date(startAt.getTime() + 3_600_000),
    rescheduledStartAt: resched ? d(resched) : null,
    statusLabel: label,
  };
}

class FakeSiasb extends SiasbSource {
  calls: string[] = [];
  failure: Error | null = null;
  discs: ClinicalDiscipline[] = [
    { id: '1', name: 'Disc 1' },
    { id: '2', name: 'Disc 2' },
    { id: '3', name: 'Disc 3' },
  ];
  atts: ClinicalAttendance[] = [
    { id: 'a2', disciplineId: '2', initials: 'AB', treatmentType: 'PLANNING', concluded: false },
    { id: 'a3', disciplineId: '3', initials: 'CD', treatmentType: 'PLANNING', concluded: false },
  ];
  inactiveAtts: ClinicalAttendance[] = [];
  procs: Procedure[] = [];
  procedureCalls: { attendanceId: string; term?: string }[] = [];
  unassigned: Record<string, number> = {};
  sess: ClinicalSession[] = [
    sess('s1', '3', 'a3', '2026-11-06T13:00:00Z', 'Atendido'),
    sess('s2', '3', 'a3', '2026-11-13T13:00:00Z', 'Atendido'),
    sess('s3', '3', 'a3', '2026-11-27T13:00:00Z', 'Confirmado', '2026-12-02T13:00:00Z'),
  ];
  private touch(name: string) {
    this.calls.push(name);
    if (this.failure) throw this.failure;
  }
  async courseOptions() {
    return [];
  }
  async login(): Promise<{ session: SiasbSession; username: string }> {
    throw new Error('no');
  }
  async disciplines() {
    this.touch('disciplines');
    return this.discs;
  }
  async attendances(_s: SiasbSession, which: 'active' | 'inactive') {
    this.touch(`attendances:${which}`);
    return which === 'active' ? this.atts : this.inactiveAtts;
  }
  async sessions() {
    this.touch('sessions');
    return this.sess;
  }
  async procedures(_s: SiasbSession, attendanceId: string, term?: string): Promise<Procedure[]> {
    this.touch('procedures');
    this.procedureCalls.push({ attendanceId, term });
    return this.procs;
  }
  async unassignedCount() {
    this.touch('unassigned');
    return this.unassigned;
  }
}

class FakeAccounts extends SourceAccountRepository {
  rows: SourceAccountRecord[] = [
    {
      id: 'acc1',
      userId: 'u1',
      provider: 'SIASB',
      accountKey: 'siasb',
      siteUrl: null,
      status: 'OK',
      lastSyncedAt: null,
      expiresAt: new Date('2026-12-30T00:00:00Z'),
      secret: { ciphertext: JSON.stringify({ k: 'v' }), iv: 'iv', authTag: 'tag' },
    },
  ];
  async upsert(_i: UpsertSourceAccountInput): Promise<SourceAccountRecord> {
    throw new Error('no');
  }
  async findByUserAndProvider(userId: string, provider: string) {
    return this.rows.filter((r) => r.userId === userId && r.provider === provider);
  }
  async listByUser() {
    return [];
  }
  async setStatus() {}
  async updateSecret() {}
  async delete() {}
}

class FakeCipher extends SecretCipher {
  encrypt(plain: string): EncryptedSecret {
    return { ciphertext: plain, iv: 'iv', authTag: 'tag' };
  }
  decrypt(s: EncryptedSecret): string {
    return s.ciphertext;
  }
}

class FakeCalendar extends AcademicCalendar {
  constructor(public result: { known: boolean; dates: string[] } = { known: false, dates: [] }) {
    super();
  }
  async holidays() {
    return this.result;
  }
}

function setup(calendar = new FakeCalendar()) {
  const siasb = new FakeSiasb();
  const reader = new SiasbReader(siasb, new FakeAccounts(), new FakeCipher(), calendar, () => NOW);
  const clinica: McpClinica = {
    hasConnection: async () => true,
    situation: (u) => reader.situation(u),
    sessions: (u, r) => reader.sessions(u, r),
    bookingDeadline: (u, i) => reader.bookingDeadline(u, i),
    patients: (u) => reader.patients(u),
    vacancies: (u) => reader.vacancies(u),
    schedulingContext: (u, a, t) => reader.schedulingContext(u, a, t),
    progress: (u, r) => reader.progress(u, r),
  };
  return { siasb, reader, clinica };
}

const uc = {} as McpUseCases;

async function connect(p: McpPrincipal, clinica?: McpClinica): Promise<Client> {
  const server = buildMcpServer(uc, p, undefined, clinica);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const texto = (res: unknown) => (res as { content: { text: string }[] }).content[0].text;
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

describe('visibilidade das ferramentas clinica_*', () => {
  it('sem conexão SIASB (siasb ausente ou falso) não há clinica_*', async () => {
    const { clinica } = setup();
    for (const p of [{ userId: 'u1' }, { userId: 'u1', siasb: false }]) {
      expect((await names(await connect(p, clinica))).filter((n) => n.startsWith('clinica_'))).toEqual([]);
    }
  });

  it('com a flag mas sem a dependência clinica, também não há clinica_*', async () => {
    expect((await names(await connect({ userId: 'u1', siasb: true }))).filter((n) => n.startsWith('clinica_'))).toEqual([]);
  });

  it('com conexão (connected ou reconnect_required) lista as sete', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    expect((await names(c)).filter((n) => n.startsWith('clinica_')).sort()).toEqual([...FERRAMENTAS_CLINICA].sort());
    expect(FERRAMENTAS_CLINICA).toEqual([
      'clinica_situacao',
      'clinica_sessoes',
      'clinica_prazo_marcacao',
      'clinica_pacientes',
      'clinica_vagas',
      'clinica_contexto_agendamento',
      'clinica_progresso',
    ]);
  });

  it('resolveSiasbFlag: connected e reconnect_required valem, disconnected não', async () => {
    const mk = (state: string) => ({ hasConnection: async () => state !== 'disconnected' }) as unknown as McpClinica;
    expect(await resolveSiasbFlag(mk('connected'), 'u1')).toBe(true);
    expect(await resolveSiasbFlag(mk('reconnect_required'), 'u1')).toBe(true);
    expect(await resolveSiasbFlag(mk('disconnected'), 'u1')).toBe(false);
  });

  it('resolveSiasbFlag: falha ao resolver vira false (o MCP segue funcionando); sem clinica, false', async () => {
    const quebrado = { hasConnection: async () => { throw new Error('banco fora'); } } as unknown as McpClinica;
    expect(await resolveSiasbFlag(quebrado, 'u1')).toBe(false);
    expect(await resolveSiasbFlag(undefined, 'u1')).toBe(false);
    const c = await connect({ userId: 'u1', siasb: await resolveSiasbFlag(quebrado, 'u1') }, quebrado);
    const ns = await names(c);
    expect(ns.some((n) => n.startsWith('clinica_'))).toBe(false);
  });
});

describe('clinica_situacao', () => {
  it('devolve por disciplina estado, proximaClinica, prazoEstimado, feriadosConsiderados, com o aviso', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_situacao', arguments: {} });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    const by = Object.fromEntries(out.disciplinas.map((x: { disciplinaId: string }) => [x.disciplinaId, x]));
    expect(by['1']).toMatchObject({ disciplina: 'Disc 1', estado: 'sem_paciente', proximaClinica: null, prazoEstimado: null, feriadosConsiderados: false });
    expect(by['2'].estado).toBe('sem_sessao');
    expect(by['3'].estado).toBe('sessao_marcada');
    expect(by['3'].proximaClinica).toBe('2026-11-27T10:00:00-03:00');
    expect(by['3'].prazoEstimado).toMatch(/^2026-11-\d\dT\d\d:\d\d:\d\d-03:00$/);
    expect(out.aviso).toBe('Feriados e recessos não considerados; confirme o prazo no SIASB.');
    expect(texto(res)).toContain('prazo estimado');
  });

  it('sem aviso quando os feriados foram considerados', async () => {
    const { clinica } = setup(new FakeCalendar({ known: true, dates: ['2026-11-20'] }));
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const out = JSON.parse(texto(await c.callTool({ name: 'clinica_situacao', arguments: {} })));
    expect(out.aviso).toBeUndefined();
    expect(out.disciplinas.every((x: { feriadosConsiderados: boolean }) => x.feriadosConsiderados)).toBe(true);
  });

  it('descrição diz estimado, ao vivo e sem gravar', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    for (const t of (await c.listTools()).tools.filter((x) => x.name.startsWith('clinica_'))) {
      expect(t.description).toMatch(/AO VIVO/);
      expect(t.description).toMatch(/não grava/);
    }
    const prazo = (await c.listTools()).tools.find((t) => t.name === 'clinica_situacao');
    expect(prazo?.description).toContain('prazo estimado');
  });

  it('ReconectarError vira isError com "reconectar: ..."', async () => {
    const { clinica } = setup();
    clinica.situation = async () => { throw new ReconectarError(); };
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_situacao', arguments: {} });
    expect(res.isError).toBe(true);
    expect(texto(res)).toBe('reconectar: Sua conexão com o SIASB expirou. Entre de novo no painel.');
  });

  it('SiasbReadError vira isError com "<code>: <mensagem>"', async () => {
    const { clinica } = setup();
    clinica.situation = async () => { throw new SiasbReadError('siasb_unavailable'); };
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_situacao', arguments: {} });
    expect(res.isError).toBe(true);
    expect(texto(res)).toBe('siasb_unavailable: O SIASB não respondeu agora. Tente de novo em instantes.');
  });

  it('erro de falha real do SIASB (401) passa pelo leitor e chega como reconectar', async () => {
    const { clinica, siasb } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_sessoes', arguments: {} });
    expect(res.isError).toBe(true);
    expect(texto(res)).toMatch(/^reconectar: /);
  });

  it('erro genérico usa a falha comum', async () => {
    const { clinica } = setup();
    clinica.situation = async () => { throw new Error('boom'); };
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_situacao', arguments: {} });
    expect(res.isError).toBe(true);
    expect(texto(res)).toBe('boom');
  });
});

describe('clinica_sessoes', () => {
  it('devolve os campos em pt-BR com horário da Bahia e reagendamento', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_sessoes', arguments: { de: '2026-11-27', ate: '2026-12-04' } });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    const s3 = out.sessoes.find((x: { inicio: string }) => x.inicio === '2026-11-27T10:00:00-03:00');
    expect(s3).toEqual({
      disciplina: 'Disc 3',
      inicio: '2026-11-27T10:00:00-03:00',
      fim: '2026-11-27T11:00:00-03:00',
      local: 'Clínica 2',
      professor: 'Profa Maria',
      iniciais: 'FB',
      situacao: 'Confirmado',
      reagendamentoPara: '2026-12-02T10:00:00-03:00',
    });
    const sem = out.sessoes.find((x: { reagendamentoPara: unknown }) => x.reagendamentoPara === null);
    expect(sem).toBeDefined();
  });

  it('data inválida vira erro de entrada em pt-BR, sem chamar o SIASB', async () => {
    const { clinica, siasb } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_sessoes', arguments: { de: 'amanhã' } });
    expect(res.isError).toBe(true);
    expect(texto(res)).toContain('Data inválida');
    expect(siasb.calls).toEqual([]);
  });
});

describe('sem dados de paciente na saída', () => {
  it('nome completo e prontuário não aparecem em situacao nem em sessoes', async () => {
    const { clinica, siasb } = setup();
    // Mesmo que a fonte trouxesse esses textos em algum campo, a saída só leva os campos listados.
    (siasb.sess[0] as unknown as Record<string, unknown>).patientName = PACIENTE;
    (siasb.sess[0] as unknown as Record<string, unknown>).record = PRONTUARIO;
    (siasb.atts[0] as unknown as Record<string, unknown>).patientName = PACIENTE;
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    for (const [name, args] of [
      ['clinica_situacao', {}],
      ['clinica_sessoes', { de: '2026-11-01', ate: '2026-12-10' }],
    ] as const) {
      const res = await c.callTool({ name, arguments: args });
      const all = JSON.stringify(res);
      expect(all).not.toContain(PACIENTE);
      expect(all).not.toContain('Beltrano');
      expect(all).not.toContain(PRONTUARIO);
    }
  });
});

describe('clinica_prazo_marcacao', () => {
  it('exige exatamente um de disciplinaId e inicioSessao', async () => {
    const { clinica, siasb } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const nenhum = await c.callTool({ name: 'clinica_prazo_marcacao', arguments: {} });
    const ambos = await c.callTool({
      name: 'clinica_prazo_marcacao',
      arguments: { disciplinaId: '3', inicioSessao: '2026-11-27T10:00:00-03:00' },
    });
    for (const r of [nenhum, ambos]) {
      expect(r.isError).toBe(true);
      expect(texto(r)).toContain('exatamente um');
    }
    expect(siasb.calls).toEqual([]);
  });

  it('inicioSessao inválido é erro de entrada', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_prazo_marcacao', arguments: { inicioSessao: 'xx' } });
    expect(res.isError).toBe(true);
    expect(texto(res)).toContain('Data inválida');
  });

  it('por inicioSessao: prazo estimado com offset da Bahia e aviso quando não há feriados', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const res = await c.callTool({ name: 'clinica_prazo_marcacao', arguments: { inicioSessao: '2026-11-27T13:00:00Z' } });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    expect(out.prazoEstimado).toMatch(/^2026-11-\d\dT\d\d:\d\d:\d\d-03:00$/);
    expect(out.feriadosConsiderados).toBe(false);
    expect(out.aviso).toBe('Feriados e recessos não considerados; confirme o prazo no SIASB.');
    expect(texto(res)).toContain('prazo estimado');
  });

  it('por disciplinaId: acha o próximo horário; sem horário dá siasb_no_slot', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    const ok = await c.callTool({ name: 'clinica_prazo_marcacao', arguments: { disciplinaId: '3' } });
    expect(ok.isError).toBeFalsy();
    const nada = await c.callTool({ name: 'clinica_prazo_marcacao', arguments: { disciplinaId: '1' } });
    expect(nada.isError).toBe(true);
    expect(texto(nada)).toMatch(/^siasb_no_slot: /);
  });
});

describe('toBahiaIso', () => {
  it('escreve em UTC-03:00', () => {
    expect(toBahiaIso(d('2026-11-25T13:00:00Z'))).toBe('2026-11-25T10:00:00-03:00');
    expect(toBahiaIso(d('2026-11-26T02:30:00Z'))).toBe('2026-11-25T23:30:00-03:00');
  });
});

describe('teto de chamadas ao SIASB por ferramenta', () => {
  it('situacao <= 3, sessoes <= 1, prazo_marcacao <= 1', async () => {
    const casos: [string, Record<string, unknown>, number][] = [
      ['clinica_situacao', {}, 3],
      ['clinica_sessoes', {}, 1],
      ['clinica_prazo_marcacao', { disciplinaId: '3' }, 1],
      ['clinica_prazo_marcacao', { inicioSessao: '2026-11-27T13:00:00Z' }, 1],
    ];
    for (const [name, args, teto] of casos) {
      const { clinica, siasb } = setup();
      const c = await connect({ userId: 'u1', siasb: true }, clinica);
      const res = await c.callTool({ name, arguments: args });
      expect(res.isError).toBeFalsy();
      expect(siasb.calls.length).toBeLessThanOrEqual(teto);
    }
  });
});

const user = { userId: 'u1', siasb: true };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
const SEM_PACIENTE = [PACIENTE, 'Beltrano', PRONTUARIO];

function comDadosDePaciente(siasb: FakeSiasb) {
  for (const a of [...siasb.atts, ...siasb.inactiveAtts]) {
    Object.assign(a, { patientName: PACIENTE, record: PRONTUARIO });
  }
  for (const s of siasb.sess) Object.assign(s, { patientName: PACIENTE, record: PRONTUARIO });
  Object.assign(siasb.unassigned, { patientName: PACIENTE });
}

describe('clinica_pacientes', () => {
  it('lista por disciplina só iniciais e tipo, sem nome nem prontuário', async () => {
    const { clinica, siasb } = setup();
    siasb.atts = [
      { id: 'a2', disciplineId: '2', initials: 'AB', treatmentType: 'TRIAGE', concluded: false },
      { id: 'a3', disciplineId: '3', initials: 'CD', treatmentType: 'PLANNING', concluded: false },
      { id: 'a4', disciplineId: '3', initials: 'EF', treatmentType: 'URGENCY', concluded: false },
      { id: 'a5', disciplineId: '3', initials: 'GH', treatmentType: 'UNKNOWN', concluded: false },
    ];
    comDadosDePaciente(siasb);
    const res = await call(await connect(user, clinica), 'clinica_pacientes');
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    expect(out.disciplinas).toEqual([
      { disciplinaId: '1', disciplina: 'Disc 1', pacientes: [] },
      { disciplinaId: '2', disciplina: 'Disc 2', pacientes: [{ atendimentoId: 'a2', iniciais: 'AB', tipo: 'triagem' }] },
      {
        disciplinaId: '3',
        disciplina: 'Disc 3',
        pacientes: [
          { atendimentoId: 'a3', iniciais: 'CD', tipo: 'planejamento' },
          { atendimentoId: 'a4', iniciais: 'EF', tipo: 'urgencia' },
          { atendimentoId: 'a5', iniciais: 'GH', tipo: 'desconhecido' },
        ],
      },
    ]);
    const all = JSON.stringify(res);
    for (const t of SEM_PACIENTE) expect(all).not.toContain(t);
  });

  it('401 vira reconectar', async () => {
    const { clinica, siasb } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const res = await call(await connect(user, clinica), 'clinica_pacientes');
    expect(res.isError).toBe(true);
    expect(texto(res)).toMatch(/^reconectar: /);
  });
});

describe('clinica_vagas', () => {
  it('devolve só números por disciplina, sem nome nem prontuário', async () => {
    const { clinica, siasb } = setup();
    siasb.unassigned = { '2': 4, '3': 0 };
    comDadosDePaciente(siasb);
    const res = await call(await connect(user, clinica), 'clinica_vagas');
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    expect(out.disciplinas).toEqual([
      { disciplinaId: '1', disciplina: 'Disc 1', vagas: 0 },
      { disciplinaId: '2', disciplina: 'Disc 2', vagas: 4 },
      { disciplinaId: '3', disciplina: 'Disc 3', vagas: 0 },
    ]);
    for (const row of out.disciplinas) expect(typeof row.vagas).toBe('number');
    const all = JSON.stringify(res);
    for (const t of SEM_PACIENTE) expect(all).not.toContain(t);
  });

  it('401 vira reconectar', async () => {
    const { clinica, siasb } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const res = await call(await connect(user, clinica), 'clinica_vagas');
    expect(texto(res)).toMatch(/^reconectar: /);
  });
});

describe('clinica_contexto_agendamento', () => {
  const catalogo = (n: number): { id: string; name: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: `Procedimento ${i + 1}` }));

  it('devolve duração, sessões do atendimento, procedimentos e próximos horários com prazo estimado', async () => {
    const { clinica, siasb } = setup();
    siasb.procs = [{ id: '10', name: '81000030 - Consulta Odontológica' }];
    comDadosDePaciente(siasb);
    const res = await call(await connect(user, clinica), 'clinica_contexto_agendamento', { atendimentoId: 'a3' });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    expect(out).toMatchObject({
      atendimentoId: 'a3',
      disciplina: 'Disc 3',
      duracaoSessaoMin: 60,
      sessoesDoAtendimento: 3,
      procedimentos: [{ id: '10', nome: '81000030 - Consulta Odontológica' }],
      totalProcedimentos: 1,
      maisProcedimentos: false,
      feriadosConsiderados: false,
      aviso: 'Feriados e recessos não considerados; confirme o prazo no SIASB.',
    });
    expect(out.proximosHorarios).toHaveLength(3);
    expect(out.proximosHorarios[0].inicio).toBe('2026-11-27T10:00:00-03:00');
    expect(out.proximosHorarios[0].prazoEstimado).toMatch(/^2026-11-\d\dT\d\d:\d\d:\d\d-03:00$/);
    expect(out.observacao).toMatch(/modelo/);
    expect(out.observacao).toMatch(/conhecimento geral/);
    expect(out.observacao).toMatch(/professor/);
    expect(out.observacao).toMatch(/nunca é enviado ao SIASB/);
    for (const t of SEM_PACIENTE) expect(JSON.stringify(res)).not.toContain(t);
  });

  it('pede os procedimentos com o attendanceId do atendimento', async () => {
    const { clinica, siasb } = setup();
    await call(await connect(user, clinica), 'clinica_contexto_agendamento', { atendimentoId: 'a3' });
    expect(siasb.procedureCalls).toHaveLength(1);
    expect(siasb.procedureCalls[0].attendanceId).toBe('a3');
  });

  it('atendimento que não é ativo da pessoa: erro em pt-BR, sem chamar procedures e sem ecoar o id', async () => {
    const { clinica, siasb } = setup();
    siasb.inactiveAtts = [{ id: 'i9', disciplineId: '3', initials: 'ZZ', treatmentType: 'PLANNING', concluded: true }];
    const c = await connect(user, clinica);
    for (const id of ['zzz-desconhecido', 'i9']) {
      const res = await call(c, 'clinica_contexto_agendamento', { atendimentoId: id });
      expect(res.isError).toBe(true);
      expect(texto(res)).toMatch(/^siasb_attendance_not_found: /);
      expect(texto(res)).not.toContain(id);
    }
    expect(siasb.procedureCalls).toEqual([]);
  });

  it('busca ignora acento e maiúsculas', async () => {
    const { clinica, siasb } = setup();
    siasb.procs = [
      { id: '1', name: '81000030 - Consulta Odontológica' },
      { id: '2', name: '82000050 - Raspagem' },
    ];
    const res = await call(await connect(user, clinica), 'clinica_contexto_agendamento', {
      atendimentoId: 'a3',
      busca: 'ODONTOLOGICA',
    });
    const out = JSON.parse(texto(res));
    expect(out.procedimentos).toEqual([{ id: '1', nome: '81000030 - Consulta Odontológica' }]);
    expect(out.totalProcedimentos).toBe(1);
    expect(out.maisProcedimentos).toBe(false);
  });

  it('sem busca devolve os 50 primeiros e avisa que há mais', async () => {
    const { clinica, siasb } = setup();
    siasb.procs = catalogo(60);
    const out = JSON.parse(
      texto(await call(await connect(user, clinica), 'clinica_contexto_agendamento', { atendimentoId: 'a3' })),
    );
    expect(out.procedimentos).toHaveLength(50);
    expect(out.procedimentos[0].id).toBe('1');
    expect(out.totalProcedimentos).toBe(60);
    expect(out.maisProcedimentos).toBe(true);
  });

  it('sem sessões de clínica conhecidas: duração null e nenhum horário', async () => {
    const { clinica, siasb } = setup();
    siasb.sess = [];
    const out = JSON.parse(
      texto(await call(await connect(user, clinica), 'clinica_contexto_agendamento', { atendimentoId: 'a2' })),
    );
    expect(out.duracaoSessaoMin).toBeNull();
    expect(out.proximosHorarios).toEqual([]);
    expect(out.sessoesDoAtendimento).toBe(0);
  });

  it('não há campo de entrada para o procedimento do aluno; a descrição diz que a estimativa é do modelo', async () => {
    const { clinica } = setup();
    const c = await connect(user, clinica);
    const tool = (await c.listTools()).tools.find((t) => t.name === 'clinica_contexto_agendamento');
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['atendimentoId', 'busca']);
    expect(tool?.description).toMatch(/modelo/);
    expect(tool?.description).toMatch(/professor/);
    expect(tool?.description).toContain('prazo estimado');
  });

  it('401 vira reconectar', async () => {
    const { clinica, siasb } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const res = await call(await connect(user, clinica), 'clinica_contexto_agendamento', { atendimentoId: 'a3' });
    expect(texto(res)).toMatch(/^reconectar: /);
  });
});

describe('clinica_progresso', () => {
  // Período 02/11 a 29/11 (28 dias = 4 semanas: 02-08, 09-15, 16-22, 23-29); agora é 23/11.
  const ARGS = { desde: '2026-11-02', ate: '2026-11-29' };

  function fixture(siasb: FakeSiasb) {
    siasb.atts = [{ id: 'a3', disciplineId: '3', initials: 'CD', treatmentType: 'PLANNING', concluded: false }];
    siasb.inactiveAtts = [
      { id: 'i1', disciplineId: '3', initials: 'IA', treatmentType: 'PLANNING', concluded: true },
      { id: 'i2', disciplineId: '3', initials: 'IB', treatmentType: 'PLANNING', concluded: true },
    ];
    siasb.sess = [
      sess('o1', '3', 'a3', '2026-10-20T13:00:00Z', 'Atendido'), // fora do período
      sess('p1', '3', 'a3', '2026-11-04T13:00:00Z', 'Atendido'),
      sess('p2', '3', 'a3', '2026-11-05T13:00:00Z', 'Atendido'),
      sess('p3', '3', 'a3', '2026-11-11T13:00:00Z', 'Cancelado'),
      sess('p4', '3', 'i1', '2026-11-12T13:00:00Z', 'Cancelado'),
      sess('p5', '3', 'a3', '2026-11-25T13:00:00Z', 'Confirmado'),
    ];
  }

  it('período explícito: contagens por disciplina, concluídos no período vs. histórico, ritmo à mão', async () => {
    const { clinica, siasb } = setup();
    fixture(siasb);
    comDadosDePaciente(siasb);
    const res = await call(await connect(user, clinica), 'clinica_progresso', ARGS);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(texto(res));
    expect(out.periodo).toEqual({ de: '2026-11-02T00:00:00-03:00', ate: '2026-11-29T23:59:59-03:00', ePadrao: false });
    expect(out.periodoTexto).toBe('Período: 02/11 a 29/11/2026');
    const d3 = out.disciplinas.find((x: { disciplinaId: string }) => x.disciplinaId === '3');
    expect(d3).toEqual({
      disciplinaId: '3',
      disciplina: 'Disc 3',
      atendimentosAtivos: 1,
      concluidosNoPeriodo: 1, // i1 teve sessão no período; i2 só entra no histórico
      concluidosNoHistorico: 2,
      sessoesAtendidas: 2, // só 'Atendido' dentro do período (o de 20/10 e o cancelado não contam)
      sessoesMarcadasAdiante: 1, // p5, depois de agora (23/11)
    });
    // (2 atendidas + 1 marcada) / 4 semanas = 0,75; a semana 16-22 ficou sem sessão alguma.
    expect(out.ritmo.sessoesPorSemana).toBe(0.75);
    expect(out.ritmo.semanasSemSessao).toBe(1);
    expect(Array.isArray(out.ritmo.horariosHabituais)).toBe(true);
    expect(out.avisos).toEqual([]);
    expect(out.observacao).toBeUndefined();
    const all = JSON.stringify(res);
    for (const t of SEM_PACIENTE) expect(all).not.toContain(t);
    expect(all).not.toContain('"IA"');
  });

  it('um concluído sem sessão no período entra só no total do histórico', async () => {
    const { clinica, siasb } = setup();
    fixture(siasb);
    siasb.sess = siasb.sess.filter((s) => s.attendanceId !== 'i1');
    const out = JSON.parse(texto(await call(await connect(user, clinica), 'clinica_progresso', ARGS)));
    const d3 = out.disciplinas.find((x: { disciplinaId: string }) => x.disciplinaId === '3');
    expect(d3.concluidosNoPeriodo).toBe(0);
    expect(d3.concluidosNoHistorico).toBe(2);
  });

  it('sem datas: últimos 120 dias, ePadrao true, período no texto e orientação para passar o semestre', async () => {
    const { clinica, siasb } = setup();
    fixture(siasb);
    const out = JSON.parse(texto(await call(await connect(user, clinica), 'clinica_progresso')));
    expect(out.periodo.ePadrao).toBe(true);
    expect(out.periodo.ate).toBe('2026-11-23T09:00:00-03:00');
    expect(out.periodo.de).toBe('2026-07-26T09:00:00-03:00');
    expect(out.periodoTexto).toBe('Período: 26/07 a 23/11/2026');
    expect(out.observacao).toMatch(/120 dias/);
    expect(out.observacao).toMatch(/aproximad/);
    expect(out.observacao).toMatch(/semestre/);
  });

  it('período maior que 59 dias avisa que o SIASB pode devolver só parte', async () => {
    const { clinica, siasb } = setup();
    fixture(siasb);
    const out = JSON.parse(texto(await call(await connect(user, clinica), 'clinica_progresso')));
    expect(out.avisos).toContain('O SIASB pode devolver só parte do período pedido; confira os números.');
  });

  it('só uma das datas, invertidas, inválida ou acima de 190 dias: erro em pt-BR sem ecoar o valor e sem chamar o SIASB', async () => {
    const casos: Record<string, unknown>[] = [
      { desde: '2026-11-02' },
      { ate: '2026-11-29' },
      { desde: '2026-11-29', ate: '2026-11-02' },
      { desde: 'segredo-xyz', ate: '2026-11-29' },
      { desde: '2026-01-01', ate: '2026-11-29' },
    ];
    for (const args of casos) {
      const { clinica, siasb } = setup();
      const res = await call(await connect(user, clinica), 'clinica_progresso', args);
      expect(res.isError).toBe(true);
      expect(texto(res).length).toBeGreaterThan(10);
      for (const v of Object.values(args)) expect(texto(res)).not.toContain(String(v));
      expect(siasb.calls).toEqual([]);
    }
    const um = await call(await connect(user, setup().clinica), 'clinica_progresso', { desde: '2026-11-02' });
    expect(texto(um)).toMatch(/ambos|juntos/);
    const longo = await call(await connect(user, setup().clinica), 'clinica_progresso', { desde: '2026-01-01', ate: '2026-11-29' });
    expect(texto(longo)).toContain('190');
  });

  it('401 vira reconectar', async () => {
    const { clinica, siasb } = setup();
    siasb.failure = new SiasbError('REAUTH_NEEDED');
    const res = await call(await connect(user, clinica), 'clinica_progresso', ARGS);
    expect(texto(res)).toMatch(/^reconectar: /);
  });

  it('a descrição manda passar as datas do semestre e diz que 120 dias é aproximado', async () => {
    const { clinica } = setup();
    const c = await connect(user, clinica);
    const tool = (await c.listTools()).tools.find((t) => t.name === 'clinica_progresso');
    expect(tool?.description).toMatch(/semestre/);
    expect(tool?.description).toMatch(/120 dias/);
    expect(tool?.description).toMatch(/aproximad/);
  });
});

describe('teto de chamadas das outras quatro ferramentas', () => {
  it('pacientes <= 2, vagas <= 2, contexto <= 3, progresso <= 4', async () => {
    const casos: [string, Record<string, unknown>, number][] = [
      ['clinica_pacientes', {}, 2],
      ['clinica_vagas', {}, 2],
      ['clinica_contexto_agendamento', { atendimentoId: 'a3' }, 3],
      ['clinica_progresso', {}, 4],
      ['clinica_progresso', { desde: '2026-11-02', ate: '2026-11-29' }, 4],
    ];
    for (const [name, args, teto] of casos) {
      const { clinica, siasb } = setup();
      const res = await call(await connect(user, clinica), name, args);
      expect(res.isError).toBeFalsy();
      expect(siasb.calls.length).toBeLessThanOrEqual(teto);
    }
  });
});

