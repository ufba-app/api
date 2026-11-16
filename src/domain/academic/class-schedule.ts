/**
 * Horário das turmas do SIGAA (puro, sem rede): o código de horário que o portal mostra ("35T45", "24M12 6T12") e a
 * recorrência que ele aponta. Dias: 1 domingo, 2 segunda ... 7 sábado; turno: M manhã, T tarde, N noite; depois, os
 * módulos do turno (manhã e tarde têm 6; noite tem 4). Cada módulo dura 55 minutos e os módulos de um turno seguem sem
 * intervalo, a partir de 07:00 (M), 13:00 (T) e 18:30 (N).
 *
 * A TABELA DE HORAS vem de um trecho da página da UFBA (ufbasim.ufba.br, "Códigos na tabela de horários do SIGAA": primeiro
 * horário da manhã 7:00, da tarde 13:00, da noite 18:30, "a cada módulo acresce os 55 minutos"; exemplo "24N12" = 18:30 às
 * 20:20). A página não pôde ser lida por inteiro, então os intervalos entre módulos (se houver) são A CONFIRMAR: o ponto único
 * de ajuste é `SHIFTS` abaixo.
 */

export type Shift = 'M' | 'T' | 'N';

export const SHIFTS: Record<Shift, { startMinutes: number; modules: number }> = {
  M: { startMinutes: 7 * 60, modules: 6 },
  T: { startMinutes: 13 * 60, modules: 6 },
  N: { startMinutes: 18 * 60 + 30, modules: 4 },
};
export const MODULE_MINUTES = 55;

export interface ScheduleBlock {
  /** 1 domingo ... 7 sábado. */
  weekdays: number[];
  shift: Shift;
  /** Módulos do turno, em ordem. */
  modules: number[];
}

export interface SchedulePeriod {
  /** AAAA-MM-DD */
  start: string;
  end: string;
}

export interface ParsedSchedule {
  blocks: ScheduleBlock[];
  /** O período entre parênteses, quando o portal o mostra. */
  period: SchedulePeriod | null;
}

/** Uma turma do portal com dia e horário. */
export interface ClassSchedule extends ParsedSchedule {
  name: string;
  room: string | null;
  /** O código como está no portal (para diagnóstico). */
  code: string;
}

export interface ClassOccurrence {
  /** AAAA-MM-DD */
  date: string;
  /** HH:mm (hora de Salvador) */
  start: string;
  end: string;
}

const BLOCK = /(\d{1,6})([MTN])(\d{1,6})/g;
const PERIOD = /\(\s*(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})\s*\)/;

const isoDate = (d: string, m: string, y: string): string | null => {
  const t = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== `${y}-${m}-${d}` ? null : `${y}-${m}-${d}`;
};

/**
 * "35T45 (18/08/2026 - 19/12/2026)" → blocos + período. Vários blocos separados por espaço ("24M12 6T12") valem. Bloco com
 * dia fora de 1-7 ou módulo que o turno não tem é descartado; sem nenhum bloco válido, `null` (o chamador não inventa horário).
 */
export function parseSchedule(text: string): ParsedSchedule | null {
  const blocks: ScheduleBlock[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const weekdays = [...new Set([...m[1]].map(Number))];
    const modules = [...new Set([...m[3]].map(Number))].sort((a, b) => a - b);
    const shift = m[2] as Shift;
    if (weekdays.some((d) => d < 1 || d > 7) || modules.some((x) => x < 1 || x > SHIFTS[shift].modules)) continue;
    blocks.push({ weekdays: weekdays.sort((a, b) => a - b), shift, modules });
  }
  if (blocks.length === 0) return null;
  const p = PERIOD.exec(text);
  const start = p ? isoDate(p[1], p[2], p[3]) : null;
  const end = p ? isoDate(p[4], p[5], p[6]) : null;
  return { blocks, period: start && end && start <= end ? { start, end } : null };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Horário de cada trecho contínuo de módulos do bloco ("45" é um trecho; "13" são dois). */
export function blockTimes(block: ScheduleBlock): Array<{ start: string; end: string }> {
  const runs: number[][] = [];
  for (const m of block.modules) {
    const last = runs.at(-1);
    if (last && last.at(-1)! + 1 === m) last.push(m);
    else runs.push([m]);
  }
  const base = SHIFTS[block.shift].startMinutes;
  return runs.map((r) => ({ start: hhmm(base + (r[0] - 1) * MODULE_MINUTES), end: hhmm(base + r.at(-1)! * MODULE_MINUTES) }));
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 400;

/**
 * As aulas da turma entre `from` e `to` (AAAA-MM-DD, inclusivos), dentro do período da própria turma (ou `fallbackPeriod`
 * quando o portal não o mostra; sem nenhum dos dois, nada). `isNonTeaching(date)` tira os feriados e dias sem aula.
 */
export function expandClass(
  s: ParsedSchedule,
  from: string,
  to: string,
  isNonTeaching: (date: string) => boolean,
  fallbackPeriod?: SchedulePeriod | null,
): ClassOccurrence[] {
  const period = s.period ?? fallbackPeriod ?? null;
  if (!period) return [];
  const start = Math.max(Date.parse(`${from}T00:00:00Z`), Date.parse(`${period.start}T00:00:00Z`));
  const end = Math.min(Date.parse(`${to}T00:00:00Z`), Date.parse(`${period.end}T00:00:00Z`));
  const out: ClassOccurrence[] = [];
  for (let t = start, n = 0; t <= end && n < MAX_DAYS; t += DAY_MS, n++) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (isNonTeaching(date)) continue;
    const weekday = new Date(t).getUTCDay() + 1; // 1 domingo ... 7 sábado
    for (const b of s.blocks) {
      if (!b.weekdays.includes(weekday)) continue;
      for (const r of blockTimes(b)) out.push({ date, ...r });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}
