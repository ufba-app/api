import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-tools';
import type { McpPrincipal, McpUseCases } from './mcp-ports';

const TRES = ['preparar_envio_tarefa', 'salvar_rascunho_tarefa', 'enviar_tarefa'];
const COM = { userId: 'u1', permissions: new Set(['moodle.assignment_write']) };

async function servidor(p: McpPrincipal, uc: Partial<McpUseCases>) {
  const server = buildMcpServer(uc as McpUseCases, p);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const texto = (r: unknown) => ((r as { content: Array<{ text: string }> }).content)[0].text;

describe('ferramentas de entrega de tarefa', () => {
  it('sem moodle.assignment_write nenhuma das três aparece', async () => {
    for (const p of [{ userId: 'u1' }, { userId: 'u1', permissions: new Set(['moodle.forum_write']) }]) {
      const nomes = (await (await servidor(p, {})).listTools()).tools.map((t) => t.name);
      for (const n of TRES) expect(nomes).not.toContain(n);
    }
  });

  it('com a permissão as três aparecem; preparar é somente leitura, as outras são escrita não destrutiva', async () => {
    const tools = (await (await servidor(COM, {})).listTools()).tools;
    const t = (n: string) => tools.find((x) => x.name === n)!;
    expect(t('preparar_envio_tarefa').annotations).toMatchObject({ readOnlyHint: true });
    for (const n of ['salvar_rascunho_tarefa', 'enviar_tarefa']) {
      expect(t(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(t(n).annotations?.title).toBe(t(n).title);
      // A descrição manda mostrar o resumo e só confirmar com o "sim" da pessoa; avisa que vai ao professor e não se desfaz.
      expect(t(n).description).toMatch(/confirmacaoId/);
      expect(t(n).description).toMatch(/professor/);
      expect(t(n).description).toMatch(/desfeit/i);
      expect(t(n).description).toMatch(/substitu/i);
    }
    expect(t('preparar_envio_tarefa').description).toMatch(/curl/);
  });

  it('preparar_envio_tarefa repassa os argumentos', async () => {
    const prepararEnvioTarefa = jest.fn(async () => ({ linkUpload: 'x' }));
    const c = await servidor(COM, { prepararEnvioTarefa });
    const r = await c.callTool({ name: 'preparar_envio_tarefa', arguments: { cursoId: '10', tarefaId: '20' } });
    expect(r.isError).toBeFalsy();
    expect(prepararEnvioTarefa).toHaveBeenCalledWith(expect.anything(), { cursoId: '10', tarefaId: '20' });
  });

  it('salvar_rascunho_tarefa e enviar_tarefa sem confirmacaoId chamam o caso de uso sem confirmacaoId', async () => {
    const salvarRascunhoTarefa = jest.fn(async () => ({ confirmacaoPendente: true }));
    const enviarTarefa = jest.fn(async () => ({ confirmacaoPendente: true }));
    const c = await servidor(COM, { salvarRascunhoTarefa, enviarTarefa });
    const args = { cursoId: '10', tarefaId: '20', uploadId: 'up1', texto: 'Oi' };
    const r1 = await c.callTool({ name: 'salvar_rascunho_tarefa', arguments: args });
    const r2 = await c.callTool({ name: 'enviar_tarefa', arguments: { cursoId: '10', tarefaId: '20', arquivos: [{ nome: 'a.pdf', conteudoBase64: 'QQ==' }] } });
    expect(salvarRascunhoTarefa).toHaveBeenCalledWith(expect.anything(), args);
    expect(enviarTarefa).toHaveBeenCalledWith(expect.anything(), { cursoId: '10', tarefaId: '20', arquivos: [{ nome: 'a.pdf', conteudoBase64: 'QQ==' }] });
    expect(JSON.parse(texto(r1))).toEqual({ confirmacaoPendente: true });
    expect(JSON.parse(texto(r2))).toEqual({ confirmacaoPendente: true });
  });

  it('com confirmacaoId repassam o id', async () => {
    const salvarRascunhoTarefa = jest.fn(async () => ({ salvo: true }));
    const enviarTarefa = jest.fn(async () => ({ enviado: true }));
    const c = await servidor(COM, { salvarRascunhoTarefa, enviarTarefa });
    await c.callTool({ name: 'salvar_rascunho_tarefa', arguments: { cursoId: '10', tarefaId: '20', confirmacaoId: 'c1' } });
    await c.callTool({ name: 'enviar_tarefa', arguments: { cursoId: '10', tarefaId: '20', confirmacaoId: 'c2' } });
    expect(salvarRascunhoTarefa).toHaveBeenCalledWith(expect.anything(), { cursoId: '10', tarefaId: '20', confirmacaoId: 'c1' });
    expect(enviarTarefa).toHaveBeenCalledWith(expect.anything(), { cursoId: '10', tarefaId: '20', confirmacaoId: 'c2' });
  });

  it('mais de 20 arquivos é recusado pelo schema', async () => {
    const enviarTarefa = jest.fn(async () => ({}));
    const c = await servidor(COM, { enviarTarefa });
    const arquivos = Array.from({ length: 21 }, (_, n) => ({ nome: `${n}.pdf`, conteudoBase64: 'QQ==' }));
    const r = await c.callTool({ name: 'enviar_tarefa', arguments: { cursoId: '10', tarefaId: '20', arquivos } });
    expect(r.isError).toBe(true);
    expect(enviarTarefa).not.toHaveBeenCalled();
  });

  it('erro do caso de uso volta como erro da ferramenta com a mensagem', async () => {
    const enviarTarefa = jest.fn(async () => {
      throw new Error('O prazo final da tarefa já passou: o AVA não aceita mais entregas.');
    });
    const c = await servidor(COM, { enviarTarefa });
    const r = await c.callTool({ name: 'enviar_tarefa', arguments: { cursoId: '10', tarefaId: '20', texto: 'x' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('O prazo final da tarefa já passou');
  });
});
