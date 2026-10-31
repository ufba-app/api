import { Injectable } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { HistoricoService } from '../../application/academic/historico.service';
import { AnexoService } from '../../application/read/anexo.service';
import { LeituraService } from '../../application/read/leitura.service';
import type { ItemKind, Provider, SyncScope } from '../../application/ports/source-gateway';
import { SincronizarService } from '../../application/sync/sincronizar.service';
import type {
  AgendaInput,
  Fonte,
  ImportarHistoricoInput,
  InsightTipo,
  Leitura,
  LerAnexoInput,
  ListarItensInput,
  McpPrincipal,
  McpUseCases,
  MudancasInput,
  SincronizarInput,
  TipoItem,
} from './mcp-ports';

const PROVIDERS: Record<Fonte, Provider> = {
  sigaa: 'SIGAA',
  moodle: 'MOODLE',
  classroom: 'CLASSROOM',
  calendar: 'CALENDAR',
};

const KINDS: Record<TipoItem, ItemKind> = {
  aviso: 'ANNOUNCEMENT',
  tarefa: 'ASSIGNMENT',
  prova: 'ASSESSMENT',
  material: 'MATERIAL',
  forum: 'FORUM_TOPIC',
  outro: 'OTHER',
};

const DIA_MS = 86_400_000;

function data(value: string | undefined, nome: string, padrao: Date): Date {
  if (!value) return padrao;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${nome} inválido (use ISO 8601)`);
  return d;
}

function escopo(i: SincronizarInput): SyncScope {
  if (i.alcance === 'tudo') return { kind: 'tudo' };
  if (i.alcance === 'curso' && i.cursoId) return { kind: 'curso', courseExternalId: i.cursoId };
  if (i.alcance === 'item' && i.cursoId && i.itemId) {
    return { kind: 'item', courseExternalId: i.cursoId, itemExternalId: i.itemId };
  }
  throw new BadRequestException(
    'alcance inválido: "tudo" | "curso" (com cursoId) | "item" (com cursoId e itemId)',
  );
}

/**
 * Adapta os serviços de `application/` (os MESMOS do REST) às ferramentas MCP. Sem regra de negócio: só traduz
 * nomes e valida a forma da entrada.
 */
@Injectable()
export class McpUseCasesImpl implements McpUseCases {
  constructor(
    private readonly sincronizarService: SincronizarService,
    private readonly leitura: LeituraService,
    private readonly historicoService: HistoricoService,
    private readonly anexos: AnexoService,
  ) {}

  async sincronizar(p: McpPrincipal, i: SincronizarInput): Promise<unknown> {
    const c = i.credencial;
    const r = await this.sincronizarService.sincronizar({
      userId: p.userId,
      provider: PROVIDERS[i.fonte],
      alcance: escopo(i),
      senha: c?.usuario && c?.senha ? { username: c.usuario, password: c.senha } : undefined,
    });
    return { fonte: i.fonte, syncRunId: r.syncRunId, counts: r.counts, atualizadoEm: r.atualizadoEm };
  }

  listarItens(p: McpPrincipal, i: ListarItensInput): Promise<Leitura> {
    return this.leitura.listarItens({
      userId: p.userId,
      provider: i.fonte ? PROVIDERS[i.fonte] : undefined,
      courseSpaceId: i.cursoId,
      kind: i.tipo ? KINDS[i.tipo] : undefined,
      limit: i.limite,
    });
  }

  /** Padrão: de agora até +14 dias (igual ao REST). */
  agenda(p: McpPrincipal, i: AgendaInput): Promise<Leitura> {
    const de = data(i.de, 'de', new Date());
    const ate = data(i.ate, 'ate', new Date(de.getTime() + 14 * DIA_MS));
    return this.leitura.agenda({ userId: p.userId, de, ate });
  }

  /** Padrão: últimos 7 dias. */
  mudancas(p: McpPrincipal, i: MudancasInput): Promise<Leitura> {
    return this.leitura.mudancas({
      userId: p.userId,
      desde: data(i.desde, 'desde', new Date(Date.now() - 7 * DIA_MS)),
    });
  }

  perfil(p: McpPrincipal): Promise<Leitura> {
    return this.leitura.perfil(p.userId);
  }

  historico(p: McpPrincipal): Promise<Leitura> {
    return this.leitura.historico(p.userId);
  }

  insights(p: McpPrincipal, tipo: InsightTipo): Promise<Leitura> {
    return this.historicoService.insights(p.userId, tipo);
  }

  importarHistorico(p: McpPrincipal, i: ImportarHistoricoInput): Promise<Leitura> {
    return this.historicoService.importar({
      userId: p.userId,
      username: i.usuario,
      password: i.senha,
    });
  }

  lerAnexo(p: McpPrincipal, i: LerAnexoInput): Promise<unknown> {
    return this.anexos.ler(p.userId, i.itemId, i.anexoId);
  }
}
