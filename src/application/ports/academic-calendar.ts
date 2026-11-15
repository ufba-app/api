/** Feriados e dias sem aula. `known: false` quando a api não tem o calendário oficial (os prazos ganham margem). */
export abstract class AcademicCalendar {
  abstract holidays(from: Date, to: Date): Promise<{ known: boolean; dates: string[] }>;
}
