import type { AttachmentContent } from '../../../application/ports/attachment-reader';
import { DriveDownloader, type DriveAccount } from '../../../application/ports/drive-downloader';
import { SourceError } from '../../../application/ports/source-gateway';
import type { DriveLink } from '../../../domain/drive/drive-link';
import { appDaConta } from '../classroom/classroom-link';
import { GoogleApiError, type GoogleHttp } from '../google/google-http';
import { DriveRefs } from './drive-refs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;
export const DRIVE_TIMEOUT_MS = 30_000;
const MAX_HOPS = 5;

/** Exportação dos nativos do Google (decisão do André): Docs e Apresentações → PDF; Planilhas → XLSX. */
const EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: PDF, ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mime: PDF, ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: XLSX, ext: '.xlsx' },
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

function tooLarge(): SourceError {
  return new SourceError('UNSUPPORTED_SCOPE', `Arquivo do Drive maior que ${MAX_DRIVE_BYTES / 1024 / 1024} MB: abra pelo navegador.`);
}

/** Lê o corpo até o teto (aborta o resto). Nada é guardado além dos bytes devolvidos. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DRIVE_BYTES) throw tooLarge();
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
      throw tooLarge();
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
 * Baixa arquivos do Drive linkados no Moodle. Ordem: token da pessoa (Classroom conectado, `drive.readonly`) e, se nenhuma
 * conta abrir, o link público (sem login). Só fala com hosts do Google; redirect só dentro deles (redirect para o login do
 * Google = arquivo privado); teto de 25 MB e 30 s. Nada é guardado, nada de conteúdo vai para log ou erro.
 */
export class GoogleDriveDownloader extends DriveDownloader {
  constructor(
    private readonly refs: DriveRefs,
    private readonly clientes: { ufba?: GoogleHttp; convidado?: GoogleHttp },
    private readonly opts: { dominio?: string; fetchFn?: FetchFn } = {},
  ) {
    super();
  }

  owns(ref: string): boolean {
    return this.refs.owns(ref);
  }

  async download(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<AttachmentContent> {
    const link = this.refs.verify(userId, ref);
    if (!link) {
      throw new SourceError('UNSUPPORTED_SCOPE', 'Este anexo do Drive não veio do seu curso (ou mudou). Peça o conteúdo do curso de novo.');
    }
    const dominio = this.opts.dominio ?? 'ufba.br';
    // A conta @ufba.br primeiro: é a que costuma ter acesso aos arquivos dos professores.
    const ordered = [...accounts].sort((a, b) => Number(b.accountKey.endsWith(`@${dominio}`)) - Number(a.accountKey.endsWith(`@${dominio}`)));
    let transient = false;
    for (const a of ordered) {
      const http = this.clientes[appDaConta(a.accountKey, dominio)];
      if (!http) continue;
      try {
        return await this.viaApi(http, a, link);
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

  private signal(): AbortSignal {
    return AbortSignal.timeout(DRIVE_TIMEOUT_MS);
  }

  private async viaApi(http: GoogleHttp, a: DriveAccount, link: DriveLink): Promise<AttachmentContent> {
    const url = `${DRIVE_API}/${encodeURIComponent(link.id)}`;
    const metaRes = await http.get(a.refreshToken, url, { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' }, { signal: this.signal() });
    const meta = (await metaRes.json()) as { name?: string; mimeType?: string; size?: string };
    const mime = meta.mimeType ?? 'application/octet-stream';
    if (meta.size && Number(meta.size) > MAX_DRIVE_BYTES) throw tooLarge();
    const name = meta.name || `drive-${link.id.slice(0, 8)}`;
    const exp = EXPORT[mime];
    if (exp) {
      const res = await http.get(a.refreshToken, `${url}/export`, { mimeType: exp.mime }, { signal: this.signal() });
      return { bytes: await readCapped(res), mimeType: exp.mime, fileName: safeName(name.toLowerCase().endsWith(exp.ext) ? name : name + exp.ext) };
    }
    if (mime.startsWith('application/vnd.google-apps.')) {
      throw new SourceError('UNSUPPORTED_SCOPE', 'Este tipo de arquivo do Google (pasta, formulário, desenho…) não pode ser baixado.');
    }
    const res = await http.get(a.refreshToken, url, { alt: 'media', supportsAllDrives: 'true' }, { signal: this.signal() });
    return { bytes: await readCapped(res), mimeType: mime, fileName: safeName(name) };
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
    return {
      bytes: await readCapped(res),
      mimeType: target.mime || type,
      fileName: safeName(fileNameFrom(res) ?? `drive-${link.id.slice(0, 8)}${target.ext}`),
    };
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
  async download(): Promise<AttachmentContent> {
    throw new SourceError('UNAVAILABLE', 'Arquivos do Drive indisponíveis neste servidor.');
  }
}
