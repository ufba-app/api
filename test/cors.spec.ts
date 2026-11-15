import { CORS_METHODS } from '../src/interface/web/cors';
import { ROUTES } from '../src/interface/web/openapi';

describe('CORS', () => {
  it('libera todo método usado por uma rota do contrato (senão o preflight do painel é bloqueado)', () => {
    const usados = new Set(ROUTES.map((r) => r.method.toUpperCase()));
    const liberados = new Set<string>(CORS_METHODS);
    const faltando = [...usados].filter((m) => !liberados.has(m));
    expect(faltando).toEqual([]);
  });

  it('inclui PUT e PATCH (consentimento da vida acadêmica, papéis, membros e computadores da memória)', () => {
    expect(CORS_METHODS).toEqual(expect.arrayContaining(['PUT', 'PATCH']));
  });
});
