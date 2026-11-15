import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClinicalAttendance, ClinicalDiscipline, ClinicalSession } from '../../domain/siasb/types';
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
import { FERRAMENTAS_CLINICA, registerClinicaTools, resolveSiasbFlag, toBahiaIso } from './clinica-tools';
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
  async attendances() {
    this.touch('attendances');
    return this.atts;
  }
  async sessions() {
    this.touch('sessions');
    return this.sess;
  }
  async procedures() {
    return [];
  }
  async unassignedCount() {
    return {};
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

  it('com conexão (connected ou reconnect_required) lista as três', async () => {
    const { clinica } = setup();
    const c = await connect({ userId: 'u1', siasb: true }, clinica);
    expect((await names(c)).filter((n) => n.startsWith('clinica_')).sort()).toEqual([...FERRAMENTAS_CLINICA].sort());
    expect(FERRAMENTAS_CLINICA).toEqual(['clinica_situacao', 'clinica_sessoes', 'clinica_prazo_marcacao']);
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

describe('registerClinicaTools', () => {
  it('é exportada', () => {
    expect(typeof registerClinicaTools).toBe('function');
  });
});
