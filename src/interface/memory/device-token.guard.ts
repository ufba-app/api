import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DeviceAuthorizations, DeviceTokenGrant } from '../../application/memory/device-authorizations';
import { ApiError } from '../../application/web/web-api';

export type DeviceRequest = Request & { device?: DeviceTokenGrant };

/**
 * Bearer = token curto do instalador (emitido pelo device flow; 10 min). Só abre as rotas `/memory/computers`:
 * não é um token OAuth do serviço, então nenhum outro autenticador o aceita (nem o /mcp).
 */
@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(private readonly device: DeviceAuthorizations) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DeviceRequest>();
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    const grant = m ? await this.device.verifyToken(m[1]) : null;
    if (!grant) throw new ApiError(401, 'session_expired', 'A autorização do instalador expirou. Rode o instalador de novo.');
    req.device = grant;
    return true;
  }
}
