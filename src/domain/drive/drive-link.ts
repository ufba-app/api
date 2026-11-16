/**
 * Links do Google Drive/Docs que aparecem no conteúdo do Moodle (puro, sem rede). Só os hosts `drive.google.com` e
 * `docs.google.com`; formulários não viram anexo (PASTAS viram: o servidor lista o primeiro nível). O id é validado (só letras, números, `_` e `-`), porque ele
 * entra em URLs que o servidor monta para falar com o Google.
 */
export type DriveKind = 'file' | 'doc' | 'sheet' | 'slides' | 'folder';

export interface DriveLink {
  kind: DriveKind;
  id: string;
}

export interface FoundDriveLink extends DriveLink {
  /** Texto do link na página (quando o professor deu um nome), já sem marcação. */
  label?: string;
}

const HOSTS = new Set(['drive.google.com', 'docs.google.com']);
const ID = /^[A-Za-z0-9_-]{10,128}$/;
const KIND_BY_SEGMENT: Record<string, DriveKind> = { document: 'doc', spreadsheets: 'sheet', presentation: 'slides', file: 'file' };
const MAX_LINKS = 50;

/** Reconhece UM link; `null` se não for um arquivo do Drive/Docs (host de fora, pasta, formulário, id estranho). */
export function parseDriveLink(raw: string): DriveLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = /^\/(document|spreadsheets|presentation|file)\/(?:u\/\d+\/)?d\/([^/?#]+)/.exec(u.pathname);
  if (m) return ID.test(m[2]) ? { kind: KIND_BY_SEGMENT[m[1]], id: m[2] } : null;
  if (u.hostname.toLowerCase() === 'drive.google.com') {
    const f = /^\/drive\/(?:u\/\d+\/)?folders\/([^/?#]+)/.exec(u.pathname);
    if (f) return ID.test(f[1]) ? { kind: 'folder', id: f[1] } : null;
    if (u.pathname === '/drive/folderview' || u.pathname === '/folderview') {
      const id = u.searchParams.get('id') ?? '';
      return ID.test(id) ? { kind: 'folder', id } : null;
    }
  }
  if (u.hostname.toLowerCase() === 'drive.google.com' && (u.pathname === '/open' || u.pathname === '/uc')) {
    const id = u.searchParams.get('id') ?? '';
    return ID.test(id) ? { kind: 'file', id } : null;
  }
  return null;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Os links do Drive de um trecho de HTML (hrefs e URLs soltas no texto) e de uma lista de URLs. Sem repetição (por tipo e
 * id), na ordem em que aparecem, no máximo 50.
 */
export function extractDriveLinks(html: string | undefined, urls: readonly string[] = []): FoundDriveLink[] {
  const found = new Map<string, FoundDriveLink>();
  const add = (link: DriveLink | null, label?: string) => {
    if (!link) return;
    const key = `${link.kind}:${link.id}`;
    const cur = found.get(key);
    const clean = label && !/^https?:\/\//i.test(label) ? label.slice(0, 120) : undefined;
    if (cur) {
      if (!cur.label && clean) cur.label = clean;
      return;
    }
    if (found.size < MAX_LINKS) found.set(key, { ...link, ...(clean ? { label: clean } : {}) });
  };
  for (const u of urls) add(parseDriveLink(u));
  if (html) {
    // Na ordem em que aparecem na página (hrefs e URLs soltas juntos).
    const hits: Array<{ at: number; link: DriveLink | null; label?: string }> = [];
    for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
      hits.push({ at: m.index ?? 0, link: parseDriveLink(decode(m[1] ?? m[2] ?? '')), label: stripTags(m[3]) });
    }
    for (const m of html.matchAll(/https?:\/\/(?:drive|docs)\.google\.com\/[^\s"'<>)\]]+/gi)) {
      hits.push({ at: m.index ?? 0, link: parseDriveLink(decode(m[0])) });
    }
    for (const h of hits.sort((a, b) => a.at - b.at)) add(h.link, h.label);
  }
  return [...found.values()];
}

/** Nome neutro para quando o link não trouxe texto. */
export const DRIVE_KIND_NAME: Record<DriveKind, string> = {
  file: 'Arquivo do Drive',
  doc: 'Documento do Google',
  sheet: 'Planilha do Google',
  slides: 'Apresentação do Google',
  folder: 'Pasta do Drive',
};

/** Link para a PESSOA abrir no próprio navegador (nunca para o servidor ou o agente buscarem: pede login). */
export function driveViewUrl(link: DriveLink): string {
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case 'doc':
      return `https://docs.google.com/document/d/${id}/edit`;
    case 'sheet':
      return `https://docs.google.com/spreadsheets/d/${id}/edit`;
    case 'slides':
      return `https://docs.google.com/presentation/d/${id}/edit`;
    case 'folder':
      return `https://drive.google.com/drive/folders/${id}`;
    default:
      return `https://drive.google.com/file/d/${id}/view`;
  }
}
