import { createHmac } from 'node:crypto';
import type { SourceSubject } from '../../domain/identity/source-binding';
import { SubjectHasher } from '../../application/ports/repositories';
import { deriveKey } from './keys';

const PURPOSE = 'ufba-platform/source-binding/v1';

/**
 * HMAC-SHA256 do titular (CPF, usuário do AVA) com chave derivada da `SECRETS_KEY`. Estável (o vínculo depende disso:
 * NÃO troque a SECRETS_KEY) e não reversível sem a chave: o CPF não fica exposto na tabela de vínculos.
 */
export class HmacSubjectHasher extends SubjectHasher {
  private key?: Buffer;

  constructor(private readonly rawKey: string | undefined = process.env.SECRETS_KEY) {
    super();
  }

  hash(subject: SourceSubject): string {
    this.key ??= deriveKey(this.rawKey, PURPOSE);
    return createHmac('sha256', this.key).update(`${subject.source}:${subject.value}`).digest('base64url');
  }
}
