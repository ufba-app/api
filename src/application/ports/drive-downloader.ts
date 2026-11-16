import type { Secret } from '../shared/secret';
import type { AttachmentContent } from './attachment-reader';

/** Conta do Google da pessoa (Classroom conectado) cujo token pode abrir arquivos do Drive. */
export interface DriveAccount {
  accountKey: string;
  refreshToken: Secret;
}

/** Por que um arquivo NÃO é baixado pelo serviço: vídeo (qualquer tamanho) ou acima do teto de memória. */
export type DriveBlock = 'video' | 'too_large';

/** O que se sabe de um arquivo ANTES de baixar (metadados: nome, tipo, tamanho). */
export interface DriveFileInfo {
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  /** Link para a PESSOA abrir no navegador. */
  viewUrl: string;
  blocked: DriveBlock | null;
  /** Texto pt-BR pronto para mostrar quando `blocked` (ex.: "Vídeo (350 MB): abra no navegador"). */
  message: string | null;
}

/** Um item do primeiro nível de uma pasta do Drive. `ref` só existe quando dá para baixar (assinado e preso à pessoa). */
export interface DriveFolderEntry extends DriveFileInfo {
  isFolder: boolean;
  ref: string | null;
  /** Rótulo curto para listas: "Aula 1.mp4 (vídeo, 350 MB)", "Material (subpasta)" ou só o nome. */
  label: string;
}

/**
 * Baixa arquivos do Drive linkados no conteúdo do Moodle. `ref` é o que `ver_curso`/`ver_forum` entregaram: só ele vale
 * (assinado e preso à pessoa); URL arbitrária nunca. Tenta o token da pessoa e, sem acesso, o link público.
 */
export abstract class DriveDownloader {
  abstract owns(ref: string): boolean;
  /** `ref` de uma PASTA (que `ver_curso` expande em anexos)? */
  abstract isFolder(ref: string): boolean;
  /** O link para a PESSOA abrir no navegador (nunca para buscar). `null` se o `ref` não é íntegro ou não é desta pessoa. */
  abstract viewUrl(userId: string, ref: string): string | null;
  abstract download(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<AttachmentContent>;
  /** Metadados de UM arquivo sem baixar; `null` quando não há como saber (sem acesso por token e sem chave pública). */
  abstract inspect(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<DriveFileInfo | null>;
  /**
   * Primeiro nível de uma pasta (teto de itens), com token da pessoa e, sem acesso, pela API pública (se o servidor tem chave).
   * Os `ref` dos filhos nascem aqui, assinados para a MESMA pessoa: o `ref` da pasta que veio do curso autoriza os filhos listados.
   * `null` quando não foi possível listar.
   */
  abstract listFolder(userId: string, ref: string, accounts: readonly DriveAccount[]): Promise<DriveFolderEntry[] | null>;
}
