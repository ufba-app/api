/** Referência a um anexo na fonte (só metadados; o conteúdo é buscado sob demanda). */
export interface AttachmentRef {
  externalId?: string | null;
  name?: string;
  mimeType?: string | null;
  sourceUrl?: string | null;
}

export interface AttachmentContent {
  bytes: Uint8Array;
  mimeType: string;
  /** Nome sugerido (com extensão, se exportado). */
  fileName?: string;
}

/** Porta: baixa o conteúdo de um anexo na fonte, sob demanda. */
export interface AttachmentReader {
  read(credentials: { refreshToken: string }, ref: AttachmentRef): Promise<AttachmentContent>;
}
