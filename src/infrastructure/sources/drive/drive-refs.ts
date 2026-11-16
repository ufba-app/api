import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DriveKind, DriveLink } from '../../../domain/drive/drive-link';
import { deriveKey } from '../../crypto/keys';

const PURPOSE = 'ufba-platform/drive-ref/v1';
export const DRIVE_REF_PREFIX = 'gdrive1.';
const KINDS: readonly DriveKind[] = ['file', 'doc', 'sheet', 'slides'];

/**
 * `ref` de um arquivo do Drive extraído do conteúdo do Moodle: `gdrive1.<tipo>.<id>.<assinatura>`. A assinatura (HMAC com
 * chave derivada da `SECRETS_KEY`, presa à PESSOA) prova que o `ref` saiu de um `ver_curso`/`ver_forum` desta pessoa: o
 * agente não consegue fabricar o `ref` de um arquivo qualquer do Drive. É a garantia de "só baixa links que apareceram no curso".
 */
export class DriveRefs {
  private key?: Buffer;

  constructor(private readonly rawKey: string | undefined = process.env.SECRETS_KEY) {}

  private sig(userId: string, kind: string, id: string): string {
    this.key ??= deriveKey(this.rawKey, PURPOSE);
    return createHmac('sha256', this.key).update(`${userId}|${kind}|${id}`).digest('base64url').slice(0, 32);
  }

  sign(userId: string, link: DriveLink): string {
    return `${DRIVE_REF_PREFIX}${link.kind}.${link.id}.${this.sig(userId, link.kind, link.id)}`;
  }

  owns(ref: string): boolean {
    return ref.startsWith(DRIVE_REF_PREFIX);
  }

  /** O link, se o `ref` é íntegro e É desta pessoa; senão `null`. */
  verify(userId: string, ref: string): DriveLink | null {
    if (!this.owns(ref)) return null;
    const parts = ref.slice(DRIVE_REF_PREFIX.length).split('.');
    if (parts.length !== 3) return null;
    const [kind, id, sig] = parts;
    if (!(KINDS as readonly string[]).includes(kind) || !/^[A-Za-z0-9_-]{10,128}$/.test(id)) return null;
    const want = Buffer.from(this.sig(userId, kind, id));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got) ? { kind: kind as DriveKind, id } : null;
  }
}
