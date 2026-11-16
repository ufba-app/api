/**
 * Recusa de PERMISSÃO do ai-memory ("not authorized for docs: you have read access and this needs write", código -32603).
 * Só a classificação sai daqui: o texto do servidor nunca é repassado (pode ter nome interno ou conteúdo de trabalho).
 */
export type PermissionDenial = 'read_only' | 'no_access';

/** `null` quando o texto não é uma recusa de permissão (rede, 5xx e erros de uso seguem como estavam). */
export function classifyPermissionDenial(text: string): PermissionDenial | null {
  if (!/not authorized|needs write|you have read access/i.test(text)) return null;
  return /needs write|you have read access/i.test(text) ? 'read_only' : 'no_access';
}

/** Mensagem pt-BR para a pessoa; `scope` é `workspace/projeto` já validado contra o registro (ou vazio). */
export function denialMessage(kind: PermissionDenial, scope: string): string {
  const alvo = scope ? ` ${scope}` : '';
  return kind === 'read_only'
    ? `Você só tem leitura no projeto${alvo}. Para gravar, peça o papel de mantenedor a um administrador.`
    : `Você não tem acesso ao projeto${alvo}. Peça acesso a um administrador.`;
}
