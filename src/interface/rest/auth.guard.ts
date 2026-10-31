import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AUTHENTICATORS,
  type Authenticator,
} from '../../application/ports/authenticator';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
}

/** `Authorization: Bearer <token>`: tenta cada autenticador (chave de API, token OAuth...) e fixa `req.userId`. */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATORS) private readonly authenticators: Authenticator[],
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/i.exec(header) : null;
    if (!match) throw new UnauthorizedException('Authorization: Bearer ausente');
    for (const auth of this.authenticators) {
      const found = await auth.authenticate(match[1].trim());
      if (found) {
        req.userId = found.userId;
        return true;
      }
    }
    throw new UnauthorizedException('Credencial inválida');
  }
}

/** Id do usuário autenticado (use com `@UseGuards(BearerGuard)`). */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<AuthedRequest>().userId as string,
);
