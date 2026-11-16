import type { Secret } from '../shared/secret';
import type { AttachmentContent } from './attachment-reader';

/** Conta do Google da pessoa (Classroom conectado) cujo token pode abrir arquivos do Drive. */
export interface DriveAccount {
  accountKey: string;
  refreshToken: Secret;
}

/**
 * Baixa arquivos do Drive linkados no conteúdo do Moodle. `ref` é o que `ver_curso`/`ver_forum` entregaram: só ele vale
 * (assinado e preso à pessoa); URL arbitrária nunca. Tenta o token da pessoa e, sem acesso, o link público.
 */
export abstract class DriveDownloader {
  abstract owns(ref: string): boolean;
  abstract download(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<AttachmentContent>;
}
