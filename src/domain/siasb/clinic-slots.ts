import type { ClinicalSession } from './types';

export interface ClinicSlot {
  disciplineId: string;
  /** 0 = domingo ... 6 = sábado, na hora da Bahia. */
  weekday: number;
  /** `HH:mm` na hora da Bahia. */
  time: string;
  durationMin: number;
}

const BAHIA_OFFSET_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

function bahiaParts(d: Date): { weekday: number; time: string } {
  const s = new Date(d.getTime() - BAHIA_OFFSET_MS);
  const hh = String(s.getUTCHours()).padStart(2, '0');
  const mm = String(s.getUTCMinutes()).padStart(2, '0');
  return { weekday: s.getUTCDay(), time: `${hh}:${mm}` };
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** Horários recorrentes da clínica: disciplina + dia da semana + hora, com pelo menos 2 ocorrências. */
export function deduceSlots(sessions: ClinicalSession[]): ClinicSlot[] {
  const groups = new Map<string, { slot: Omit<ClinicSlot, 'durationMin'>; durations: number[] }>();
  for (const s of sessions) {
    const { weekday, time } = bahiaParts(s.startAt);
    const key = `${s.disciplineId}|${weekday}|${time}`;
    const g = groups.get(key) ?? { slot: { disciplineId: s.disciplineId, weekday, time }, durations: [] };
    g.durations.push(Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60_000));
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.durations.length >= 2)
    .map((g) => ({ ...g.slot, durationMin: median(g.durations) }));
}

/** Início do próximo horário futuro da disciplina (hora da Bahia), ou `null` se não há slot. */
export function nextSlotStart(slots: ClinicSlot[], disciplineId: string, now: Date): Date | null {
  const mine = slots.filter((s) => s.disciplineId === disciplineId);
  if (mine.length === 0) return null;
  const local = new Date(now.getTime() - BAHIA_OFFSET_MS);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let best: Date | null = null;
  for (let add = 0; add <= 8; add++) {
    const base = dayStart + add * DAY_MS;
    const weekday = new Date(base).getUTCDay();
    for (const s of mine) {
      if (s.weekday !== weekday) continue;
      const [h, m] = s.time.split(':').map(Number);
      const start = new Date(base + (h * 60 + m) * 60_000 + BAHIA_OFFSET_MS);
      if (start.getTime() > now.getTime() && (best === null || start < best)) best = start;
    }
    if (best) return best;
  }
  return best;
}
