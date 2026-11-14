import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tls from 'node:tls';

/**
 * Acrescenta às CAs padrão do Node os certificados `.pem` de `certs/` (ou `EXTRA_CA_DIR`).
 *
 * Por quê: o servidor do AVA (ava.ufba.br) não envia o certificado intermediário
 * "RNP ICPEdu GR46 OV TLS CA 2025". Navegadores buscam o intermediário sozinhos; o Node não, e falha com
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE. Só entram CAs intermediárias públicas; a raiz (GlobalSign Root R46) já é do Node,
 * então a cadeia continua sendo verificada normalmente.
 *
 * Chamar ANTES de qualquer conexão TLS (início do main.ts). Requer Node >= 22.19 (`tls.setDefaultCACertificates`).
 */
export function loadExtraCAs(dir = process.env.EXTRA_CA_DIR ?? resolve(process.cwd(), 'certs')): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.pem'));
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const setDefault = (tls as { setDefaultCACertificates?: (certs: string[]) => void }).setDefaultCACertificates;
  const getCAs = (tls as { getCACertificates?: (type: string) => string[] }).getCACertificates;
  if (typeof setDefault !== 'function' || typeof getCAs !== 'function') {
    console.warn(`[tls] Node ${process.version} sem setDefaultCACertificates: use NODE_EXTRA_CA_CERTS com ${dir}`);
    return [];
  }
  const extra = files.map((f) => readFileSync(join(dir, f), 'utf8'));
  setDefault([...getCAs('default'), ...extra]);
  return files;
}
