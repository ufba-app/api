/**
 * Coluna "Local" do portal do SIGAA (texto livre digitado pelo professor) → prédio e sala por dia da semana, quando dá.
 * Portado do app antigo (`sigaa-engine/parsers/local.ts`, padrões observados no portal real); puro, sem rede.
 * Sem padrão reconhecido, o texto original é preservado (nunca se perde nada).
 */

export interface ClassLocation {
  building: string | null;
  room: string | null;
  /** O texto como o portal trouxe. */
  original: string;
}

/** Dia da semana do SIGAA: 2 segunda ... 7 sábado. */
const DAY_BY_ABBREVIATION: Record<string, number> = { seg: 2, ter: 3, qua: 4, qui: 5, sex: 6, sab: 7 };
const FULL_DAY_NAMES = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Salas citadas sem o prédio ("Smart Class III"): a leitura ingênua tomaria o nome da sala pelo prédio. É conhecimento do campus,
 * não dá para derivar do texto: acrescente uma entrada quando surgir outra.
 */
const KNOWN_ROOM_ONLY_PREFIXES: ReadonlyArray<{ prefix: string; building: string }> = [{ prefix: 'smart class', building: 'PAF II' }];

function normalizeKnownRoom(info: ClassLocation): ClassLocation {
  if (!info.building) return info;
  const normalized = stripAccents(info.building).toLowerCase();
  const known = KNOWN_ROOM_ONLY_PREFIXES.find((e) => normalized.startsWith(e.prefix));
  return known ? { building: known.building, room: info.building, original: info.original } : info;
}

/** "Ter PAF I/Qui Smart Class III": dia abreviado + local livre, um trecho por dia, separados por "/". */
function perDay(local: string): Map<number, ClassLocation> | null {
  const segments = local.split('/').map((s) => s.trim());
  if (segments.length < 2) return null;
  const out = new Map<number, ClassLocation>();
  for (const segment of segments) {
    const m = /^(\S{3})\.?\s+(.+)$/.exec(segment);
    if (!m) return null;
    const day = DAY_BY_ABBREVIATION[stripAccents(m[1]).toLowerCase()];
    if (!day) return null;
    out.set(day, { building: m[2].trim(), room: null, original: local });
  }
  return out;
}

/** "PAF 1 - 208 - Terça Horários 18:30 às 19:25PAF 1 - 208 - Quinta ...": prédio e sala fixos, repetidos por dia/horário. */
function fixedBuildingRoom(local: string): ClassLocation | null {
  const m = new RegExp(`^(.+?)\\s*-\\s*(.+?)\\s*-\\s*(?:${FULL_DAY_NAMES.join('|')})\\b`).exec(local);
  return m ? { building: m[1].trim(), room: m[2].trim(), original: local } : null;
}

/** "ENG (ENG)": só o prédio (a sala ainda não foi definida). */
function buildingOnly(local: string): ClassLocation | null {
  const m = /^(.+?)\s*\((\S+)\)$/.exec(local.trim());
  return m ? { building: m[2].trim(), room: null, original: local } : null;
}

/** O local de cada dia pedido; dia que não deu para ler fica com o texto original. */
export function parseLocation(local: string, weekdays: readonly number[]): Map<number, ClassLocation> {
  const fallback: ClassLocation = { building: null, room: null, original: local };
  const out = new Map<number, ClassLocation>();
  const days = perDay(local);
  if (days) {
    for (const d of weekdays) out.set(d, normalizeKnownRoom(days.get(d) ?? fallback));
    return out;
  }
  const uniform = normalizeKnownRoom(fixedBuildingRoom(local) ?? buildingOnly(local) ?? fallback);
  for (const d of weekdays) out.set(d, uniform);
  return out;
}

const MAX_PLACE = 80;

/** Texto curto para a tela: "PAF 1 · 208", "ENG", "PAF II · Smart Class III"; sem leitura, o texto original (enxuto). */
export function formatPlace(l: ClassLocation): string | null {
  const text = l.building ? (l.room ? `${l.building} · ${l.room}` : l.building) : l.original.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_PLACE ? `${text.slice(0, MAX_PLACE - 1)}…` : text;
}
