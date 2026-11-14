import type { EncryptedSecret } from './repositories';

/** Cifra segredos de fontes com token guardado (Moodle, Google). e o cookie de sessão do SIGAA. A SENHA do SIGAA nunca passa por aqui (usa a chave K do cliente). */
export abstract class SecretCipher {
  abstract encrypt(plain: string): EncryptedSecret;
  abstract decrypt(secret: EncryptedSecret): string;
}
