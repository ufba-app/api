import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SiasbError } from '../../../application/ports/siasb-source';
import {
  countUnassigned,
  firstNameOf,
  mapAttendances,
  mapDisciplines,
  mapProcedures,
  mapSchedulingOptions,
  mapSessions,
} from './siasb-mapper';

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', `${name}.json`), 'utf8')) as unknown;

const unexpected = { code: 'UNEXPECTED_FORMAT' };

describe('firstNameOf', () => {
  it('devolve só o primeiro nome, com maiúscula inicial', () => {
    expect(firstNameOf('MARIA DA SILVA')).toBe('Maria');
    expect(firstNameOf('  joão   pedro ')).toBe('João');
    expect(firstNameOf('ÂNGELA')).toBe('Ângela');
    expect(firstNameOf(null)).toBe('');
    expect(firstNameOf(undefined)).toBe('');
    expect(firstNameOf('   ')).toBe('');
  });
});

describe('mapSessions', () => {
  it('descarta sessões reservadas por outro aluno (nem o primeiro nome sai)', () => {
    const out = mapSessions(fx('sessions'));
    expect(out.map((s) => s.id)).toEqual(['9001', '9002']);
    expect(JSON.stringify(out)).not.toContain('Hortência');
  });

  it('não deixa nome, prontuário nem id de paciente escapar', () => {
    const out = mapSessions(fx('sessions'));
    const text = JSON.stringify(out);
    for (const secret of [
      'Quintanilha',
      'Prado',
      'Albuquerque',
      'Neves',
      'PR-998877',
      'PR-112233',
      '7771',
      '7772',
      'patientName',
      'patientRecord',
      'patientId',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(out[0].firstName).toBe('Zenaide');
    expect(out[1].firstName).toBe('Otávio');
  });

  it('lê os horários como hora da Bahia (UTC-3)', () => {
    const out = mapSessions(fx('sessions'));
    expect(out[0].startAt).toBeInstanceOf(Date);
    expect(out[0].startAt.toISOString()).toBe('2026-11-27T11:00:00.000Z');
    expect(out[0].endAt.toISOString()).toBe('2026-11-27T14:30:00.000Z');
    expect(out[0].rescheduledStartAt).toBeNull();
    expect(out[1].startAt.toISOString()).toBe('2026-11-30T16:00:00.000Z');
    expect(out[1].rescheduledStartAt?.toISOString()).toBe('2026-12-02T16:00:00.000Z');
  });

  it('copia só os campos da lista de permissão, com ids como texto', () => {
    const [s] = mapSessions(fx('sessions'));
    expect(Object.keys(s).sort()).toEqual(
      [
        'attendanceId',
        'disciplineId',
        'disciplineName',
        'endAt',
        'id',
        'firstName',
        'locationName',
        'professorName',
        'rescheduledStartAt',
        'startAt',
        'statusLabel',
      ].sort(),
    );
    expect(s).toMatchObject({
      id: '9001',
      attendanceId: '501',
      disciplineId: '11',
      disciplineName: 'Clínica Integrada I',
      professorName: 'Prof. Aurélio Tavares',
      locationName: 'Sala 3A',
      statusLabel: 'Confirmado',
    });
  });

  it('formato inesperado lança UNEXPECTED_FORMAT', () => {
    expect(() => mapSessions({})).toThrow(SiasbError);
    expect(() => mapSessions({})).toThrow(expect.objectContaining(unexpected));
    expect(() => mapSessions([{ id: 1 }])).toThrow(expect.objectContaining(unexpected));
    expect(() => mapSessions([{ ...(fx('sessions') as object[])[0], startAt: 'lixo' }])).toThrow(
      expect.objectContaining(unexpected),
    );
    expect(() => mapSessions([{ ...(fx('sessions') as object[])[0], patientName: 5 }])).toThrow(
      expect.objectContaining(unexpected),
    );
  });
});

describe('paciente sem nome', () => {
  const base = (name: string) => (fx(name) as Array<Record<string, unknown>>)[0];
  const variants = (name: string) => {
    const nulled = { ...base(name), patientName: null };
    const missing = { ...base(name) } as Record<string, unknown>;
    delete missing.patientName;
    return [nulled, missing];
  };

  it('sessão com patientName nulo ou ausente mapeia, com primeiro nome vazio', () => {
    for (const raw of variants('sessions')) {
      const out = mapSessions([raw, (fx('sessions') as unknown[])[1]]);
      expect(out).toHaveLength(2);
      expect(out[0].firstName).toBe('');
      expect(out[0]).toMatchObject({ id: '9001', attendanceId: '501', disciplineName: 'Clínica Integrada I' });
      expect(out[0].startAt.toISOString()).toBe('2026-11-27T11:00:00.000Z');
      expect(JSON.stringify(out)).not.toContain('Zenaide');
      expect(JSON.stringify(out)).not.toContain('Quintanilha');
    }
  });

  it('atendimento com patientName nulo ou ausente mapeia, com primeiro nome vazio', () => {
    for (const raw of variants('attendances')) {
      const out = mapAttendances([raw]);
      expect(out).toEqual([
        { id: '501', disciplineId: '11', firstName: '', treatmentType: 'PLANNING', concluded: false },
      ]);
      expect(JSON.stringify(out)).not.toContain('Zenaide');
    }
  });
});

describe('mapAttendances', () => {
  it('mapeia tipo, concluído e primeiro nome, sem dados do paciente', () => {
    const out = mapAttendances(fx('attendances'));
    expect(out.map((a) => a.treatmentType)).toEqual(['PLANNING', 'URGENCY', 'TRIAGE', 'UNKNOWN']);
    expect(out.map((a) => a.concluded)).toEqual([false, true, false, false]);
    expect(out[0]).toEqual({
      id: '501',
      disciplineId: '11',
      firstName: 'Zenaide',
      treatmentType: 'PLANNING',
      concluded: false,
    });
    const text = JSON.stringify(out);
    for (const secret of ['Quintanilha', 'Mota', 'Albuquerque', 'PR-', 'patientName', 'patientRecord', 'responsible', 'Aluno Inventado']) {
      expect(text).not.toContain(secret);
    }
  });

  it('formato inesperado', () => {
    expect(() => mapAttendances({})).toThrow(expect.objectContaining(unexpected));
    expect(() => mapAttendances([{ id: 1, patientName: 'X' }])).toThrow(
      expect.objectContaining(unexpected),
    );
  });
});

describe('mapDisciplines', () => {
  it('mapeia id e nome', () => {
    expect(mapDisciplines(fx('disciplines'))).toEqual([
      { id: '11', name: 'Clínica Integrada I' },
      { id: '12', name: 'Clínica Integrada II' },
    ]);
  });
  it('formato inesperado', () => {
    expect(() => mapDisciplines(null)).toThrow(expect.objectContaining(unexpected));
    expect(() => mapDisciplines([{ disciplineId: 1 }])).toThrow(expect.objectContaining(unexpected));
  });
});

describe('mapProcedures', () => {
  it('mapeia id e nome', () => {
    expect(mapProcedures(fx('procedures'))).toEqual([
      { id: '1', name: '81000030 - Consulta Odontológica' },
      { id: '2', name: '82000050 - Raspagem Supragengival' },
    ]);
  });
  it('formato inesperado', () => {
    expect(() => mapProcedures('x')).toThrow(expect.objectContaining(unexpected));
  });
});

describe('mapSchedulingOptions', () => {
  it('mapeia id, nome e preferido; ignora o resto', () => {
    expect(mapSchedulingOptions(fx('scheduling-options'))).toEqual([
      { id: '301', name: 'Profa. Exemplar Alfa', preferred: true },
      { id: '302', name: 'Prof. Exemplar Beta', preferred: false },
    ]);
  });
  it('preferred ausente vira false', () => {
    expect(mapSchedulingOptions([{ id: 1, name: 'X' }])).toEqual([{ id: '1', name: 'X', preferred: false }]);
  });
  it('formato inesperado', () => {
    expect(() => mapSchedulingOptions({})).toThrow(expect.objectContaining(unexpected));
    expect(() => mapSchedulingOptions([{ id: 1 }])).toThrow(expect.objectContaining(unexpected));
  });
});

describe('countUnassigned', () => {
  it('conta por disciplina e não carrega dado de paciente', () => {
    const out = countUnassigned(fx('unassigned'));
    expect(out).toEqual({ '11': 2, '12': 1 });
    const text = JSON.stringify(out);
    for (const secret of ['Gumercindo', 'Iracema', 'PR-000', 'patientName', 'medicalRecordCode']) {
      expect(text).not.toContain(secret);
    }
  });
  it('lista vazia e formato inesperado', () => {
    expect(countUnassigned([])).toEqual({});
    expect(() => countUnassigned({})).toThrow(expect.objectContaining(unexpected));
    expect(() => countUnassigned([{ attendanceId: 1 }])).toThrow(expect.objectContaining(unexpected));
  });
});
