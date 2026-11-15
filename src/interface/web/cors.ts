/**
 * Métodos que o CORS libera para o painel. Toda rota do contrato (`ROUTES`) precisa estar aqui: um método fora da lista
 * faz o navegador bloquear o preflight ("Não deu para falar com o ufba.app"). `test/cors.spec.ts` quebra se faltar.
 */
export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
