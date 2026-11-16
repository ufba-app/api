import { z } from 'zod';
import { SiasbError, type SchedulingOption } from '../../../application/ports/siasb-source';
import { parseSiasbDateTime } from '../../../domain/siasb/time';
import type {
  ClinicalAttendance,
  ClinicalDiscipline,
  ClinicalSession,
  Procedure,
} from '../../../domain/siasb/types';

/**
 * Mapeadores com lista de permissão (spec 5.1): cada um lê campo a campo, valida o tipo e ignora o resto.
 * Nome, prontuário e id de paciente nunca saem daqui; o paciente vira só `firstName`. Qualquer desvio de formato
 * lança `UNEXPECTED_FORMAT` com mensagem fixa (nunca ecoa o corpo).
 */

const unexpected = (): never => {
  throw new SiasbError('UNEXPECTED_FORMAT', 'Resposta inesperada do SIASB.');
};

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) return unexpected();
  return r.data;
}

const id = z.union([z.number().int(), z.string().min(1)]).transform((v): string => String(v));
const text = z.string();
const nullableText = z.string().nullish().transform((v) => v ?? '');
const dateTime = z
  .string()
  .min(1)
  .transform((s, ctx) => {
    try {
      return parseSiasbDateTime(s);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
  });

/** Primeiro nome, com maiúscula inicial e o resto minúsculo (acentos intactos). O sobrenome nunca sai daqui. */
export function firstNameOf(raw: string | null | undefined): string {
  const token = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  if (token === '') return '';
  const [first, ...rest] = Array.from(token);
  return first.toLocaleUpperCase('pt-BR') + rest.join('').toLocaleLowerCase('pt-BR');
}

const sessionSchema = z.array(
  z.object({
    id,
    attendanceId: id,
    disciplineId: id,
    disciplineName: text,
    patientName: nullableText,
    professorName: nullableText,
    ambulatoryLocationName: nullableText,
    startAt: dateTime,
    endAt: dateTime,
    rescheduledStartAt: dateTime.nullish().transform((v) => v ?? null),
    statusLabel: nullableText,
    reservedByAnotherStudent: z.boolean().nullish(),
  }),
);

/** Sessões sinalizadas como reservadas por outro aluno são descartadas por inteiro (nem o primeiro nome sai). */
export function mapSessions(raw: unknown): ClinicalSession[] {
  return parse(sessionSchema, raw)
    .filter((s) => s.reservedByAnotherStudent !== true)
    .map((s): ClinicalSession => ({
      id: s.id,
      attendanceId: s.attendanceId,
      disciplineId: s.disciplineId,
      disciplineName: s.disciplineName,
      firstName: firstNameOf(s.patientName),
      professorName: s.professorName,
      locationName: s.ambulatoryLocationName,
      startAt: s.startAt,
      endAt: s.endAt,
      rescheduledStartAt: s.rescheduledStartAt,
      statusLabel: s.statusLabel,
    }));
}

const TREATMENT: Record<number, ClinicalAttendance['treatmentType']> = {
  1: 'TRIAGE',
  2: 'PLANNING',
  3: 'URGENCY',
};

const attendanceSchema = z.array(
  z.object({
    id,
    disciplineId: id,
    patientName: nullableText,
    treatmentType: z.number().int(),
    status: z.number().int(),
  }),
);

export function mapAttendances(raw: unknown): ClinicalAttendance[] {
  return parse(attendanceSchema, raw).map(
    (a): ClinicalAttendance => ({
      id: a.id,
      disciplineId: a.disciplineId,
      firstName: firstNameOf(a.patientName),
      treatmentType: TREATMENT[a.treatmentType] ?? 'UNKNOWN',
      concluded: a.status === 3,
    }),
  );
}

const disciplineSchema = z.array(z.object({ disciplineId: id, disciplineName: text }));

export function mapDisciplines(raw: unknown): ClinicalDiscipline[] {
  return parse(disciplineSchema, raw).map((d) => ({ id: d.disciplineId, name: d.disciplineName }));
}

const procedureSchema = z.array(z.object({ id, name: text }));

export function mapProcedures(raw: unknown): Procedure[] {
  return parse(procedureSchema, raw).map((p) => ({ id: p.id, name: p.name }));
}

const schedulingOptionSchema = z.array(z.object({ id, name: text, preferred: z.boolean().nullish() }));

/** Item de lista de opções do agendamento (professor, local, grupo): só id, nome e preferido. */
export function mapSchedulingOptions(raw: unknown): SchedulingOption[] {
  return parse(schedulingOptionSchema, raw).map((o) => ({ id: o.id, name: o.name, preferred: o.preferred === true }));
}

const unassignedSchema =z.array(z.object({ disciplineId: id }));

/** Só contagem por disciplina. Nome do paciente e prontuário (de terceiros) nem são lidos. */
export function countUnassigned(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of parse(unassignedSchema, raw)) {
    out[item.disciplineId] = (out[item.disciplineId] ?? 0) + 1;
  }
  return out;
}
