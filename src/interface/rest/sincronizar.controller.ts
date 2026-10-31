import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpStatus,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { InvalidAccountError } from '../../application/identity/identity.service';
import {
  Provider,
  SourceError,
  SourceRegistry,
  SyncScope,
} from '../../application/ports/source-gateway';
import {
  AccountNotConnectedError,
  MissingCredentialsError,
  SincronizarResult,
  SincronizarService,
  SourceNotRegisteredError,
} from '../../application/sync/sincronizar.service';
import { BearerGuard, CurrentUserId } from './auth.guard';

const PROVIDERS: Record<string, Provider> = {
  sigaa: 'SIGAA',
  moodle: 'MOODLE',
  classroom: 'CLASSROOM',
  calendar: 'CALENDAR',
};

export interface SincronizarBody {
  fonte?: string;
  alcance?: { tipo?: string; curso?: string; item?: string };
  /** Só para o SIGAA: usada em memória e descartada. */
  usuario?: string;
  senha?: string;
  conta?: string;
}

export function parseProvider(value: unknown): Provider {
  const p = typeof value === 'string' ? PROVIDERS[value.toLowerCase()] : undefined;
  if (!p) {
    throw new BadRequestException(
      `fonte inválida; use uma de: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return p;
}

function parseScope(a: SincronizarBody['alcance']): SyncScope {
  const tipo = a?.tipo ?? 'tudo';
  if (tipo === 'tudo') return { kind: 'tudo' };
  if (tipo === 'curso' && a?.curso) return { kind: 'curso', courseExternalId: a.curso };
  if (tipo === 'item' && a?.curso && a?.item) {
    return { kind: 'item', courseExternalId: a.curso, itemExternalId: a.item };
  }
  throw new BadRequestException(
    'alcance inválido: {tipo:"tudo"} | {tipo:"curso",curso} | {tipo:"item",curso,item}',
  );
}

/** Traduz erros de aplicação em HTTP. Nunca devolve nem registra o corpo da requisição (pode ter a senha). */
@Catch(
  SourceNotRegisteredError,
  AccountNotConnectedError,
  MissingCredentialsError,
  InvalidAccountError,
  SourceError,
)
export class ApplicationErrorFilter implements ExceptionFilter {
  catch(err: Error, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'ERRO';
    if (err instanceof SourceNotRegisteredError) {
      status = HttpStatus.NOT_IMPLEMENTED;
      code = 'FONTE_INDISPONIVEL';
    } else if (err instanceof AccountNotConnectedError) {
      status = HttpStatus.CONFLICT;
      code = 'CONTA_NAO_CONECTADA';
    } else if (err instanceof MissingCredentialsError || err instanceof InvalidAccountError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'CREDENCIAIS_AUSENTES';
    } else if (err instanceof SourceError) {
      code = err.code;
      status =
        err.code === 'CREDENTIAL_REJECTED' || err.code === 'REAUTH_NEEDED'
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : err.code === 'UNSUPPORTED_SCOPE'
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.BAD_GATEWAY;
    }
    // A mensagem de SourceError é de responsabilidade do gateway (sem segredos); as demais são nossas.
    res.status(status).json({ erro: code, mensagem: err.message });
  }
}

@Controller()
@UseGuards(BearerGuard)
@UseFilters(ApplicationErrorFilter)
export class SincronizarController {
  constructor(
    private readonly sincronizarService: SincronizarService,
    private readonly registry: SourceRegistry,
  ) {}

  /** Fontes disponíveis neste servidor e como cada uma autentica. */
  @Get('fontes')
  fontes(): Array<{ fonte: string; autenticacao: string }> {
    return this.registry
      .list()
      .map((g) => ({ fonte: g.provider.toLowerCase(), autenticacao: g.auth }));
  }

  /** Único comando que vai às fontes. */
  @Post('sincronizar')
  async sincronizar(
    @CurrentUserId() userId: string,
    @Body() body: SincronizarBody,
  ): Promise<Omit<SincronizarResult, 'provider'> & { fonte: string }> {
    const provider = parseProvider(body?.fonte);
    const senha =
      body?.usuario && body?.senha
        ? { username: body.usuario, password: body.senha }
        : undefined;
    const r = await this.sincronizarService.sincronizar({
      userId,
      provider,
      alcance: parseScope(body?.alcance),
      senha,
      accountKey: body?.conta,
    });
    return {
      fonte: provider.toLowerCase(),
      syncRunId: r.syncRunId,
      counts: r.counts,
      atualizadoEm: r.atualizadoEm,
    };
  }
}
