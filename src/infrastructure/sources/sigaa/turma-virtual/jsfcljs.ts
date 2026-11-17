const JSFCLJS = /jsfcljs\(\s*document\.getElementById\('([^']+)'\)\s*,\s*\{([^}]*)\}/;
const PAR = /'([^']*)'\s*:\s*'([^']*)'/g;

/**
 * O `jsfcljs(document.getElementById('<form>'),{'k':'v',…},'')` do `onclick` de um link JSF: o form que o clique
 * submete e os parâmetros que ele soma aos campos do form. `null` quando o `onclick` não tem esse padrão.
 */
export function lerJsfcljs(onclick: string): { form: string; params: Record<string, string> } | null {
  const m = JSFCLJS.exec(onclick);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const [, k, v] of m[2].matchAll(PAR)) params[k] = v;
  return { form: m[1], params };
}
