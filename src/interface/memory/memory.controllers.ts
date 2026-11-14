import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { DeviceAuthorizations } from '../../application/memory/device-authorizations';
import { InstallManifests, ManifestUnavailable } from '../../application/memory/install-manifest';
import { memoryPublicUrl } from '../../application/memory/memory-defaults';
import { MemoryComputers } from '../../application/memory/memory-computers';
import { DeviceCodeBody, DeviceDecisionBody, parseInput, RenameComputerBody } from '../../application/web/contract';
import { MemoryWeb } from '../../application/web/memory-web.service';
import { ApiError, invalidRequest, sessionExpired, type WebPrincipal } from '../../application/web/web-api';
import { ApiErrorFilter } from '../web/api-error.filter';
import { Principal, SessionGuard } from '../web/web-auth';
import { DeviceRequest, DeviceTokenGuard } from './device-token.guard';

const must = (p: WebPrincipal | null): WebPrincipal => {
  if (!p) throw sessionExpired();
  return p;
};

const ipOf = (req: Request): string | null => req.ip ?? null;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const view = (c: {
  id: string;
  name: string;
  os: string;
  agents: string[];
  installMode: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}) => ({
  id: c.id,
  name: c.name,
  os: c.os,
  agents: c.agents,
  installMode: c.installMode,
  createdAt: c.createdAt.toISOString(),
  lastSeenAt: iso(c.lastSeenAt),
  revokedAt: iso(c.revokedAt),
});

/** Memória no app web (cookie de sessão + CSRF). Contrato em `contract.ts`. */
@Controller('web')
@UseFilters(ApiErrorFilter)
@UseGuards(SessionGuard)
export class MemoryWebController {
  constructor(private readonly memory: MemoryWeb) {}

  @Post('device/lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async lookup(@Principal() p: WebPrincipal | null, @Body() b: unknown, @Req() req: Request) {
    const body = parseInput(DeviceCodeBody, b, invalidRequest);
    const r = await this.memory.lookup(must(p), ipOf(req), body.userCode);
    return { ...r, requestedAt: r.requestedAt.toISOString() };
  }

  @Post('device/decision')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async decision(@Principal() p: WebPrincipal | null, @Body() b: unknown, @Req() req: Request): Promise<void> {
    const body = parseInput(DeviceDecisionBody, b, invalidRequest);
    await this.memory.decide(must(p), ipOf(req), body.userCode, body.decision);
  }

  @Get('memory/status')
  @Header('Cache-Control', 'no-store')
  async status(@Principal() p: WebPrincipal | null) {
    const s = await this.memory.status(must(p));
    return { ...s, computers: s.computers.map(view) };
  }

  @Get('memory/computers')
  @Header('Cache-Control', 'no-store')
  async computers(@Principal() p: WebPrincipal | null) {
    return { computers: (await this.memory.list(must(p))).map(view) };
  }

  @Patch('memory/computers/:id')
  @HttpCode(204)
  async rename(@Principal() p: WebPrincipal | null, @Param('id') id: string, @Body() b: unknown): Promise<void> {
    await this.memory.rename(must(p), id, parseInput(RenameComputerBody, b, invalidRequest).name);
  }

  @Delete('memory/computers/:id')
  @HttpCode(204)
  async revoke(@Principal() p: WebPrincipal | null, @Param('id') id: string): Promise<void> {
    await this.memory.revoke(must(p), id);
  }
}

const CreateComputerBody = z.object({
  name: z.string().max(200).optional(),
  os: z.string().max(20),
  computer_id: z.string().max(64).optional(),
  agents: z.array(z.string().max(60)).max(40).optional(),
  client_version: z.string().max(60).optional(),
  install_mode: z.string().max(20).optional(),
});

/**
 * Rotas do instalador (fora do contrato do web). `POST /memory/computers` e `/confirm` usam o token curto do device
 * flow como Bearer; o manifesto é público. A chave sai uma única vez, com `no-store`, e nunca é guardada nem logada.
 */
@Controller('memory')
@UseFilters(ApiErrorFilter)
export class MemoryInstallerController {
  constructor(
    private readonly computers: MemoryComputers,
    private readonly device: DeviceAuthorizations,
    private readonly manifests: InstallManifests,
  ) {}

  @Get('install-manifest')
  @Header('Cache-Control', 'public, max-age=300')
  async manifest() {
    try {
      return await this.manifests.get();
    } catch (e) {
      if (e instanceof ManifestUnavailable) {
        throw new ApiError(503, 'memory_unavailable', 'O manifesto de instalação está indisponível. Tente de novo em instantes.');
      }
      throw e;
    }
  }

  @Post('computers')
  @HttpCode(200)
  @UseGuards(DeviceTokenGuard)
  @Header('Cache-Control', 'no-store')
  async create(@Req() req: DeviceRequest, @Body() b: unknown) {
    const body = parseInput(CreateComputerBody, b, invalidRequest);
    const r = await this.computers.create(req.device!.userId, {
      name: body.name,
      os: body.os,
      computerId: body.computer_id,
      agents: body.agents,
      clientVersion: body.client_version,
      installMode: body.install_mode,
    });
    return {
      computer_id: r.computerId,
      username: r.username,
      memory_url: memoryPublicUrl(),
      key: r.key.reveal(),
    };
  }

  /** O instalador gravou a chave: valida o computador e só então consome o token curto. */
  @Post('computers/:id/confirm')
  @HttpCode(204)
  @UseGuards(DeviceTokenGuard)
  @Header('Cache-Control', 'no-store')
  async confirm(@Req() req: DeviceRequest, @Param('id') id: string): Promise<void> {
    const grant = req.device!;
    if (!(await this.computers.confirm(grant.userId, id))) {
      throw new ApiError(404, 'computer_not_found', 'Computador não encontrado.');
    }
    await this.device.consume(grant);
  }
}
