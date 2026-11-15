import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  ContaAmbiguaError,
  FonteNaoConectadaError,
  FonteSemLeituraError,
} from '../../application/live/consulta.service';
import { LinkError } from '../../application/oauth/oauth-ports';
import { SourceError } from '../../application/ports/source-gateway';
import { ApiError } from '../../application/web/web-api';
import { clearSignedInMarker } from './web-auth';

const LINK_STATUS: Record<LinkError['code'], number> = {
  invalid_request: 400,
  invalid_credentials: 422,
  too_many_attempts: 429,
  source_unavailable: 502,
  source_account_taken: 409,
  source_account_mismatch: 409,
  source_account_not_owned: 403,
};

/** Traduz qualquer erro para `{ error, message }`. Mensagens internas (500) nunca vão para fora. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof LinkError) return new ApiError(LINK_STATUS[e.code], e.code, e.message);
  if (e instanceof FonteNaoConectadaError) return new ApiError(409, 'source_not_connected', e.message);
  if (e instanceof ContaAmbiguaError) return new ApiError(409, 'account_ambiguous', e.message);
  if (e instanceof FonteSemLeituraError) return new ApiError(501, 'not_supported', e.message);
  if (e instanceof SourceError) {
    if (e.code === 'UNSUPPORTED_SCOPE') return new ApiError(400, 'invalid_request', e.message);
    return new ApiError(502, 'source_unavailable', e.message);
  }
  if (e instanceof HttpException) {
    const status = e.getStatus();
    if (status === 404) return new ApiError(404, 'not_found', 'Recurso não encontrado.');
    if (status < 500) return new ApiError(status, 'invalid_request', 'Pedido inválido.');
  }
  return new ApiError(500, 'internal_error', 'Erro inesperado. Tente de novo em instantes.');
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('WebApi');

  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const api = toApiError(e);
    // Só o tipo e a mensagem do erro inesperado: nada de corpo de requisição (pode ter senha).
    if (api.status >= 500 && !(e instanceof SourceError)) {
      this.log.error(`${e instanceof Error ? e.name : typeof e}: ${e instanceof Error ? e.message : ''}`);
    }
    if (res.headersSent) return;
    // Sessão vencida: o marcador "há sessão" não vale mais (o cookie de sessão a API já não aceita).
    if (api.status === 401 && api.code === 'session_expired') clearSignedInMarker(res);
    res.status(api.status).setHeader('Cache-Control', 'no-store').json({ error: api.code, message: api.message });
  }
}
