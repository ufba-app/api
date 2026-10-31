import { Injectable } from '@nestjs/common';
import { AttachmentLookup, AttachmentReaders } from '../ports/academic-ports';
import { SourceAccountRepository } from '../ports/repositories';
import { SecretCipher } from '../ports/secret-cipher';
import type { SourceContext } from '../ports/source-gateway';

export class AnexoNaoEncontradoError extends Error {}
export class AnexoIndisponivelError extends Error {}

/** Teto do que devolvemos inline por ferramenta/REST (o leitor já recusa acima de 25 MB). */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export interface AnexoLido {
  nome: string;
  mimeType: string;
  conteudo: string;
  codificacao: 'texto' | 'base64';
}

const TEXTUAL = /^(text\/|application\/(json|xml|csv))/;

/**
 * Lê o conteúdo de um anexo NA FONTE, sob demanda (o banco só tem metadados). Não é leitura do banco: vai à fonte
 * com o token guardado do próprio usuário. O token nunca é devolvido nem logado.
 */
@Injectable()
export class AnexoService {
  constructor(
    private readonly lookup: AttachmentLookup,
    private readonly accounts: SourceAccountRepository,
    private readonly cipher: SecretCipher,
    private readonly readers: AttachmentReaders,
  ) {}

  async ler(userId: string, itemId: string, attachmentId: string): Promise<AnexoLido> {
    const loc = await this.lookup.find(userId, itemId, attachmentId);
    if (!loc) throw new AnexoNaoEncontradoError('anexo não encontrado');

    const reader = this.readers.get(loc.provider);
    if (!reader) throw new AnexoIndisponivelError(`a fonte ${loc.provider} não oferece leitura de anexos`);

    const account = (await this.accounts.listByUser(userId)).find((a) => a.id === loc.sourceAccountId);
    if (!account?.secret) throw new AnexoIndisponivelError('conta da fonte sem token guardado; reconecte-a');

    const ctx: SourceContext = {
      userId,
      accountKey: account.accountKey,
      siteUrl: account.siteUrl ?? undefined,
      credentials: { kind: 'token', token: this.cipher.decrypt(account.secret) },
    };
    const content = await reader.read(ctx, loc.ref);
    if (content.bytes.byteLength > MAX_INLINE_BYTES) {
      throw new AnexoIndisponivelError(`anexo maior que ${MAX_INLINE_BYTES} bytes`);
    }
    const textual = TEXTUAL.test(content.mimeType);
    return {
      nome: content.fileName ?? loc.ref.name ?? 'anexo',
      mimeType: content.mimeType,
      conteudo: Buffer.from(content.bytes).toString(textual ? 'utf8' : 'base64'),
      codificacao: textual ? 'texto' : 'base64',
    };
  }
}
