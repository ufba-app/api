import type { EncryptedSecret } from './repositories';

/** Cifra segredos de fontes com token guardado (Moodle, Google). Nunca usada para SIGAA. */
export abstract class SecretCipher {
  abstract encrypt(plain: string): EncryptedSecret;
  abstract decrypt(secret: EncryptedSecret): string;
}
