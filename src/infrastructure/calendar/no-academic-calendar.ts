import { AcademicCalendar } from '../../application/ports/academic-calendar';

/** Padrão enquanto não há calendário oficial da UFBA: "desconhecido". */
export class NoAcademicCalendar extends AcademicCalendar {
  async holidays(): Promise<{ known: boolean; dates: string[] }> {
    return { known: false, dates: [] };
  }
}
