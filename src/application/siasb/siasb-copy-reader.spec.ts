import { InMemorySiasbCopy } from '../../../test/support/siasb-copy-fake';
import type { SecretCipher } from '../ports/secret-cipher';
import type { SyncedAttendance, SyncedSession } from '../ports/siasb-copy';
import { AcademicCalendar } from '../ports/academic-calendar';
import { STALE_AFTER_MS, SiasbCopyReader } from './siasb-copy-reader';

/** Cifra falsa e reversível (sem AES, para respeitar a regra de camadas). */
class FakeCipher implements SecretCipher {
  encrypt(plain: string, aad = '') {
    return { ciphertext: Buffer.from(JSON.stringify([plain, aad])).toString('base64'), iv: 'iv', authTag: 'tag' };
  }
  decrypt(secret: { ciphertext: string }, aad = '') {
    const [plain, used] = JSON.parse(Buffer.from(secret.ciphertext, 'base64').toString());
    if (used !== aad) throw new Error('aad');
    return plain as string;
  }
}

class FakeCalendar extends AcademicCalendar {
  calls: { from: Date; to: Date }[] = [];
  constructor(private readonly result = { known: false, dates: [] as string[] }) {
    super();
  }
  async holidays(from: Date, to: Date) {
    this.calls.push({ from, to });
    return this.result;
  }
}

const NOW = new Date('2026-11-15T12:00:00Z');
const cipher = new FakeCipher();
const NOME = 'Zeferina';

const attendance = (userId: string, id: string, firstName = NOME): SyncedAttendance => ({
  id,
  disciplineId: 'd1',
  disciplineName: 'Clinica 1',
  treatmentType: 'PLANNING',
  concluded: false,
  active: true,
  firstName: cipher.encrypt(firstName, `siasb-attendance:${userId}:${id}`),
});

const session = (id: string, attendanceId: string, startAt: string): SyncedSession => ({
  id,
  attendanceId,
  disciplineId: 'd1',
  disciplineName: 'Clinica 1',
  professorName: 'Profa. Teste',
  locationName: 'Sala 1',
  startAt: new Date(startAt),
  endAt: new Date(new Date(startAt).getTime() + 3_600_000),
  rescheduledStartAt: null,
  statusLabel: 'Agendada',
});

async function setup(now = NOW) {
  const copy = new InMemorySiasbCopy();
  copy.accounts.set('u1', 'OK');
  copy.accounts.set('u2', 'OK');
  await copy.replaceWindow(
    'u1',
    { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-31T00:00:00Z') },
    {
      disciplines: [],
      attendances: [attendance('u1', 'a1')],
      sessions: [
        session('s2', 'a1', '2026-11-20T14:00:00Z'),
        session('s1', 'a1', '2026-11-16T14:00:00Z'),
        session('s3', 'a1', '2026-12-20T14:00:00Z'),
        session('s4', 'sumiu', '2026-11-17T14:00:00Z'),
      ],
    },
  );
  copy.seedState('u1');
  await copy.recordAttempt('u1', { result: 'OK', at: new Date(now.getTime() - 60_000), nextRunAt: null });
  return { copy, reader: new SiasbCopyReader(copy, cipher, new FakeCalendar(), () => now) };
}

const FROM = new Date('2026-11-10T00:00:00Z');
const TO = new Date('2026-11-30T00:00:00Z');

describe('SiasbCopyReader.calendar', () => {
  it('itens ordenados e filtrados pelo intervalo, com o primeiro nome decifrado', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.items.map((i) => i.id)).toEqual(['s1', 's4', 's2']);
    expect(r.items[0].patientFirstName).toBe(NOME);
    expect(r.items[0].attendanceId).toBe('a1');
    expect(r.items[0].rescheduledStartAt).toBeNull();
  });

  it('atendimento da sessão sumiu: nome vazio, sem lançar', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.items.find((i) => i.id === 's4')!.patientFirstName).toBe('');
  });

  it('só o dono: outro userId não vê o item nem o nome', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u2', FROM, TO);
    expect(r.items).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(NOME);
  });

  it('decifra falha: nome vazio e não lança', async () => {
    const { copy } = await setup();
    const broken = new SiasbCopyReader(
      copy,
      {
        encrypt: cipher.encrypt.bind(cipher),
        decrypt: () => {
          throw new Error(`falha com ${NOME}`);
        },
      },
      new FakeCalendar(),
      () => NOW,
    );
    const r = await broken.calendar('u1', FROM, TO);
    expect(r.items).toHaveLength(3);
    expect(r.items.every((i) => i.patientFirstName === '')).toBe(true);
  });

  it('syncedAt e stale falso quando o último resultado é OK e recente', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.syncedAt).toEqual(new Date(NOW.getTime() - 60_000));
    expect(r.stale).toBe(false);
  });

  it('stale: sem estado', async () => {
    const { reader } = await setup();
    const r = await reader.calendar('u2', FROM, TO);
    expect(r.syncedAt).toBeNull();
    expect(r.stale).toBe(true);
  });

  it('stale: último resultado diferente de OK', async () => {
    const { copy, reader } = await setup();
    copy.seedState('u1');
    await copy.recordAttempt('u1', { result: 'UNAVAILABLE', at: new Date(NOW.getTime() - 1000), nextRunAt: null });
    const r = await reader.calendar('u1', FROM, TO);
    expect(r.stale).toBe(true);
    expect(r.syncedAt).toEqual(new Date(NOW.getTime() - 60_000));
  });

  it('stale: último sucesso mais velho que 3 h', async () => {
    const { copy } = await setup();
    const later = new SiasbCopyReader(copy, cipher, new FakeCalendar(), () => new Date(NOW.getTime() + STALE_AFTER_MS));
    expect((await later.calendar('u1', FROM, TO)).stale).toBe(true);
  });
});

describe('SiasbCopyReader.situation', () => {
  const DAY = 86_400_000;
  const iso = (days: number, hour = 13) => {
    const t = new Date(NOW.getTime() + days * DAY);
    t.setUTCHours(hour, 0, 0, 0);
    return t.toISOString();
  };
  const att = (id: string, disciplineId: string, concluded = false): SyncedAttendance => ({
    ...attendance('u1', id),
    disciplineId,
    concluded,
    active: !concluded,
  });
  const sess = (id: string, attendanceId: string, disciplineId: string, startAt: string, statusLabel: string) => ({
    ...session(id, attendanceId, startAt),
    disciplineId,
    statusLabel,
  });

  async function build(
    data: { disciplines?: { id: string; name: string }[]; attendances?: SyncedAttendance[]; sessions?: SyncedSession[] },
    calendar: AcademicCalendar = new FakeCalendar(),
    withState = true,
  ) {
    const copy = new InMemorySiasbCopy();
    copy.accounts.set('u1', 'OK');
    await copy.replaceWindow(
      'u1',
      { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2027-12-31T00:00:00Z') },
      { disciplines: data.disciplines ?? [], attendances: data.attendances ?? [], sessions: data.sessions ?? [] },
    );
    if (withState) {
      copy.seedState('u1');
      await copy.recordAttempt('u1', { result: 'OK', at: new Date(NOW.getTime() - 60_000), nextRunAt: null });
    }
    return { copy, calendar, reader: new SiasbCopyReader(copy, cipher, calendar, () => NOW) };
  }

  const DISCS = [
    { id: 'd1', name: 'Clinica 1' },
    { id: 'd2', name: 'Clinica 2' },
    { id: 'd3', name: 'Clinica 3' },
    { id: 'd4', name: 'Clinica 4' },
  ];

  it('NO_PATIENT, NO_SESSION e SCHEDULED; atendimento concluído não conta como ativo', async () => {
    const { reader } = await build({
      disciplines: DISCS,
      attendances: [att('a2', 'd2'), att('a3', 'd3'), att('a4', 'd4', true)],
      sessions: [
        sess('s3p', 'a3', 'd3', iso(-7), 'Atendido'),
        sess('s3p2', 'a3', 'd3', iso(-14), 'Atendido'),
        sess('s3', 'a3', 'd3', iso(7), 'Confirmado'),
        sess('s4', 'a4', 'd4', iso(7), 'Confirmado'),
      ],
    });
    const r = await reader.situation('u1', NOW);
    expect(r.stale).toBe(false);
    expect(r.syncedAt).toEqual(new Date(NOW.getTime() - 60_000));
    const by = Object.fromEntries(r.items.map((x) => [x.disciplineId, x]));
    expect(by.d1.state).toBe('NO_PATIENT');
    expect(by.d2.state).toBe('NO_SESSION');
    expect(by.d3.state).toBe('SCHEDULED');
    expect(by.d4.state).toBe('NO_PATIENT');
    expect(by.d3.nextSlot).toBeInstanceOf(Date);
    expect(by.d3.deadline).toBeInstanceOf(Date);
    expect(by.d1.nextSlot).toBeNull();
  });

  it('ignora sessões fora de [agora - 60 d, agora + 45 d]', async () => {
    const { reader } = await build({
      disciplines: [DISCS[1], DISCS[2]],
      attendances: [att('a2', 'd2'), att('a3', 'd3')],
      sessions: [sess('s2', 'a2', 'd2', iso(50), 'Confirmado'), sess('s3', 'a3', 'd3', iso(-70), 'Atendido')],
    });
    const by = Object.fromEntries((await reader.situation('u1', NOW)).items.map((x) => [x.disciplineId, x]));
    expect(by.d2).toMatchObject({ state: 'NO_SESSION', nextSlot: null });
    expect(by.d3).toMatchObject({ state: 'NO_SESSION', nextSlot: null });
  });

  it('borda da janela: sessão a -59 d entra e a -61 d sai', async () => {
    const { reader } = await build({
      disciplines: [DISCS[1], DISCS[2]],
      attendances: [att('a2', 'd2'), att('a3', 'd3')],
      sessions: [
        sess('s2a', 'a2', 'd2', iso(-59), 'Atendido'),
        sess('s2b', 'a2', 'd2', iso(-52), 'Atendido'),
        sess('s3a', 'a3', 'd3', iso(-61), 'Atendido'),
        sess('s3b', 'a3', 'd3', iso(-54), 'Atendido'),
      ],
    });
    const by = Object.fromEntries((await reader.situation('u1', NOW)).items.map((x) => [x.disciplineId, x]));
    expect(by.d2.nextSlot).toBeInstanceOf(Date);
    expect(by.d3.nextSlot).toBeNull();
  });

  it('atendimento inativo com concluded=false não conta como ativo (usa a origem, não concluded)', async () => {
    const { reader } = await build({
      disciplines: [DISCS[0], DISCS[1], DISCS[2]],
      attendances: [
        { ...att('a1', 'd1'), active: false, concluded: false },
        { ...att('a2', 'd2'), active: true, concluded: false },
        { ...att('a3', 'd3'), active: true, concluded: false },
      ],
      sessions: [sess('s3', 'a3', 'd3', iso(7), 'Confirmado')],
    });
    const by = Object.fromEntries((await reader.situation('u1', NOW)).items.map((x) => [x.disciplineId, x.state]));
    expect(by).toEqual({ d1: 'NO_PATIENT', d2: 'NO_SESSION', d3: 'SCHEDULED' });
  });

  it('consulta feriados na mesma janela do leitor ao vivo e holidaysConsidered segue o known', async () => {
    const known = new FakeCalendar({ known: true, dates: [] });
    const a = await build({ disciplines: [DISCS[0]] }, known);
    const [item] = (await a.reader.situation('u1', NOW)).items;
    expect(item.holidaysConsidered).toBe(true);
    expect(known.calls[0]).toEqual({ from: NOW, to: new Date(NOW.getTime() + 45 * DAY) });
    expect(known.calls[1]).toEqual({ from: new Date(NOW.getTime() - 14 * DAY), to: new Date(NOW.getTime() + 45 * DAY) });
    expect(known.calls).toHaveLength(2);
    const b = await build({ disciplines: [DISCS[0]] });
    expect((await b.reader.situation('u1', NOW)).items[0].holidaysConsidered).toBe(false);
  });

  it('cópia vazia e sem sincronização: syncedAt null, stale, nenhum item', async () => {
    const { reader } = await build({}, new FakeCalendar(), false);
    expect(await reader.situation('u1', NOW)).toEqual({ syncedAt: null, stale: true, items: [], previous: {} });
  });

  it('disciplinas sem sincronização continuam NO_PATIENT e stale', async () => {
    const { reader } = await build({ disciplines: [DISCS[0]] }, new FakeCalendar(), false);
    const r = await reader.situation('u1', NOW);
    expect(r.stale).toBe(true);
    expect(r.syncedAt).toBeNull();
    expect(r.items.map((i) => i.state)).toEqual(['NO_PATIENT']);
  });

  it('previous: último horário com prazo vencido por disciplina, com covered pela sessão do dia', async () => {
    const weekly = [sess('w1', 'a1', 'd1', iso(-14), 'Atendido'), sess('w2', 'a1', 'd1', iso(-7), 'Atendido')];
    const a = await build({ disciplines: [DISCS[0], DISCS[1]], attendances: [att('a1', 'd1')], sessions: weekly });
    const r = await a.reader.situation('u1', NOW);
    expect(r.previous.d1).toMatchObject({ slot: new Date(iso(0)), covered: false });
    expect(r.previous.d1!.deadline.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(r.previous.d2).toBeNull();
    // a falta do paciente no dia do horário conta como marcada
    const b = await build({ disciplines: [DISCS[0]], attendances: [att('a1', 'd1')], sessions: [...weekly, sess('w3', 'a1', 'd1', iso(-1, 14), 'Falta paciente')] });
    expect((await b.reader.situation('u1', NOW)).previous.d1!.covered).toBe(true);
    // e os itens continuam os mesmos
    expect((await b.reader.situation('u1', NOW)).items[0].disciplineId).toBe('d1');
  });

  it('previous usa o PRÓPRIO calendário (agora − 14 d, agora + 45 d): feriado entre o prazo e agora mantém o prazo avisado', async () => {
    class Seq extends AcademicCalendar {
      calls: { from: Date; to: Date }[] = [];
      constructor(private readonly results: ({ known: boolean; dates: string[] } | Error)[]) {
        super();
      }
      async holidays(from: Date, to: Date) {
        this.calls.push({ from, to });
        const r = this.results[this.calls.length - 1];
        if (r instanceof Error) throw r;
        return r;
      }
    }
    const weekly = [sess('w1', 'a1', 'd1', iso(-14), 'Atendido'), sess('w2', 'a1', 'd1', iso(-7), 'Atendido')];
    const data = { disciplines: [DISCS[0]], attendances: [att('a1', 'd1')], sessions: weekly };
    // quinta 12/11 é feriado (só a segunda chamada devolve): o prazo do horário de hoje cai na terça, não na quarta
    const cal = new Seq([{ known: false, dates: [] }, { known: false, dates: ['2026-11-12'] }]);
    const a = await build(data, cal);
    const r = await a.reader.situation('u1', NOW);
    expect(r.previous.d1!.deadline).toEqual(new Date(iso(-5)));
    expect(cal.calls[0]).toEqual({ from: NOW, to: new Date(NOW.getTime() + 45 * DAY) });
    expect(cal.calls[1]).toEqual({ from: new Date(NOW.getTime() - 14 * DAY), to: new Date(NOW.getTime() + 45 * DAY) });
    expect(r.items[0].holidaysConsidered).toBe(false);
    // o calendário falha na segunda chamada: não falha a leitura, usa nenhum feriado
    const b = await build(data, new Seq([{ known: false, dates: [] }, new Error('falhou')]));
    expect((await b.reader.situation('u1', NOW)).previous.d1!.deadline).toEqual(new Date(iso(-4)));
  });

  it('só enxerga a cópia da própria pessoa', async () => {
    const { reader } = await build({ disciplines: [DISCS[0]] });
    expect((await reader.situation('u2', NOW)).items).toEqual([]);
  });
});
