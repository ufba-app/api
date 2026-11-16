import { DownloadLinks } from '../../application/live/download-links';
import type { ConsultaService } from '../../application/live/consulta.service';
import { McpUseCasesImpl, WEB_USOS } from './mcp-use-cases';

function build(driveInfo: (ref: string) => unknown = () => null) {
  const links = new DownloadLinks();
  const consulta = { conta: async () => ({ accountKey: 'ava:aluno' }), driveInfo: async (_q: unknown, _c: unknown, ref: string) => driveInfo(ref) } as unknown as ConsultaService;
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

describe('baixar_anexo: vídeo e arquivo grande do Drive não geram link', () => {
  const video = { name: 'Aula 01.mp4', mimeType: 'video/mp4', sizeBytes: 350 * 1024 * 1024, viewUrl: 'https://drive.google.com/file/d/ABCDEFGHIJK/view', blocked: 'video', message: '"Aula 01.mp4" é um vídeo (350 MB): abra no navegador: https://drive.google.com/file/d/ABCDEFGHIJK/view' };
  const ok = { name: 'slides.pdf', mimeType: 'application/pdf', sizeBytes: 1000, viewUrl: 'https://drive.google.com/file/d/ZZZZZZZZZZZ/view', blocked: null, message: null };

  it('um anexo bloqueado: aviso claro e o link para a pessoa abrir, SEM ticket de download', async () => {
    const { uc, links } = build(() => video);
    const r = (await uc.baixarAnexo(base, { fonte: 'moodle', ref: 'gdrive1.file.x.y', nome: 'Aula 01.mp4' })) as any;
    expect(r.aviso).toMatch(/vídeo \(350 MB\)/);
    expect(r.abrirNoNavegador).toBe(video.viewUrl);
    expect(r.link).toBeUndefined();
    expect(r.comoBaixar).toBeUndefined();
    expect(links.espiar('qualquer')).toBeUndefined();
  });

  it('vários: só os bloqueados viram aviso; os baixáveis seguem com link (em terminal e em chat web)', async () => {
    for (const clientName of ['claude-code', 'claude-ai']) {
      const { uc } = build((ref) => (ref === 'gdrive1.file.v.y' ? video : ref === 'gdrive1.file.ok.y' ? ok : null));
      const r = (await uc.baixarAnexo({ ...base, clientName }, { fonte: 'moodle', anexos: [{ ref: 'gdrive1.file.v.y', nome: 'Aula 01.mp4' }, { ref: 'gdrive1.file.ok.y', nome: 'slides.pdf' }, { ref: 'https://ava.test/a.pdf', nome: 'outro.pdf' }] })) as any;
      expect(r.arquivos).toHaveLength(3);
      expect(r.arquivos[0]).toMatchObject({ nome: 'Aula 01.mp4', abrirNoNavegador: video.viewUrl });
      expect(r.arquivos[0].link).toBeUndefined();
      expect(r.arquivos[1].link).toMatch(/\/download\//);
      expect(r.arquivos[2].link).toMatch(/\/download\//); // não é do Drive: nada a conferir
    }
  });

  it('sem como saber (null) ou fonte que não é o Moodle: gera o link normal', async () => {
    const { uc } = build(() => null);
    expect(((await uc.baixarAnexo(base, { fonte: 'moodle', ref: 'gdrive1.file.x.y' })) as any).link).toMatch(/\/download\//);
    const { uc: uc2 } = build(() => video);
    expect(((await uc2.baixarAnexo(base, { fonte: 'classroom', ref: 'curso:t:post:arq' })) as any).link).toMatch(/\/download\//);
  });
});
