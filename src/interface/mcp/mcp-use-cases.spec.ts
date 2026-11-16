import { DownloadLinks } from '../../application/live/download-links';
import type { ConsultaService } from '../../application/live/consulta.service';
import { McpUseCasesImpl, WEB_USOS } from './mcp-use-cases';

function build() {
  const links = new DownloadLinks();
  const consulta = { conta: async () => ({ accountKey: 'ava:aluno' }) } as unknown as ConsultaService;
  return { uc: new McpUseCasesImpl(consulta, links), links };
}
const base = { userId: 'u1', baseUrl: 'https://api.ufba.app' };

describe('baixar_anexo: terminal x chat web', () => {
  it('terminal/editor/desconhecido: link de uso único e comando curl, como antes', async () => {
    for (const clientName of ['claude-code', undefined]) {
      const { uc, links } = build();
      const r = (await uc.baixarAnexo({ ...base, ...(clientName ? { clientName } : {}) }, { fonte: 'moodle', ref: 'https://ava.test/a.pdf', nome: 'Aula 1.pdf' })) as any;
      expect(r.usoUnico).toBe(true);
      expect(r.comoBaixar).toContain('curl -fL -o "Aula 1.pdf"');
      expect(r.comoLer).toBeUndefined();
      expect(r.link).toMatch(/^https:\/\/api\.ufba\.app\/download\/[\w-]+$/);
      const id = r.link.split('/').pop();
      expect(links.espiar(id)).toMatchObject({ usosRestantes: 1 });
    }
  });

  it.each(['claude-ai', 'Claude Desktop', 'chatgpt'])('chat web (%s): link para a ferramenta de URL ler, com nome na URL, poucos usos e SEM curl', async (clientName) => {
    const { uc, links } = build();
    const r = (await uc.baixarAnexo({ ...base, clientName }, { fonte: 'moodle', ref: 'https://ava.test/a.pdf', nome: 'Aula 1.pdf' })) as any;
    expect(r.comoBaixar).toBeUndefined();
    expect(r.usoUnico).toBeUndefined();
    expect(r.usos).toBe(WEB_USOS);
    expect(r.comoLer).toMatch(/ferramenta de leitura de URL/);
    expect(r.comoLer).toMatch(/10 minutos/);
    expect(r.link).toMatch(/^https:\/\/api\.ufba\.app\/download\/[\w-]+\/Aula%201\.pdf$/);
    const id = r.link.split('/')[4];
    expect(links.espiar(id)).toMatchObject({ usosRestantes: WEB_USOS, inline: true, provider: 'MOODLE', conta: 'ava:aluno' });
  });

  it('chat web com vários anexos: um link por arquivo; nome hostil não vira caminho', async () => {
    const { uc } = build();
    const r = (await uc.baixarAnexo({ ...base, clientName: 'claude-ai' }, { fonte: 'moodle', anexos: [{ ref: 'a', nome: '../../etc/passwd' }, { ref: 'b' }] })) as any;
    expect(r.arquivos).toHaveLength(2);
    expect(r.arquivos[0].link).not.toContain('..');
    expect(r.arquivos[0].link.split('/').length).toBe(6); // https: '' host download id nome
    expect(r.arquivos[1].link).toMatch(/\/download\/[\w-]+$/); // sem nome: só o id
    expect(r.comoLer).toBeDefined();
  });
});
