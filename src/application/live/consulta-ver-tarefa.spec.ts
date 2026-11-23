import { LiveSources, type LiveSource, type TarefaVista } from '../ports/live-source';
import type { SourceAccountRecord } from '../ports/repositories';
import type { SourceContext } from '../ports/source-gateway';
import { ConsultaService, FonteSemLeituraError, type Quem } from './consulta.service';

const U1: Quem = { userId: 'u1' };
const CONTA: SourceAccountRecord = {
  id: 'id-1',
  userId: 'u1',
  provider: 'MOODLE',
  accountKey: 'ava.test:aluno',
  siteUrl: 'https://ava.test',
  status: 'OK',
  lastSyncedAt: null,
  expiresAt: null,
  secret: { ciphertext: 'tok', iv: '', authTag: '' },
};
const TAREFA: TarefaVista = {
  tarefaId: '4286503',
  titulo: 'Avaliação 01',
  estado: 'entregue',
  atrasada: false,
  arquivosAtuais: [],
  temTextoAtual: false,
  avaliacao: { avaliada: false, comentarios: [] },
};

function build(verTarefa?: LiveSource['verTarefa']) {
  const source: LiveSource = {
    provider: 'MOODLE',
    listarCursos: async () => [],
    prazos: async () => [],
    verCurso: async () => [],
    verForum: async () => [],
    baixar: async () => ({}) as never,
    verTarefa,
  };
  const live = new LiveSources();
  live.register(source);
  const accounts = { findByUserAndProvider: async () => [CONTA], listByUser: async () => [CONTA], setStatus: jest.fn() } as never;
  const cipher = { decrypt: (s: { ciphertext: string }) => s.ciphertext } as never;
  return new ConsultaService(live, accounts, cipher, { situacao: async () => null } as never);
}

describe('ConsultaService.verTarefa', () => {
  it('delega à fonte Moodle com o curso e o cmid', async () => {
    const verTarefa = jest.fn(async (_ctx: SourceContext, _c: string, _t: string) => TAREFA);
    await expect(build(verTarefa).verTarefa(U1, undefined, '359937', '4286503')).resolves.toBe(TAREFA);
    expect(verTarefa.mock.calls[0].slice(1)).toEqual(['359937', '4286503']);
  });

  it('fonte sem verTarefa: FonteSemLeituraError', async () => {
    await expect(build().verTarefa(U1, undefined, '359937', '4286503')).rejects.toBeInstanceOf(FonteSemLeituraError);
  });
});
