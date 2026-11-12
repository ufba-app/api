import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

/** Endereços que um servidor público nunca deveria resolver: rede interna, loopback, link-local, multicast etc. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedAddress(mapped[1]);
    return (
      s.startsWith('::ffff:') || // mapeado em hexa (::ffff:7f00:1)
      s.startsWith('64:ff9b:') || // NAT64
      s.startsWith('2002:') || // 6to4
      s.startsWith('fec') ||
      s.startsWith('fed') ||
      s.startsWith('fee') ||
      s.startsWith('fef') ||
      /^::[0-9a-f.]*$/.test(s) || // ::/96 (inclui ::, ::1 e IPv4 compatível)
      s === '::' ||
      s === '::1' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      s.startsWith('fe8') ||
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('ff')
    );
  }
  return true;
}

export class SafeFetchError extends Error {}

export interface SafeResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * Resolve o DNS e recusa endereços internos NA HORA DA CONEXÃO (o mesmo IP que foi checado é o usado): sem brecha
 * de DNS rebinding.
 */
function guardedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return cb(new SafeFetchError('endereço bloqueado'));
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/**
 * GET para URLs que vêm de terceiros (documento de metadados e logo de cliente OAuth): só https na porta 443, sem
 * credenciais na URL, sem seguir redirect, com tempo e tamanho máximos.
 */
export function safeGet(url: string, opts: { maxBytes: number; timeoutMs: number; accept: string }): Promise<SafeResponse> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.reject(new SafeFetchError('URL inválida'));
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
    return Promise.reject(new SafeFetchError('só https na porta 443'));
  }
  // IP literal: recusado sempre. O Node não passa IP literal pelo `lookup` (a checagem abaixo não roda), e formas como
  // `[::ffff:7f00:1]` escapam de checagem por texto.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return Promise.reject(new SafeFetchError('endereço bloqueado: use um nome de domínio'));

  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: 'GET',
        headers: { accept: opts.accept, 'user-agent': 'ufba-platform' },
        lookup: guardedLookup as never,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new SafeFetchError(`HTTP ${status}`));
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new SafeFetchError('grande demais'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new SafeFetchError('grande demais'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new SafeFetchError('tempo esgotado')), opts.timeoutMs);
    req.on('timeout', () => req.destroy(new SafeFetchError('tempo esgotado')));
    req.on('error', (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError('falha de rede')));
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}
