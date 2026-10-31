import type { Request } from 'express';

/** URL pública do serviço: `PUBLIC_URL` se definida (atrás de proxy), senão deduzida da requisição. */
export function baseUrl(req: Request): string {
  const fixed = process.env.PUBLIC_URL;
  if (fixed) return fixed.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
