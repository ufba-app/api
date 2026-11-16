import { Injectable } from '@nestjs/common';
import { ConsultaService, type Quem } from '../../application/live/consulta.service';
import { DownloadLinks } from '../../application/live/download-links';
import { isWebChatClient } from '../../application/memory/connect-guide';
import type { Provider } from '../../application/ports/source-gateway';
import type {
  BaixarAnexoInput,
  Fonte,
  ListarCursosInput,
  McpPrincipal,
  McpUseCases,
  PostarForumInput,
  PrazosInput,
  ListarAlunosInput,
  VerAvisoInput,
  VerTopicoInput,
  VerCursoInput,
  VerForumInput,
} from './mcp-ports';

const PROVIDERS: Record<Fonte, Provider> = { moodle: 'MOODLE', classroom: 'CLASSROOM', sigaa: 'SIGAA' };
const FONTES: Partial<Record<Provider, Fonte>> = { MOODLE: 'moodle', CLASSROOM: 'classroom', SIGAA: 'sigaa' };

const provider = (f?: Fonte): Provider => PROVIDERS[f ?? 'moodle'];

const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/**
 * Nome de pessoa para exibir: a fonte pode mandar em maiúsculas (SIGAA) ou sem padrão (Moodle, Classroom). Cada palavra começa
 * com maiúscula, exceto as partículas (de, da, do...) no meio do nome. Só mexe na caixa: não tira acento nem palavra.
 */
export function normalizarNome(nome: string): string {
  return nome
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .map((p, i) => (i > 0 && PARTICULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)))
    .join(' ');
}

/** Acessos de um link de leitura no chat web: a ferramenta de URL pode repetir a requisição. */
export const WEB_USOS = 3;
export const COMO_LER_WEB =
  'Abra o `link` com a sua ferramenta de leitura de URL (web fetch) para ler o arquivo: não precisa baixar nem rodar comando. ' +
  `O link vale 10 minutos e ${WEB_USOS} acessos, só para este arquivo. Se não conseguir abrir, diga isso à pessoa em vez de tentar o link do Drive ou do AVA.`;

/** Quem consulta: o usuário e, em token OAuth, o cliente com a chave K (o SIGAA só abre com ela). */
const quem = (p: McpPrincipal): Quem => (p.cliente ? { userId: p.userId, cliente: p.cliente } : { userId: p.userId });

/** Adapta o `ConsultaService` (leitura ao vivo) às ferramentas MCP. Sem regra de negócio. */
@Injectable()
export class McpUseCasesImpl implements McpUseCases {
  constructor(
    private readonly consulta: ConsultaService,
    private readonly downloads: DownloadLinks,
  ) {}

  async listarContas(p: McpPrincipal) {
    const contas = await this.consulta.contas(quem(p));
    return {
      contas: contas.flatMap((c) => {
        const fonte = FONTES[c.provider];
        return fonte ? [{ fonte, conta: c.conta, ...(c.status !== 'OK' ? { status: 'reconectar' } : {}) }] : [];
      }),
    };
  }

  async listarCursos(p: McpPrincipal, i: ListarCursosInput) {
    return { cursos: await this.consulta.listarCursos(quem(p), provider(i.fonte), i.conta, { todas: i.todas }) };
  }

  async prazos(p: McpPrincipal, i: PrazosInput) {
    return { prazos: await this.consulta.prazos(quem(p), provider(i.fonte), i.conta) };
  }

  async verCurso(p: McpPrincipal, i: VerCursoInput) {
    return { cursoId: i.cursoId, atividades: await this.consulta.verCurso(quem(p), provider(i.fonte), i.conta, i.cursoId) };
  }

  async verForum(p: McpPrincipal, i: VerForumInput) {
    return { forumId: i.forumId, discussoes: await this.consulta.verForum(quem(p), provider(i.fonte), i.conta, i.forumId) };
  }

  async listarAlunos(p: McpPrincipal, i: ListarAlunosInput) {
    const participantes = await this.consulta.listarParticipantes(quem(p), provider(i.fonte), i.conta, i.cursoId);
    const alunos = participantes
      .filter((x) => x.papeis.includes('student'))
      .map((x) => normalizarNome(x.nome))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { cursoId: i.cursoId, total: alunos.length, alunos };
  }

  async verTopico(p: McpPrincipal, i: VerTopicoInput) {
    return { discussaoId: i.discussaoId, mensagens: await this.consulta.verTopico(quem(p), provider(i.fonte), i.conta, i.discussaoId) };
  }

  async verAviso(p: McpPrincipal, i: VerAvisoInput) {
    return { aviso: await this.consulta.verAviso(quem(p), provider(i.fonte), i.conta, i.avisoId) };
  }

  async postarForum(p: McpPrincipal, i: PostarForumInput) {
    const feita = await this.consulta.postarForum(quem(p), i.conta, { forumId: i.forumId, postId: i.postId, titulo: i.titulo, mensagem: i.mensagem });
    return { postado: true, ...feita };
  }

  async baixarAnexo(p: McpPrincipal, i: BaixarAnexoInput) {
    // Não toca a fonte aqui (só confere a conta no banco): o arquivo é buscado quando o link for usado.
    const fonte = provider(i.fonte);
    const anexos = i.anexos?.length ? i.anexos : i.ref ? [{ ref: i.ref, nome: i.nome }] : [];
    if (anexos.length === 0) throw new Error('Informe `ref` ou `anexos`');
    if (anexos.length > 20) throw new Error('No máximo 20 anexos por vez');
    const conta = (await this.consulta.conta(quem(p), fonte, i.conta)).accountKey;
    const base = (p.baseUrl ?? process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    // Chat web não tem terminal: recebe um link para a ferramenta de leitura de URL abrir (poucos usos, pouco tempo, `inline`).
    const web = isWebChatClient(p.clientName);

    // Arquivo do Drive que é vídeo ou passa do teto: não gera link, avisa na hora (nome, tipo, tamanho) com o link para abrir no navegador.
    const infos = await Promise.all(anexos.map((a) => (fonte === 'MOODLE' ? this.consulta.driveInfo(quem(p), i.conta, a.ref) : Promise.resolve(null))));
    const bloqueados = new Map(anexos.map((a, n) => [a.ref, infos[n]] as const).filter(([, info]) => info?.blocked));
    if (anexos.length === 1 && !i.anexos && bloqueados.size === 1) {
      const info = [...bloqueados.values()][0]!;
      return { aviso: info.message, abrirNoNavegador: info.viewUrl };
    }

    const arquivos = anexos.map((a) => {
      const bloqueado = bloqueados.get(a.ref);
      if (bloqueado) return { nome: a.nome ?? bloqueado.name, aviso: bloqueado.message, abrirNoNavegador: bloqueado.viewUrl };
      const { id, expiresAt } = this.downloads.criar({ userId: p.userId, provider: fonte, conta, ref: a.ref, nome: a.nome, ...(web ? { usos: WEB_USOS, inline: true } : {}) });
      const arquivo = (a.nome ?? 'anexo').replace(/["\\/]/g, '_');
      if (web) {
        // Só ajuda a inferir o tipo pela extensão: letras, números, `.`, `_`, `-` e espaço; sem `..` nem ponto no começo.
        const nome = (a.nome ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\.{2,}/g, '.').replace(/^[. ]+/, '').trim().slice(0, 100);
        return { nome: a.nome, link: `${base}/download/${id}${nome ? `/${encodeURIComponent(nome)}` : ''}`, expiraEm: expiresAt };
      }
      const link = `${base}/download/${id}`;
      return { nome: a.nome, link, expiraEm: expiresAt, comoBaixar: `curl -fL -o "${arquivo}" "${link}"` };
    });

    if (web) {
      const comoLer = COMO_LER_WEB;
      return anexos.length === 1 && !i.anexos
        ? { link: arquivos[0].link, expiraEm: arquivos[0].expiraEm, usos: WEB_USOS, comoLer }
        : { usos: WEB_USOS, comoLer, arquivos };
    }
    return anexos.length === 1 && !i.anexos
      ? { link: arquivos[0].link, expiraEm: arquivos[0].expiraEm, usoUnico: true, comoBaixar: arquivos[0].comoBaixar }
      : { usoUnico: true, arquivos };
  }
}
