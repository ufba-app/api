import { ConfirmacoesEntrega, UploadLinks } from './entrega-links';

const requisitos = { arquivos: true, texto: false } as never;
const ticket = { userId: 'u1', conta: 'c1', cursoId: '10', tarefaId: '20', requisitos };
const rascunho = { userId: 'u1', conta: 'c1', tarefaId: '20', itemId: '99', arquivos: [{ nome: 'a.pdf', tamanhoBytes: 3 }] };

describe('UploadLinks', () => {
  let t = 1_000;
  const now = () => t;
  beforeEach(() => {
    t = 1_000;
  });

  it('link: consumir duas vezes, só a primeira devolve', () => {
    const links = new UploadLinks(15 * 60_000, now);
    const { id } = links.abrir(ticket);
    expect(links.consumir(id)).toMatchObject(ticket);
    expect(links.consumir(id)).toBeUndefined();
  });

  it('link expirado some', () => {
    const links = new UploadLinks(1000, now);
    const { id, expiresAt } = links.abrir(ticket);
    expect(expiresAt.getTime()).toBe(2_000);
    t = 2_000;
    expect(links.consumir(id)).toBeUndefined();
  });

  it('ler só devolve para o dono', () => {
    const links = new UploadLinks(15 * 60_000, now);
    const { id } = links.abrir(ticket);
    links.guardar(id, rascunho);
    expect(links.ler(id, 'u2')).toBeUndefined();
    expect(links.ler(id, 'u1')).toMatchObject(rascunho);
    expect(links.ler('outro', 'u1')).toBeUndefined();
    t += 15 * 60_000;
    expect(links.ler(id, 'u1')).toBeUndefined();
  });

  it('ids têm pelo menos 32 caracteres e não repetem', () => {
    const links = new UploadLinks(1000, now);
    const a = links.abrir(ticket).id;
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(links.abrir(ticket).id).not.toBe(a);
  });
});

describe('ConfirmacoesEntrega', () => {
  let t = 1_000;
  const now = () => t;
  const conf = { userId: 'u1', acao: 'enviar' as const, conta: 'c1', cursoId: '10', tarefaId: '20' };
  beforeEach(() => {
    t = 1_000;
  });

  it('confirmação: outra pessoa não consome e a confirmação continua valendo para o dono', () => {
    const c = new ConfirmacoesEntrega(10 * 60_000, now);
    const { id } = c.criar(conf);
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(c.consumir(id, 'u2', 'enviar')).toBeUndefined();
    expect(c.consumir(id, 'u1', 'enviar')).toMatchObject(conf);
  });

  it('confirmação: ação diferente não consome', () => {
    const c = new ConfirmacoesEntrega(10 * 60_000, now);
    const { id } = c.criar(conf);
    expect(c.consumir(id, 'u1', 'rascunho')).toBeUndefined();
    expect(c.consumir(id, 'u1', 'enviar')).toBeDefined();
  });

  it('confirmação expirada ou reutilizada devolve undefined', () => {
    const c = new ConfirmacoesEntrega(1000, now);
    const a = c.criar(conf).id;
    expect(c.consumir(a, 'u1', 'enviar')).toBeDefined();
    expect(c.consumir(a, 'u1', 'enviar')).toBeUndefined();
    const b = c.criar(conf).id;
    t = 2_000;
    expect(c.consumir(b, 'u1', 'enviar')).toBeUndefined();
  });
});
