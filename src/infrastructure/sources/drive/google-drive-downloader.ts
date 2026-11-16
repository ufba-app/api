import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import {
  DriveDownloader,
  type DriveAccount,
  type DriveBlock,
  type DriveFileInfo,
  type DriveFolderEntry,
} from '../../../application/ports/drive-downloader';
import { SourceError } from '../../../application/ports/source-gateway';
import { Secret } from '../../../application/shared/secret';
import { driveViewUrl, type DriveKind, type DriveLink } from '../../../domain/drive/drive-link';
import { appDaConta } from '../classroom/classroom-link';
import { GoogleApiError, type GoogleHttp } from '../google/google-http';
import { DriveRefs } from './drive-refs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;
export const DRIVE_TIMEOUT_MS = 30_000;
/** Itens listados de UMA pasta (só o primeiro nível, uma página da API). */
export const MAX_FOLDER_ITEMS = 100;
const MAX_HOPS = 5;

/** Exportação dos nativos do Google (decisão do André): Docs e Apresentações → PDF; Planilhas → XLSX. */
const EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: PDF, ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mime: PDF, ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: XLSX, ext: '.xlsx' },
};

/** Tipo nativo do Google → tipo do `ref` (o `download` decide pelos metadados de qualquer jeito). */
const KIND_BY_MIME: Record<string, DriveKind> = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.spreadsheet': 'sheet',
  'application/vnd.google-apps.presentation': 'slides',
  [FOLDER_MIME]: 'folder',
};

export const SEM_ACESSO =
  'Sem acesso a este arquivo do Drive. Se a sua conta do Google tem acesso, conecte o Google Classroom com ela no painel; ' +
  'senão peça ao professor para abrir o link a qualquer pessoa que tenha o link.';

/** Hosts do Google para onde o servidor aceita ir (e seguir redirect). Nada fora deles. */
export function googleHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'drive.google.com' || h === 'docs.google.com' || h === 'drive.usercontent.google.com' || h.endsWith('.googleusercontent.com');
}

type FetchFn = typeof fetch;

/** "350 MB", "820 KB", "1,2 GB": para a mensagem que a pessoa lê. */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Vídeo (qualquer tamanho) ou acima do teto: NÃO se baixa pelo serviço. */
export function classifyBlock(mimeType: string, sizeBytes: number | null): DriveBlock | null {
  if (mimeType.toLowerCase().startsWith('video/')) return 'video';
  if (sizeBytes !== null && sizeBytes > MAX_DRIVE_BYTES) return 'too_large';
  return null;
}

/** A frase pt-BR para quem pediu um arquivo que não se baixa, sempre com o link para abrir no navegador. */
export function blockMessage(name: string, block: DriveBlock, sizeBytes: number | null, viewUrl: string): string {
  const size = sizeBytes !== null ? ` (${humanSize(sizeBytes)})` : '';
  return block === 'video'
    ? `"${name}" é um vídeo${size}: abra no navegador: ${viewUrl}`
    : `"${name}" é grande demais${size}, o limite é ${MAX_DRIVE_BYTES / 1024 / 1024} MB: abra no navegador: ${viewUrl}`;
}

interface DriveMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
}

function toInfo(meta: DriveMeta, link: DriveLink): DriveFileInfo {
  const mimeType = meta.mimeType ?? 'application/octet-stream';
  const sizeBytes = meta.size !== undefined && Number.isFinite(Number(meta.size)) ? Number(meta.size) : null;
  const name = meta.name || `drive-${link.id.slice(0, 8)}`;
  const viewUrl = driveViewUrl(link);
  const blocked = classifyBlock(mimeType, sizeBytes);
  return { name, mimeType, sizeBytes, viewUrl, blocked, message: blocked ? blockMessage(name, blocked, sizeBytes, viewUrl) : null };
}

function tooLarge(name: string, sizeBytes: number | null, viewUrl: string): SourceError {
  return new SourceError('UNSUPPORTED_SCOPE', blockMessage(name, 'too_large', sizeBytes, viewUrl));
}

/** Lê o corpo até o teto (aborta o resto). Nada é guardado além dos bytes devolvidos. */
async function readCapped(res: Response, name: string, viewUrl: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DRIVE_BYTES) throw tooLarge(name, declared, viewUrl);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DRIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(name, null, viewUrl);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function fileNameFrom(res: Response): string | undefined {
  const cd = res.headers.get('content-disposition') ?? '';
  // `filename*` (UTF-8) tem prioridade sobre o `filename` simples.
  const raw = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.replace(/^"|"$/g, ''));
  } catch {
    return raw;
  }
}

const safeName = (n: string) => n.replace(/[\r\n"\\/]/g, '_').slice(0, 200);

/**
 * Baixa arquivos do Drive linkados no Moodle e lista pastas. Ordem: token da pessoa (Classroom conectado, `drive.readonly`) e,
 * se nenhuma conta abrir, o link público (download) ou a API pública do Drive com a chave do servidor (`GOOGLE_DRIVE_API_KEY`,
 * opcional: metadados e listagem de pasta pública). Só fala com hosts do Google; redirect só dentro deles (redirect para o login
 * do Google = arquivo privado); teto de 25 MB e 30 s; **vídeo e arquivo acima do teto não são baixados** (mensagem clara com o link
 * para abrir no navegador). Nada é guardado, nada de conteúdo vai para log ou erro.
 */
export class GoogleDriveDownloader extends DriveDownloader {
  private readonly apiKey?: Secret;

  constructor(
    private readonly refs: DriveRefs,
    private readonly clientes: { ufba?: GoogleHttp; convidado?: GoogleHttp },
    private readonly opts: { dominio?: string; fetchFn?: FetchFn; apiKey?: string } = {},
  ) {
    super();
    this.apiKey = opts.apiKey ? Secret.of(opts.apiKey) : undefined;
  }

  owns(ref: string): boolean {
    return this.refs.owns(ref);
  }

  isFolder(ref: string): boolean {
    return this.refs.owns(ref) && ref.startsWith('gdrive1.folder.');
  }

  viewUrl(userId: string, ref: string): string | null {
    const link = this.refs.verify(userId, ref);
    return link ? driveViewUrl(link) : null;
  }

  /** As contas do Google da pessoa, a `@ufba.br` primeiro (a que costuma ter acesso aos arquivos dos professores). */
  private ordered(accounts: readonly DriveAccount[]): Array<{ account: DriveAccount; http: GoogleHttp }> {
    const dominio = this.opts.dominio ?? 'ufba.br';
    return [...accounts]
      .sort((a, b) => Number(b.accountKey.endsWith(`@${dominio}`)) - Number(a.accountKey.endsWith(`@${dominio}`)))
      .flatMap((account) => {
        const http = this.clientes[appDaConta(account.accountKey, dominio)];
        return http ? [{ account, http }] : [];
      });
  }

  private verify(userId: string, ref: string): DriveLink {
    const link = this.refs.verify(userId, ref);
    if (!link) {
      throw new SourceError('UNSUPPORTED_SCOPE', 'Este anexo do Drive não veio do seu curso (ou mudou). Peça o conteúdo do curso de novo.');
    }
    return link;
  }

  async download(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<AttachmentContent> {
    const link = this.verify(userId, ref);
    if (link.kind === 'folder') {
      throw new SourceError('UNSUPPORTED_SCOPE', 'Isto é uma pasta do Drive: use os arquivos de dentro dela (o ver_curso lista) ou abra no navegador: ' + driveViewUrl(link));
    }
    let transient = false;
    for (const { account, http } of this.ordered(accounts)) {
      try {
        return await this.viaApi(http, account, link);
      } catch (e) {
        if (e instanceof SourceError) throw e;
        // 400/401/403/404 (refresh recusado, token sem acesso, arquivo não compartilhado com esta conta): próxima conta.
        if (e instanceof GoogleApiError && [400, 401, 403, 404].includes(e.status)) continue;
        transient = true;
      }
    }
    try {
      const pub = await this.viaPublico(link);
      if (pub) return pub;
    } catch (e) {
      if (e instanceof SourceError) throw e;
      transient = true;
    }
    if (transient) throw new SourceError('UNAVAILABLE', 'Não consegui falar com o Google Drive agora. Tente de novo em instantes.');
    throw new SourceError('NO_ACCESS', SEM_ACESSO);
  }

  async inspect(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<DriveFileInfo | null> {
    const link = this.verify(userId, ref);
    if (link.kind === 'folder') return null;
    for (const { account, http } of this.ordered(accounts)) {
      try {
        const res = await http.get(account.refreshToken, `${DRIVE_API}/${encodeURIComponent(link.id)}`, { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' }, { signal: this.signal() });
        return toInfo((await res.json()) as DriveMeta, link);
      } catch {
        // sem acesso por esta conta (ou falha passageira): tenta a próxima e, por fim, a chave pública
      }
    }
    const pub = await this.publicJson(`${DRIVE_API}/${encodeURIComponent(link.id)}`, { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' });
    return pub ? toInfo(pub as DriveMeta, link) : null;
  }

  async listFolder(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<DriveFolderEntry[] | null> {
    const link = this.verify(userId, ref);
    if (link.kind !== 'folder') return null;
    // O id foi validado (só letras, números, _ e -): não há como escapar das aspas da consulta.
    const params = {
      q: `'${link.id}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size)',
      pageSize: String(MAX_FOLDER_ITEMS),
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    let raw: { files?: DriveMeta[] } | null = null;
    for (const { account, http } of this.ordered(accounts)) {
      try {
        raw = (await (await http.get(account.refreshToken, DRIVE_API, params, { signal: this.signal() })).json()) as { files?: DriveMeta[] };
        break;
      } catch {
        // sem acesso à pasta por esta conta: próxima
      }
    }
    raw ??= (await this.publicJson(DRIVE_API, params)) as { files?: DriveMeta[] } | null;
    if (!raw) return null;
    return (raw.files ?? []).slice(0, MAX_FOLDER_ITEMS).flatMap((f) => {
      if (!f.id || !/^[A-Za-z0-9_-]{10,128}$/.test(f.id)) return [];
      const mimeType = f.mimeType ?? 'application/octet-stream';
      const child: DriveLink = { kind: KIND_BY_MIME[mimeType] ?? 'file', id: f.id };
      const info = toInfo(f, child);
      const isFolder = child.kind === 'folder';
      // Subpasta não é expandida (só o primeiro nível): vira link para a pessoa abrir. O resto, se baixável, ganha um `ref` assinado.
      const size = info.sizeBytes !== null ? `, ${humanSize(info.sizeBytes)}` : '';
      const label = isFolder ? `${info.name} (subpasta)` : info.blocked === 'video' ? `${info.name} (vídeo${size})` : info.blocked === 'too_large' ? `${info.name} (grande demais${size})` : info.name;
      return [{ ...info, isFolder, label, ref: isFolder || info.blocked ? null : this.refs.sign(userId, child) }];
    });
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(DRIVE_TIMEOUT_MS);
  }

  /** API pública do Drive com a chave do SERVIDOR (só metadados e listagem de arquivo/pasta públicos). Sem chave ou sem acesso: `null`. */
  private async publicJson(url: string, params: Record<string, string>): Promise<unknown | null> {
    if (!this.apiKey) return null;
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', this.apiKey.reveal());
    try {
      const res = await (this.opts.fetchFn ?? fetch)(u, { signal: this.signal() });
      return res.ok ? await res.json() : null;
    } catch {
      return null; // a mensagem do erro poderia trazer a URL (com a chave): nunca sai daqui
    }
  }

  private async viaApi(http: GoogleHttp, a: DriveAccount, link: DriveLink): Promise<AttachmentContent> {
    const url = `${DRIVE_API}/${encodeURIComponent(link.id)}`;
    const metaRes = await http.get(a.refreshToken, url, { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' }, { signal: this.signal() });
    const info = toInfo((await metaRes.json()) as DriveMeta, link);
    // Vídeo ou arquivo grande: NÃO baixa; diz o que é e dá o link para abrir no navegador.
    if (info.blocked) throw new SourceError('UNSUPPORTED_SCOPE', info.message!);
    const exp = EXPORT[info.mimeType];
    if (exp) {
      const res = await http.get(a.refreshToken, `${url}/export`, { mimeType: exp.mime }, { signal: this.signal() });
      const name = info.name;
      return { bytes: await readCapped(res, name, info.viewUrl), mimeType: exp.mime, fileName: safeName(name.toLowerCase().endsWith(exp.ext) ? name : name + exp.ext) };
    }
    if (info.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new SourceError('UNSUPPORTED_SCOPE', 'Este tipo de arquivo do Google (pasta, formulário, desenho…) não pode ser baixado.');
    }
    const res = await http.get(a.refreshToken, url, { alt: 'media', supportsAllDrives: 'true' }, { signal: this.signal() });
    return { bytes: await readCapped(res, info.name, info.viewUrl), mimeType: info.mimeType, fileName: safeName(info.name) };
  }

  /** Link público, sem login. `null` = não abre sem login (privado, página de login ou HTML no lugar do arquivo). */
  private async viaPublico(link: DriveLink): Promise<AttachmentContent | null> {
    const id = encodeURIComponent(link.id);
    const target =
      link.kind === 'doc'
        ? { url: `https://docs.google.com/document/d/${id}/export?format=pdf`, mime: PDF, ext: '.pdf' }
        : link.kind === 'slides'
          ? { url: `https://docs.google.com/presentation/d/${id}/export?format=pdf`, mime: PDF, ext: '.pdf' }
          : link.kind === 'sheet'
            ? { url: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, mime: XLSX, ext: '.xlsx' }
            : { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, mime: '', ext: '' };
    const res = await this.getInsideGoogle(target.url);
    if (!res || !res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === '') return null; // página de login/aviso, não o arquivo
    const name = fileNameFrom(res) ?? `drive-${link.id.slice(0, 8)}${target.ext}`;
    const viewUrl = driveViewUrl(link);
    if (type.startsWith('video/')) {
      await res.body?.cancel().catch(() => undefined);
      const declared = Number(res.headers.get('content-length') ?? 0);
      throw new SourceError('UNSUPPORTED_SCOPE', blockMessage(name, 'video', declared > 0 ? declared : null, viewUrl));
    }
    return { bytes: await readCapped(res, name, viewUrl), mimeType: target.mime || type, fileName: safeName(name) };
  }

  /** GET que só segue redirect para hosts do Google; para o login do Google devolve `null` (arquivo privado). */
  private async getInsideGoogle(start: string): Promise<Response | null> {
    const doFetch = this.opts.fetchFn ?? fetch;
    let current = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = new URL(current);
      if (u.protocol !== 'https:' || !googleHost(u.hostname)) return null;
      const res = await doFetch(current, { redirect: 'manual', signal: this.signal() });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    return null;
  }
}

/** Sem `SECRETS_KEY` os `ref` não podem ser assinados: o recurso fica desligado (nenhum `ref` do Drive nasce). */
export class DisabledDriveDownloader extends DriveDownloader {
  owns(): boolean {
    return false;
  }
  isFolder(): boolean {
    return false;
  }
  viewUrl(): string | null {
    return null;
  }
  async download(): Promise<AttachmentContent> {
    throw new SourceError('UNAVAILABLE', 'Arquivos do Drive indisponíveis neste servidor.');
  }
  async inspect(): Promise<DriveFileInfo | null> {
    return null;
  }
  async listFolder(): Promise<DriveFolderEntry[] | null> {
    return null;
  }
}
