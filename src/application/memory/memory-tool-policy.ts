/**
 * Classificação das ferramentas do ai-memory 3.4.6 (spike S5). Lista de permissão por NOME, padrão negar: uma
 * ferramenta nova (versão nova do memory) só aparece depois de alguém classificá-la aqui. As anotações do servidor
 * (`readOnlyHint`) não valem: `memory_install_self_routing` se declara somente-leitura e instala na máquina.
 */
export type MemoryToolClass = 'read' | 'write' | 'destructive' | 'host' | 'house';

export const MEMORY_TOOL_CLASSES: Readonly<Record<string, MemoryToolClass>> = {
  memory_briefing: 'read',
  memory_explore: 'read',
  memory_handoff_list: 'read',
  memory_message_list: 'read',
  memory_query: 'read',
  memory_read_page: 'read',
  memory_read_session_observations: 'read',
  memory_recent: 'read',
  memory_resolve_write_target: 'read',

  memory_write_page: 'write',
  memory_handoff_begin: 'write',
  memory_handoff_accept: 'write',
  memory_message_send: 'write',
  memory_message_pop: 'write',
  memory_patch_page: 'write',
  memory_write_pages_batch: 'write',
  memory_feedback: 'write',
  memory_consolidate: 'write',

  memory_delete_page: 'destructive',
  memory_restore_page: 'destructive',
  memory_forget_sweep: 'destructive',
  memory_handoff_cancel: 'destructive',
  memory_message_cancel: 'destructive',

  memory_install_self_routing: 'host',
  memory_auto_improve: 'host',
  memory_lint: 'host',

  // Nome que colide: o do memory NÃO é repassado; vale o da casa, que lê o estado da ufba.app.
  memory_status: 'house',
  // Ferramenta da casa que o memory não tem; se um dia tiver, a da casa vale.
  memory_connect_computer: 'house',
};

export function classOf(name: string): MemoryToolClass | undefined {
  return Object.prototype.hasOwnProperty.call(MEMORY_TOOL_CLASSES, name) ? MEMORY_TOOL_CLASSES[name] : undefined;
}

/** Só `read` e `write` passam pelo proxy. */
export function isForwardable(name: string): boolean {
  const c = classOf(name);
  return c === 'read' || c === 'write';
}

/** Nomes do catálogo do memory que ninguém classificou (o teste de contrato exige lista vazia). */
export function unclassified(names: readonly string[]): string[] {
  return names.filter((n) => classOf(n) === undefined);
}
