import { Logger } from '@nestjs/common';
import { UserPermissionRepository } from '../ports/permissions';
import { PERMISSION_KEYS, type PermissionKey } from '../web/contract';
import { ApiError } from '../web/web-api';

export interface PermissionView {
  key: PermissionKey;
  source: string;
  title: string;
  description: string;
  risk: 'low' | 'high';
  enabled: boolean;
  available: boolean;
  unavailableReason: 'source_not_connected' | null;
}

interface PermissionDef {
  source: string;
  title: string;
  description: string;
  risk: 'low' | 'high';
}

/**
 * Catálogo das permissões (texto em pt-BR vem DAQUI, o web não escreve nada). `Record<PermissionKey, …>` obriga cada chave
 * nova do contrato a ter título, descrição e risco. A fonte é o prefixo da chave.
 */
export const PERMISSION_CATALOG: Record<PermissionKey, PermissionDef> = {
  'siasb.schedule_write': {
    source: 'siasb',
    title: 'Agendar e desmarcar sessões pelo Claude',
    description:
      'Permite que o Claude marque e desmarque sessões da clínica no SIASB em seu nome. Cada ação pede a sua confirmação antes de ser feita.',
    risk: 'low',
  },
  'siasb.procedures_write': {
    source: 'siasb',
    title: 'Lançar e excluir procedimentos pelo Claude',
    description:
      'Permite que o Claude inclua e exclua procedimentos previstos nos seus atendimentos do SIASB, que ficam no prontuário. Cada ação pede a sua confirmação. Procedimentos realizados continuam sendo feitos por você no site.',
    risk: 'high',
  },
};

/** A pessoa tem conexão com a fonte (em qualquer estado, inclusive reconectar)? */
export interface SourceConnections {
  hasSource(userId: string, source: string): Promise<boolean>;
}

const audit = new Logger('Audit');

/**
 * Permissões por fonte: o que a PESSOA liga no painel para o Claude poder fazer (ex.: ações de escrita). Padrão desligado.
 * Só a sessão do painel liga; nenhuma ferramenta MCP altera permissões. Cada mudança entra no log de auditoria sem dado
 * clínico (quem, chave, valor, quando).
 */
export class PermissionsService {
  constructor(
    private readonly repo: UserPermissionRepository,
    private readonly connections: SourceConnections,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string): Promise<PermissionView[]> {
    const rows = new Map((await this.repo.list(userId)).map((r) => [r.key, r.enabled]));
    const sources = [...new Set(PERMISSION_KEYS.map((k) => PERMISSION_CATALOG[k].source))];
    const connected = new Map<string, boolean>();
    for (const s of sources) connected.set(s, await this.connections.hasSource(userId, s));
    return PERMISSION_KEYS.map((key) => {
      const def = PERMISSION_CATALOG[key];
      const available = connected.get(def.source) === true;
      return {
        key,
        source: def.source,
        title: def.title,
        description: def.description,
        risk: def.risk,
        enabled: rows.get(key) === true,
        available,
        unavailableReason: available ? null : 'source_not_connected',
      };
    });
  }

  /** Ligar exige a fonte conectada (409 `permission_unavailable`); desligar é sempre permitido. */
  async set(userId: string, key: PermissionKey, enabled: boolean): Promise<void> {
    if (enabled && !(await this.connections.hasSource(userId, PERMISSION_CATALOG[key].source))) {
      throw new ApiError(409, 'permission_unavailable', 'Conecte a fonte antes de ligar esta permissão.');
    }
    const at = this.now();
    await this.repo.set(userId, key, enabled, at);
    audit.log(`permissão: user=${userId} chave=${key} valor=${enabled} em=${at.toISOString()}`);
  }

  /** As chaves LIGADAS da pessoa (o MCP só registra ferramentas de escrita cuja chave está aqui). */
  async enabledKeys(userId: string): Promise<ReadonlySet<string>> {
    return new Set((await this.repo.list(userId)).filter((r) => r.enabled).map((r) => r.key));
  }

  /** A fonte foi desconectada: as permissões dela somem (não ficam ligadas para uma conexão futura). */
  async sourceDisconnected(userId: string, source: string): Promise<void> {
    await this.repo.deleteBySource(userId, source);
  }
}
