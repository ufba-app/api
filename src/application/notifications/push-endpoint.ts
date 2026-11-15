/**
 * O servidor faz POST no endpoint que o aparelho informou. Para não virar um "faça requisição para qualquer lugar" (SSRF),
 * só valem os serviços de push dos navegadores: https, sem usuário/senha, porta padrão e um destes hosts.
 */
const ALLOWED_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge, Opera, Samsung, Brave (FCM)
  /^updates(-autopush)?\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.apple\.com$/, // Safari (macOS, iOS 16.4+)
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge antigo (WNS)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((re) => re.test(host));
}
