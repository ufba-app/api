import { Logger } from '@nestjs/common';
import { ClientPermissionRepository } from '../ports/permissions';
import { PERMISSION_KEYS, type PermissionKey } from '../web/contract';
import { ApiError } from '../web/web-api';

export interface OfferedPermissionView {
  key: PermissionKey;
  source: string;
  title: string;
  description: string;
  risk: 'low' | 'high';
  available: boolean;
  unavailableReason: 'source_not_connected' | null;
  /** Já concedida a ESTE app (o pedido em andamento); `false` quando não há app em questão. */
  granted: boolean;
}

export type GrantedPermissionView = Pick<OfferedPermissionView, 'key' | 'source' | 'title' | 'description' | 'risk'>;

/** Visão legada de `/me/permissions`: a oferta mais `enabled` (= concedida a algum app). */
export interface PermissionView extends Omit<OfferedPermissionView, 'granted'> {
  enabled: boolean;
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
    title: 'Agendar e desmarcar sessões pelo app',
    description:
      'Permite que o app marque e desmarque sessões da clínica no SIASB em seu nome. Cada ação pede a sua confirmação antes de ser feita.',
    risk: 'low',
  },
  'siasb.procedures_write': {
    source: 'siasb',
    title: 'Lançar e excluir procedimentos pelo app',
    description:
      'Permite que o app inclua e exclua procedimentos previstos nos seus atendimentos do SIASB, que ficam no prontuário. Cada ação pede a sua confirmação. Procedimentos realizados continuam sendo feitos por você no site.',
    risk: 'high',
  },
  'moodle.forum_write': {
    source: 'moodle',
    title: 'Postar em fóruns do AVA pelo app',
    description:
      'Permite que o app publique mensagens em fóruns do AVA em seu nome: abrir uma discussão nova ou responder a uma existente. Quem vê são os colegas e os professores, e a publicação não pode ser desfeita pelo app. Cada publicação pede a sua confirmação antes de ser enviada.',
    risk: 'high',
  },
};

/** O que a pessoa tem em cada fonte: conexão (em qualquer estado, inclusive reconectar) e acesso (a fonte é oferecida a ela). */
export interface SourceConnections {
  hasSource(userId: string, source: string): Promise<boolean>;
  /** A fonte é oferecida a esta pessoa (ex.: o SIASB só para quem tem matrícula de clínica)? Já conectada conta como acesso. */
  hasAccess(userId: string, source: string): Promise<boolean>;
}

const audit = new Logger('Audit');

const view = (key: PermissionKey): GrantedPermissionView => {
  const d = PERMISSION_CATALOG[key];
  return { key, source: d.source, title: d.title, description: d.description, risk: d.risk };
};

const isKey = (k: string): k is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(k);

/**
 * Permissões por APP: o que a pessoa libera para UM app (cliente OAuth) fazer em seu nome (ex.: ações de escrita no SIASB).
 * Marcadas ao autorizar o app; padrão negado; o MCP lê o conjunto do app que fez a chamada, nunca de um conjunto global.
 * Só a sessão do painel concede e revoga; nenhuma ferramenta MCP altera permissões. Cada mudança entra no log de auditoria
 * sem dado clínico (quem, app, chave, quando).
 */
export class PermissionsService {
  constructor(
    private readonly repo: ClientPermissionRepository,
    private readonly connections: SourceConnections,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * As permissões que a pessoa PODE conceder: só de fontes a que tem acesso, com `available` = fonte conectada e `granted` =
   * já concedida ao app `clientId` (a tela pré-marca e manda sempre o conjunto inteiro).
   */
  async offered(userId: string, clientId?: string): Promise<OfferedPermissionView[]> {
    const already = clientId ? new Set(await this.repo.keysOf(userId, clientId)) : new Set<string>();
    const sources = [...new Set(PERMISSION_KEYS.map((k) => PERMISSION_CATALOG[k].source))];
    const access = new Map<string, { access: boolean; connected: boolean }>();
    for (const s of sources) {
      const connected = await this.connections.hasSource(userId, s);
      access.set(s, { connected, access: connected || (await this.connections.hasAccess(userId, s)) });
    }
    return PERMISSION_KEYS.filter((k) => access.get(PERMISSION_CATALOG[k].source)?.access).map((key) => {
      const d = PERMISSION_CATALOG[key];
      const connected = access.get(d.source)?.connected === true;
      return { ...view(key), available: connected, unavailableReason: connected ? null : 'source_not_connected', granted: already.has(key) };
    });
  }

  /**
   * Valida o conjunto que a pessoa aprovou: chaves do catálogo, sem repetição, e só de fontes CONECTADAS
   * (409 `permission_unavailable`). Chamar ANTES de qualquer efeito do pedido.
   */
  async validate(userId: string, keys: readonly string[]): Promise<PermissionKey[]> {
    const unique = [...new Set(keys)];
    const valid = unique.filter(isKey);
    if (valid.length !== unique.length) throw new ApiError(400, 'invalid_request', 'Permissão desconhecida.');
    for (const k of valid) {
      if (!(await this.connections.hasSource(userId, PERMISSION_CATALOG[k].source))) {
        throw new ApiError(409, 'permission_unavailable', 'Conecte a fonte antes de liberar esta permissão.');
      }
    }
    return valid;
  }

  /** Grava o conjunto EXATO aprovado para o app (já validado; vazio limpa). */
  async grant(userId: string, clientId: string, keys: readonly PermissionKey[]): Promise<void> {
    const at = this.now();
    await this.repo.replace(userId, clientId, keys, at);
    audit.log(`permissões do app: user=${userId} app=${clientId} chaves=[${keys.join(',')}] em=${at.toISOString()}`);
  }

  /** O que o app já tem (para Apps autorizados). */
  async grantedTo(userId: string): Promise<Map<string, GrantedPermissionView[]>> {
    const out = new Map<string, GrantedPermissionView[]>();
    for (const r of await this.repo.listByUser(userId)) {
      if (!isKey(r.key)) continue;
      out.set(r.clientId, [...(out.get(r.clientId) ?? []), view(r.key)]);
    }
    return out;
  }

  /** Retira UMA permissão de UM app. 404 se o app não a tinha. */
  async revoke(userId: string, clientId: string, key: string): Promise<void> {
    if (!isKey(key)) throw new ApiError(400, 'invalid_request', 'Permissão desconhecida.');
    if (!(await this.repo.revoke(userId, clientId, key))) throw new ApiError(404, 'not_found', 'Esse app não tem esta permissão.');
    audit.log(`permissão revogada: user=${userId} app=${clientId} chave=${key} em=${this.now().toISOString()}`);
  }

  /** Revogou o app: as permissões dele vão junto. */
  async appRevoked(userId: string, clientId: string): Promise<void> {
    await this.repo.deleteClient(userId, clientId);
  }

  /** As chaves concedidas ao APP que chama (o MCP só registra ferramentas de escrita cuja chave está aqui). Sem app: nenhuma. */
  async grantedKeys(userId: string, clientId?: string): Promise<ReadonlySet<string>> {
    if (!clientId) return new Set();
    return new Set((await this.repo.keysOf(userId, clientId)).filter(isKey));
  }

  /** A fonte foi desconectada: as permissões dela somem de todos os apps (não ficam ligadas para uma conexão futura). */
  async sourceDisconnected(userId: string, source: string): Promise<void> {
    await this.repo.deleteBySource(userId, source);
  }

  /** LEGADO (`GET /me/permissions`): a oferta com `enabled` = concedida a pelo menos um app. */
  async list(userId: string): Promise<PermissionView[]> {
    const granted = new Set((await this.repo.listByUser(userId)).map((r) => r.key));
    return (await this.offered(userId)).map(({ granted: _app, ...o }) => ({ ...o, enabled: granted.has(o.key) }));
  }

  /**
   * LEGADO (`PUT /me/permissions/{key}`): só DESLIGAR existe (retira a chave de todos os apps). Ligar agora é ao autorizar
   * o app, então `enabled: true` é 400.
   */
  async set(userId: string, key: PermissionKey, enabled: boolean): Promise<void> {
    if (enabled) throw new ApiError(400, 'invalid_request', 'A permissão é liberada ao autorizar o app, na tela de autorização.');
    await this.repo.revokeEverywhere(userId, key);
    audit.log(`permissão desligada em todos os apps: user=${userId} chave=${key} em=${this.now().toISOString()}`);
  }
}
