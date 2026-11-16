import { classOf } from './memory-tool-policy';
import type { RemoteTool } from './memory-ports';

/**
 * Metadados exigidos pela loja de conectores do Claude: toda propriedade do `inputSchema` com `type`, e cada ferramenta com
 * `title` e `annotations` (`readOnlyHint` ou `destructiveHint`). As ferramentas do ai-memory chegam sem isso em alguns
 * campos, e as anotações do servidor NÃO valem (ver `memory-tool-policy.ts`): a classificação da casa é que manda.
 */

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOfValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return 'string';
}

const COMBINATORS = ['anyOf', 'oneOf', 'allOf'] as const;

/** Segue `$ref` local (`#/$defs/X`, `#/definitions/X`) até o schema de destino (no máximo 8 saltos). */
function resolveRef(s: Json, root: Json): Json {
  let cur = s;
  for (let i = 0; i < 8 && typeof cur.$ref === 'string'; i++) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(cur.$ref);
    const target = m && isObj(root[m[1]]) ? (root[m[1]] as Json)[m[2]] : undefined;
    if (!isObj(target)) return cur;
    cur = target;
  }
  return cur;
}

/**
 * Tipos que o schema declara, direta ou indiretamente: `type`, valores de `enum`/`const`, destino de `$ref` e a UNIÃO dos
 * tipos das alternativas de `anyOf`/`oneOf`/`allOf` (é o caso de `Option<enum>` no Rust: `anyOf: [{enum}, {type: null}]`).
 */
function typesOf(s: Json, root: Json, depth = 0): string[] {
  if (depth > 8) return [];
  const r = resolveRef(s, root);
  if (typeof r.type === 'string') return [r.type];
  if (Array.isArray(r.type)) return r.type.filter((t): t is string => typeof t === 'string');
  const values = Array.isArray(r.enum) ? r.enum : 'const' in r ? [r.const] : null;
  if (values && values.length > 0) return [...new Set(values.map(typeOfValue))];
  const fromAlternatives = COMBINATORS.flatMap((k) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter(isObj).flatMap((m) => typesOf(m, root, depth + 1)) : []));
  if (fromAlternatives.length > 0) return [...new Set(fromAlternatives)];
  if (isObj(r.properties) || 'required' in r || 'additionalProperties' in r) return ['object'];
  if ('items' in r) return ['array'];
  return [];
}

/**
 * Copia o schema dando `type` a toda propriedade, item ou sub-schema que não tem, NO PRÓPRIO NÍVEL (a loja do Claude
 * exige `type` ao lado de `anyOf`/`oneOf`/`$ref`, não só dentro das alternativas). O tipo vem do que o schema já diz;
 * as alternativas e o `enum` ficam como estão. Sem pista nenhuma, `string`. Não altera o original.
 */
export function withTypes(schema: unknown): unknown {
  if (!isObj(schema)) return schema;
  const root = schema;
  const fix = (s: unknown): unknown => {
    if (!isObj(s)) return s;
    const o: Json = { ...s };
    if (o.type === undefined) {
      const types = typesOf(o, root);
      o.type = types.length === 0 ? 'string' : types.length === 1 ? types[0] : types;
    }
    for (const k of ['items', 'additionalProperties', 'not']) if (isObj(o[k])) o[k] = fix(o[k]);
    if (Array.isArray(o.items)) o.items = (o.items as unknown[]).map(fix);
    for (const k of ['properties', 'patternProperties', '$defs', 'definitions']) {
      const m = o[k];
      if (isObj(m)) o[k] = Object.fromEntries(Object.entries(m).map(([n, sub]) => [n, fix(sub)]));
    }
    for (const k of COMBINATORS) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(fix);
    return o;
  };
  const out = fix(root) as Json;
  if (out.type === undefined) out.type = 'object';
  return out;
}

/** Títulos (pt-BR) das ferramentas `memory_*`. */
const TITLES: Readonly<Record<string, string>> = {
  memory_status: 'Estado da memória',
  memory_connect_computer: 'Conectar computador',
  memory_briefing: 'Resumo do projeto na memória',
  memory_explore: 'Explorar a memória',
  memory_handoff_list: 'Listar passagens de bastão',
  memory_message_list: 'Listar mensagens',
  memory_query: 'Buscar na memória',
  memory_read_page: 'Ler página da memória',
  memory_read_session_observations: 'Ler observações de uma sessão',
  memory_recent: 'Páginas recentes da memória',
  memory_resolve_write_target: 'Resolver destino de gravação',
  memory_write_page: 'Gravar página na memória',
  memory_handoff_begin: 'Iniciar passagem de bastão',
  memory_handoff_accept: 'Aceitar passagem de bastão',
  memory_message_send: 'Enviar mensagem',
  memory_message_pop: 'Retirar mensagem da fila',
  memory_patch_page: 'Alterar trecho de página',
  memory_write_pages_batch: 'Gravar várias páginas',
  memory_feedback: 'Registrar feedback',
  memory_consolidate: 'Consolidar páginas',
  memory_delete_page: 'Apagar página',
  memory_restore_page: 'Restaurar página',
  memory_forget_sweep: 'Varrer e esquecer páginas',
  memory_handoff_cancel: 'Cancelar passagem de bastão',
  memory_message_cancel: 'Cancelar mensagem',
};

/**
 * Das gravações, só estas NÃO sobrescrevem nem consomem nada (acrescentam um registro novo); todas as outras `write`
 * substituem, alteram ou retiram conteúdo e por isso são `destructiveHint: true`.
 */
const ADDITIVE_WRITES: ReadonlySet<string> = new Set(['memory_handoff_begin', 'memory_handoff_accept', 'memory_message_send', 'memory_feedback']);

/** Anotações MCP de uma ferramenta de memória, pela classificação da casa (nunca pelas do servidor). */
export function memoryAnnotations(name: string): ToolAnnotations {
  const title = TITLES[name] ?? name;
  const cls = classOf(name);
  if (cls === 'read' || cls === 'house') return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  if (cls === 'write' && ADDITIVE_WRITES.has(name)) return { title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  return { title, readOnlyHint: false, destructiveHint: true, openWorldHint: false };
}

/** A ferramenta como vai para o cliente: schema com `type` em tudo, `title` e `annotations` da casa. */
export function decorateTool(tool: RemoteTool): RemoteTool {
  const annotations = memoryAnnotations(tool.name);
  return {
    ...tool,
    title: annotations.title,
    inputSchema: withTypes(tool.inputSchema) as Record<string, unknown>,
    annotations: { ...annotations } as Record<string, unknown>,
  };
}
