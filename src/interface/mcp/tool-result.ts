export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Erro de ferramenta: só a mensagem (os casos de uso já não carregam senha nem token). */
export function falha(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown })?.code;
  return {
    isError: true,
    content: [{ type: 'text' as const, text: typeof code === 'string' ? `${code}: ${msg}` : msg }],
  };
}

export async function run<T>(fn: () => Promise<T>) {
  try {
    return json(await fn());
  } catch (e) {
    return falha(e);
  }
}
