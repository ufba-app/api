import type { EncryptedSecret } from './repositories';

/** Cifra segredos de fontes com token guardado (Moodle, Google). e o cookie de sessão do SIGAA. A SENHA do SIGAA nunca passa por aqui (usa a chave K do cliente). */
export abstract class SecretCipher {
  /** `aad` (dado associado autenticado, opcional) amarra o cifrado ao contexto: sem o mesmo `aad`, não abre. */
  abstract encrypt(plain: string, aad?: string): EncryptedSecret;
  abstract decrypt(secret: EncryptedSecret, aad?: string): string;
}
