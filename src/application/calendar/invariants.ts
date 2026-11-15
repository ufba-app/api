import { ISO_DATE_PATTERN, type CalendarDocument, type When } from './contract';

/**
 * Invariantes do calendário. A IA copia; aqui o calendário é conferido com a
 * própria aritmética dele. Cada função devolve a lista de failures (vazia = ok).
 *
 * Regras (conferidas à mão com o calendário 2026.2, que fecha em todas):
 *  - dia letivo = dia de segunda a sábado dentro do período, menos feriado;
 *  - os 25/50/75% e o to caem no 25º/50º/75º/100º dia letivo;
 *  - o dia da semana impresso no feriado é o do calendário.
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function toDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}
function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isValidDate(iso: string): boolean {
  if (!ISO_DATE_PATTERN.test(iso)) return false;
  const d = toDate(iso);
  return !Number.isNaN(d.getTime()) && toIso(d) === iso;
}

/** Todos os dias letivos (seg–sáb, fora feriado) de `from` a `to`, em ordem. */
export function listTeachingDays(from: string, to: string, holidays: string[]): string[] {
  const fora = new Set(holidays);
  const dias: string[] = [];
  for (let d = toDate(from); toIso(d) <= to; d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() !== 0 && !fora.has(toIso(d))) dias.push(toIso(d));
  }
  return dias;
}

/** Todos os dias (ISO) cobertos pelos dias não letivos, expandindo os intervalos. */
export function listNonTeachingDays(c: CalendarDocument): string[] {
  const dias: string[] = [];
  for (const f of c.nonTeachingDays) {
    if (f.when.type === 'on') {
      dias.push(f.when.date);
      continue;
    }
    const { start, end } = f.when;
    if (!isValidDate(start) || !isValidDate(end) || start > end) continue;
    for (let d = toDate(start); toIso(d) <= end && dias.length < 2000; d = new Date(d.getTime() + 86_400_000)) {
      dias.push(toIso(d));
    }
  }
  return dias;
}

export function checkNonTeachingDays(c: CalendarDocument): string[] {
  const failures: string[] = [];
  for (const f of c.nonTeachingDays) {
    const datas =
      f.when.type === 'on' ? [f.when.date] : [f.when.start, f.when.end];
    const invalida = datas.find((d) => !isValidDate(d));
    if (invalida !== undefined) {
      failures.push(`Dia não letivo "${f.name}" com data inválida: "${invalida}".`);
      continue;
    }
    if (f.when.type === 'between' && f.when.start > f.when.end) {
      failures.push(`Dia não letivo "${f.name}": início (${f.when.start}) depois do to (${f.when.end}).`);
    }
    if (f.when.type === 'on' && f.weekday !== null) {
      const real = WEEKDAYS[toDate(f.when.date).getUTCDay()];
      if (real !== f.weekday) {
        failures.push(`Dia não letivo "${f.name}" (${f.when.date}): o documento diz ${f.weekday}, mas a data cai em ${real}.`);
      }
    }
  }
  return failures;
}

export interface Findings {
  /** Derrubam `verified`. */
  hard: string[];
  /** Entram nos avisos, mas não derrubam `verified`. */
  soft: string[];
}

/**
 * Dias letivos. Duro: a soma dos meses não fecha com o total que o próprio documento
 * declara (o documento se contradiz, ou a IA leu um número errado). Brando: o
 * documento é coerente consigo mesmo, mas a conta pela lista de dias não letivos dá
 * outro número. Visto no 2025.1: o total declarado (100) desconta Corpus Christi,
 * que a lista de holidays do PDF não traz. A omissão de um feriado impresso pela IA
 * continua sendo pega pela conferência de completude das datas.
 */
export function checkTeachingDays(c: CalendarDocument): Findings {
  const hard: string[] = [];
  const soft: string[] = [];
  const { termStart, termEnd } = c.keyDates;
  if (![termStart, termEnd].every(isValidDate)) {
    return { hard: ['Início ou to do período letivo com data inválida.'], soft };
  }

  const soma = c.teachingDays.byMonth.reduce((s, m) => s + m.days, 0);
  const documentoCoerente = soma === c.teachingDays.total;
  if (!documentoCoerente) {
    hard.push(`Dias letivos: a soma dos meses (${soma}) difere do total declarado (${c.teachingDays.total}).`);
  }
  // Onde a diferença com a conta vai: dura se o documento já não fecha, branda se fecha.
  const diferenca = documentoCoerente ? soft : hard;

  const dias = listTeachingDays(termStart, termEnd, listNonTeachingDays(c));
  if (dias.length !== c.teachingDays.total) {
    diferenca.push(
      `Dias letivos: o período tem ${dias.length} (seg–sáb sem os dias não letivos listados), o documento declara ${c.teachingDays.total}` +
        (documentoCoerente ? '; pode haver dia não letivo que o documento não lista.' : '.'),
    );
  }
  for (const m of c.teachingDays.byMonth) {
    const calculado = dias.filter((d) => d.startsWith(m.month)).length;
    if (calculado !== m.days) {
      diferenca.push(`Dias letivos de ${m.month}: a conta dá ${calculado}, o documento declara ${m.days}.`);
    }
  }

  // Marcos de 25/50/75% e to. Só valem se a conta fecha com o total (senão a diferença acima já explica).
  if (dias.length === c.teachingDays.total && dias.length > 0) {
    const marcos: Array<[string, string, number]> = [
      ['25%', c.keyDates.progress25, 0.25],
      ['50%', c.keyDates.progress50, 0.5],
      ['75%', c.keyDates.progress75, 0.75],
      ['to', c.keyDates.termEnd, 1],
    ];
    for (const [nome, data, fracao] of marcos) {
      const esperado = dias[Math.round(dias.length * fracao) - 1];
      if (esperado !== data) hard.push(`Marco ${nome}: o documento diz ${data}, a conta dos dias letivos dá ${esperado}.`);
    }
    if (dias[0] !== termStart) hard.push(`O início do período (${termStart}) não é dia letivo.`);
  }
  return { hard, soft };
}

function whenDates(w: When): string[] {
  switch (w.type) {
    case 'on':
    case 'until':
    case 'from':
      return [w.date];
    case 'between':
      return [w.start, w.end];
    default:
      return [];
  }
}

/** Datas inválidas, intervalos invertidos e ano fora do plausível, em todo o contrato. */
export function checkDates(c: CalendarDocument): string[] {
  const failures: string[] = [];
  // Plausível = de um ano antes a um ano depois do ano do semestre ("2025.1" -> 2024..2026):
  // o planejamento de um semestre acontece no ano anterior e a formatura no seguinte.
  const anoDoSemestre = Number(/^(\d{4})/.exec(c.document.term)?.[1]);
  const confere = (onde: string, iso: string) => {
    if (!isValidDate(iso)) failures.push(`${onde}: data inválida "${iso}".`);
    else if (Number.isFinite(anoDoSemestre) && Math.abs(Number(iso.slice(0, 4)) - anoDoSemestre) > 1) {
      failures.push(`${onde}: data fora do plausível para o semestre ${c.document.term} (${iso}).`);
    }
  };
  const intervalo = (onde: string, a: string, b: string) => {
    if (isValidDate(a) && isValidDate(b) && a > b) failures.push(`${onde}: início (${a}) depois do to (${b}).`);
  };

  if (c.document.publishedOn !== null) confere('document.publishedOn', c.document.publishedOn);
  for (const [k, v] of Object.entries(c.keyDates)) {
    if (v === null) continue;
    if (typeof v === 'string') confere(`keyDates.${k}`, v);
    else {
      confere(`keyDates.${k}.start`, v.start);
      confere(`keyDates.${k}.end`, v.end);
      intervalo(`keyDates.${k}`, v.start, v.end);
    }
  }
  const ordem = [c.keyDates.termStart, c.keyDates.progress25, c.keyDates.progress50, c.keyDates.progress75, c.keyDates.termEnd];
  if (ordem.some((d, i) => i > 0 && d < ordem[i - 1]!)) failures.push('keyDates: início, 25%, 50%, 75% e to fora de ordem.');

  c.events.forEach((e, i) => {
    const onde = `events[${i}] "${e.description.slice(0, 40)}"`;
    for (const d of whenDates(e.when)) confere(onde, d);
    if (e.when.type === 'between') intervalo(onde, e.when.start, e.when.end);
    for (const r of e.additionalWindows) {
      confere(`${onde} reabertura`, r.start);
      confere(`${onde} reabertura`, r.end);
      intervalo(`${onde} reabertura`, r.start, r.end);
    }
  });
  c.otherEvents.forEach((e, i) => {
    for (const d of whenDates(e.when)) confere(`otherEvents[${i}] "${e.name.slice(0, 40)}"`, d);
    if (e.when.type === 'between') intervalo(`otherEvents[${i}]`, e.when.start, e.when.end);
  });
  return failures;
}

/** Todas as datas que a saída carrega, como "DD/MM". */
export function outputDates(c: CalendarDocument): Set<string> {
  const todas: string[] = c.document.publishedOn ? [c.document.publishedOn] : [];
  for (const v of Object.values(c.keyDates)) {
    if (v === null) continue;
    if (typeof v === 'string') todas.push(v);
    else todas.push(v.start, v.end);
  }
  for (const e of c.events) {
    todas.push(...whenDates(e.when));
    for (const r of e.additionalWindows) todas.push(r.start, r.end);
  }
  for (const f of c.nonTeachingDays) todas.push(...whenDates(f.when));
  for (const e of c.otherEvents) todas.push(...whenDates(e.when));
  return new Set(todas.filter(isValidDate).map((d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`));
}

/** Todas as datas "DD/MM" impressas no texto de origem (com ou sem ano). */
export function textDates(textoOriginal: string): Set<string> {
  // Rodapés não são eventos: "(*) Datas aprovadas ... CONSEPE em 01/03/2023" e "Versão: 20/03/2023".
  const texto = textoOriginal
    .replace(/\(\*\)\s*Datas aprovadas.*$/gm, '')
    .replace(/Vers[ãa]o:?\s*\d{1,2}\/\d{1,2}\/\d{4}/g, '');
  const achadas = new Set<string>();
  const adiciona = (dia: number, mes: number) => {
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      achadas.add(`${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`);
    }
  };
  for (const m of texto.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{4})?/g)) adiciona(Number(m[1]), Number(m[2]));
  // Dias que dividem o mês com a última data: "13, 14, 17 e 18/03/2025", "09 a 11/08/2023".
  for (const m of texto.matchAll(/(?<![/\d])((?:\d{1,2}(?:\s*,\s*|\s+e\s+|\s+a\s+))+)(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
    for (const dia of m[1]!.match(/\d{1,2}/g) ?? []) adiciona(Number(dia), Number(m[3]));
  }
  return achadas;
}

/**
 * Completude: toda data impressa no documento precisa aparecer em algum campo da
 * saída. O PDF repete cada evento em duas visões, então uma omissão da IA teria
 * que acontecer nas duas para passar. Não pega data inventada de verdade (isso é
 * `checkDates` e as contas de dias letivos), só omissão.
 */
export function checkCompleteness(c: CalendarDocument, texto: string): string[] {
  const saida = outputDates(c);
  const faltando = [...textDates(texto)].filter((d) => !saida.has(d)).sort();
  return faltando.length
    ? [`Datas impressas no documento e ausentes da saída: ${faltando.join(', ')}.`]
    : [];
}

/** Asteriscos de "alteração de data" colados a uma data no texto vs. flags `dateChanged`. */
export function checkChanges(c: CalendarDocument, texto: string): string[] {
  // Conta os `*` do texto fora da legenda "* Alteração de data". No layout novo o asterisco
  // fica colado à data; no antigo, ao rótulo ("Início do semestre letivo*"): vale qualquer um.
  const semLegenda = texto.split('\n').filter((l) => !/^\s*\*\s*Altera/i.test(l)).join('\n');
  const noTexto = (semLegenda.match(/\*/g) ?? []).length;
  // O PDF repete os eventos em duas visões, então só se compara a presença:
  // se o texto tem asterisco, ao menos um flag precisa existir (e vice-versa).
  const flags = c.nonTeachingDays.filter((f) => f.dateChanged).length + c.events.filter((e) => e.dateChanged).length;
  if (noTexto > 0 && flags === 0) return [`O documento marca ${noTexto} data(s) com * (alteração), mas nenhuma saiu com dateChanged.`];
  if (noTexto === 0 && flags > 0) return [`A saída marca ${flags} data(s) como alteradas, mas o documento não tem *.`];
  return [];
}

export function checkAll(c: CalendarDocument, texto: string): Findings {
  const dias = checkTeachingDays(c);
  return {
    hard: [
      ...checkDates(c),
      ...checkNonTeachingDays(c),
      ...dias.hard,
      ...checkCompleteness(c, texto),
      ...checkChanges(c, texto),
    ],
    soft: dias.soft,
  };
}
