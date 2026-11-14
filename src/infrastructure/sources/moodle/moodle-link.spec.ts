import { Secret } from '../../../application/shared/secret';
import { createHash } from 'node:crypto';
import { MoodleLink, MoodleLinkError } from './moodle-link';

const SITE = 'https://ava.ufba.br';
const WSTOKEN = 'wstoken-secreto-123';

function build(site: Record<string, unknown> = { username: 'luiz.a', userid: 7 }, status = 200) {
  const fetchFn = (async () => new Response(JSON.stringify(site), { status })) as unknown as typeof fetch;
  const conectarConta = jest.fn().mockResolvedValue(undefined);
  const link = new MoodleLink({} as never, { conectarConta } as never, {
    siteUrl: SITE,
    passportKey: 'chave-de-teste',
    fetchFn,
  });
  return { link, conectarConta };
}

/** Simula o que o Moodle devolve: base64(<md5(site+passport)>:::<wstoken>:::<privatetoken>). */
async function moodleReturn(link: MoodleLink, userId: string, txn: string, sigPassport?: string) {
  const passport = new URL(await link.launchUrl(userId, txn)).searchParams.get('passport')!;
  const sig = createHash('md5').update(SITE + (sigPassport ?? passport)).digest('hex');
  return `moodlemobile://token=${Buffer.from(`${sig}:::${WSTOKEN}:::PRIVADO`).toString('base64')}`;
}

describe('MoodleLink', () => {
  it('monta o launch.php com passport próprio da transação e urlscheme web+ufba', async () => {
    const { link } = build();
    const u = new URL(await link.launchUrl('u1', 'txn1'));
    expect(u.origin + u.pathname).toBe(`${SITE}/admin/tool/mobile/launch.php`);
    expect(u.searchParams.get('service')).toBe('moodle_mobile_app');
    expect(u.searchParams.get('urlscheme')).toBe('web+ufba');
    expect(link.scheme()).toBe('web+ufba');
    const p1 = u.searchParams.get('passport');
    expect(p1).toMatch(/^[0-9a-f]{24}$/);
    expect(new URL(await link.launchUrl('u1', 'txn1')).searchParams.get('passport')).toBe(p1); // estável
    expect(new URL(await link.launchUrl('u1', 'txn2')).searchParams.get('passport')).not.toBe(p1);
    expect(new URL(await link.launchUrl('u2', 'txn1')).searchParams.get('passport')).not.toBe(p1);
  });

  it('conecta com o link colado: guarda só o wstoken (sem o privatetoken) e usa host:usuário', async () => {
    const { link, conectarConta } = build();
    await link.connect('u1', 'txn1', await moodleReturn(link, 'u1', 'txn1'));
    expect(conectarConta).toHaveBeenCalledWith({
      userId: 'u1',
      provider: 'MOODLE',
      accountKey: 'ava.ufba.br:luiz.a',
      siteUrl: SITE,
      secretPlain: expect.any(Secret),
    });
    expect(conectarConta.mock.calls[0][0].secretPlain.reveal()).toBe(WSTOKEN);
  });

  it('aceita o endereço entregue pelo tratador web+ufba (como chega em /oauth/moodle/capture)', async () => {
    const { link, conectarConta } = build();
    const mm = await moodleReturn(link, 'u1', 'txn1');
    await link.connect('u1', 'txn1', mm.replace('moodlemobile://', 'web+ufba://'));
    expect(conectarConta).toHaveBeenCalledTimes(1);
  });

  it('aceita o link com espaços/quebra de linha ao redor e também só o base64', async () => {
    const { link, conectarConta } = build();
    const full = await moodleReturn(link, 'u1', 'txn1');
    await link.connect('u1', 'txn1', `  ${full}\n`);
    await link.connect('u1', 'txn1', full.replace('moodlemobile://token=', ''));
    expect(conectarConta).toHaveBeenCalledTimes(2);
  });

  it('recusa link de outro pedido (passport não confere)', async () => {
    const { link, conectarConta } = build();
    const doOutro = await moodleReturn(link, 'u1', 'txn-outro');
    await expect(link.connect('u1', 'txn1', doOutro)).rejects.toThrow('não é deste pedido');
    await expect(link.connect('u2', 'txn1', await moodleReturn(link, 'u1', 'txn1'))).rejects.toThrow(MoodleLinkError);
    expect(conectarConta).not.toHaveBeenCalled();
  });

  it.each([['lixo qualquer'], [''], ['moodlemobile://token=%%%'], ['moodlemobile://token=YWJj']])(
    'recusa texto inválido (%j)',
    async (txt) => {
      const { link, conectarConta } = build();
      await expect(link.connect('u1', 'txn1', txt)).rejects.toThrow(MoodleLinkError);
      expect(conectarConta).not.toHaveBeenCalled();
    },
  );

  it('recusa token que o Moodle rejeita, sem vazar o token na mensagem', async () => {
    const { link, conectarConta } = build({ exception: 'x', errorcode: 'invalidtoken', message: `ruim ${WSTOKEN}` });
    const err = await link.connect('u1', 'txn1', await moodleReturn(link, 'u1', 'txn1')).catch((e) => e);
    expect(err).toBeInstanceOf(MoodleLinkError);
    expect(String(err.message)).not.toContain(WSTOKEN);
    expect(conectarConta).not.toHaveBeenCalled();
  });
});
