/** Hosts de loopback do RFC 8252: o cliente nativo escolhe uma porta livre a cada autorização. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

const isLoopbackHttp = (u: URL): boolean => u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);

/**
 * O redirect volta para a PRÓPRIA máquina da pessoa? Loopback http (`localhost`, `127.0.0.1`, `[::1]`) ou esquema privado de app
 * nativo (`cursor://`, `com.exemplo.app:/cb`). Diz PARA ONDE o código vai, não QUEM é o cliente: não é verificação.
 */
export function isLocalRedirect(uri: string): boolean {
  const u = parse(uri);
  if (!u) return false;
  return isLoopbackHttp(u) || (u.protocol !== 'http:' && u.protocol !== 'https:');
}

/**
 * O `redirect_uri` pedido está entre os registrados? Comparação EXATA, com uma única exceção (RFC 8252 §7.3 e §8.3):
 * para `http` em loopback (`localhost`, `127.0.0.1`, `[::1]`) a PORTA é ignorada, porque o app nativo usa uma porta
 * aleatória por autorização. Exige scheme, host, path e query iguais (o host não é trocado por outro loopback: `localhost`
 * não vale por `127.0.0.1`). Sem credenciais na URL e sem fragmento. `https` e qualquer host que não seja loopback
 * continuam exatos, inclusive com porta.
 */
export function redirectUriAllowed(registered: readonly string[], requested: string | undefined): boolean {
  if (!requested) return false;
  if (registered.includes(requested)) return true;
  const want = parse(requested);
  if (!want || !isLoopbackHttp(want) || want.username || want.password || want.hash) return false;
  return registered.some((r) => {
    const have = parse(r);
    return (
      have !== null &&
      isLoopbackHttp(have) &&
      !have.username &&
      !have.password &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}
