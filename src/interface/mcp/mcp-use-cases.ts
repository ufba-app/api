import { Injectable } from '@nestjs/common';
import { ConsultaService } from '../../application/live/consulta.service';
import { DownloadLinks } from '../../application/live/download-links';
import type { Provider } from '../../application/ports/source-gateway';
import type {
  BaixarAnexoInput,
  Fonte,
  ListarCursosInput,
  McpPrincipal,
  McpUseCases,
  PrazosInput,
  VerCursoInput,
  VerForumInput,
} from './mcp-ports';

const PROVIDERS: Record<Fonte, Provider> = { moodle: 'MOODLE', classroom: 'CLASSROOM' };
const FONTES: Partial<Record<Provider, Fonte>> = { MOODLE: 'moodle', CLASSROOM: 'classroom' };

const provider = (f?: Fonte): Provider => PROVIDERS[f ?? 'moodle'];

/** Adapta o `ConsultaService` (leitura ao vivo) às ferramentas MCP. Sem regra de negócio. */
@Injectable()
export class McpUseCasesImpl implements McpUseCases {
  constructor(
    private readonly consulta: ConsultaService,
    private readonly downloads: DownloadLinks,
  ) {}

  async listarContas(p: McpPrincipal) {
    const contas = await this.consulta.contas(p.userId);
    return {
      contas: contas.flatMap((c) => {
        const fonte = FONTES[c.provider];
        return fonte ? [{ fonte, conta: c.conta, ...(c.status !== 'OK' ? { status: 'reconectar' } : {}) }] : [];
      }),
    };
  }

  async listarCursos(p: McpPrincipal, i: ListarCursosInput) {
    return { cursos: await this.consulta.listarCursos(p.userId, provider(i.fonte), i.conta, { todas: i.todas }) };
  }

  async prazos(p: McpPrincipal, i: PrazosInput) {
    return { prazos: await this.consulta.prazos(p.userId, provider(i.fonte), i.conta) };
  }

  async verCurso(p: McpPrincipal, i: VerCursoInput) {
    return { cursoId: i.cursoId, atividades: await this.consulta.verCurso(p.userId, provider(i.fonte), i.conta, i.cursoId) };
  }

  async verForum(p: McpPrincipal, i: VerForumInput) {
    return { forumId: i.forumId, discussoes: await this.consulta.verForum(p.userId, provider(i.fonte), i.conta, i.forumId) };
  }

  async baixarAnexo(p: McpPrincipal, i: BaixarAnexoInput) {
    // Não toca a fonte aqui (só confere a conta no banco): o arquivo é buscado quando o link for usado.
    const fonte = provider(i.fonte);
    const anexos = i.anexos?.length ? i.anexos : i.ref ? [{ ref: i.ref, nome: i.nome }] : [];
    if (anexos.length === 0) throw new Error('Informe `ref` ou `anexos`');
    if (anexos.length > 20) throw new Error('No máximo 20 anexos por vez');
    const conta = (await this.consulta.conta(p.userId, fonte, i.conta)).accountKey;
    const base = (p.baseUrl ?? process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

    const arquivos = anexos.map((a) => {
      const { id, expiresAt } = this.downloads.criar({ userId: p.userId, provider: fonte, conta, ref: a.ref, nome: a.nome });
      const link = `${base}/download/${id}`;
      const arquivo = (a.nome ?? 'anexo').replace(/["\\/]/g, '_');
      return { nome: a.nome, link, expiraEm: expiresAt, comoBaixar: `curl -fL -o "${arquivo}" "${link}"` };
    });

    return anexos.length === 1 && !i.anexos
      ? { link: arquivos[0].link, expiraEm: arquivos[0].expiraEm, usoUnico: true, comoBaixar: arquivos[0].comoBaixar }
      : { usoUnico: true, arquivos };
  }
}
