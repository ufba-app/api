import { Logger } from '@nestjs/common';
import { inspect } from 'node:util';
import { Secret } from '../src/application/shared/secret';
import { CofreSigaa } from '../src/application/sigaa/cofre-sigaa';
import type { EncryptedSecret, SigaaCredentialRecord } from '../src/application/ports/repositories';
import { AesSecretCipher } from '../src/infrastructure/crypto/aes-secret-cipher';
import { createSigaaHttpClient } from '../src/infrastructure/sources/sigaa/http-client';
import { SigaaLink } from '../src/infrastructure/sources/sigaa/sigaa-link';
import { ApiErrorFilter } from '../src/interface/web/api-error.filter';
import { GoogleAuth, GoogleHttp } from '../src/infrastructure/sources/google/google-http';
import { accessOf } from '../src/infrastructure/sources/moodle/moodle-access';
import { MoodleClient } from '../src/infrastructure/sources/moodle/moodle-client';
import type { SourceContext } from '../src/application/ports/source-gateway';

/**
 * Teste "canário": a senha do SIGAA tem uma marca única e NADA que sai do processo (stdout, stderr, console, Logger
 * do Nest, mensagens e pilhas de erro, JSON de resposta) pode conter essa marca. Se alguém acrescentar um log que
 * imprima a senha, este teste quebra. Ver também test/web-api.spec.ts (mesma checagem no fluxo HTTP inteiro).
 */
const CANARIO = 'CANARIO-9f3a-senha-sigaa';

/** Captura tudo o que seria escrito no terminal ou no log enquanto `fn` roda. */
export async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const keep = (...a: unknown[]) => void out.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 10 }))).join(' '));
  const spies = [
    jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => (keep(String(c)), true)),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(keep)),
  ];
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return out.join('\n');
}

describe('Secret', () => {
  const s = Secret.of(CANARIO);

  it('só reveal() devolve o valor', () => {
    expect(s.reveal()).toBe(CANARIO);
    expect(Secret.of('').isEmpty()).toBe(true);
  });

  it('interpolação, String, JSON, inspect, espalhar e clonar não levam o valor', () => {
    const nested = { cred: { login: 'fulano', senha: s }, lista: [s] };
    const vistas = [
      `${s}`,
      String(s),
      s + '',
      JSON.stringify(nested),
      inspect(nested, { depth: 10, showHidden: true }),
      JSON.stringify({ ...s }),
      inspect(structuredClone(nested), { depth: 10 }),
      Object.keys(s).join(','),
    ];
    for (const v of vistas) expect(v).not.toContain(CANARIO);
  });
});

describe('canário: a senha do SIGAA nunca aparece em log nem em erro', () => {
  const LOGIN_PAGE = `<html><title>SIGAA</title><form name="loginForm" action="/sigaa/logar.do?dispatch=logOn">
<input type="hidden" name="token" value="t0k"/><input type="text" name="user.login"/>
<input type="password" name="user.senha"/></form></html>`;

  type Modo = 'ok' | 'senha_errada' | 'fora_do_ar' | 'rede';

  /** `fetch` falso sob o cliente HTTP REAL do SIGAA (o código que monta o corpo com a senha roda de verdade). */
  function fakeFetch(modo: () => Modo): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      void init;
      if (modo() === 'rede') throw new Error('rede fora');
      const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
        new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
      if (path === '/') return html('', 302, { location: '/sigaa/public/home.jsf', 'set-cookie': 'JSESSIONID=abc; Path=/' });
      if (path === '/sigaa/verTelaLogin.do') return html(LOGIN_PAGE);
      if (path.startsWith('/sigaa/logar.do')) {
        if (modo() === 'ok') return html('', 302, { location: '/sigaa/paginaInicial.do' });
        if (modo() === 'senha_errada') return html(`${LOGIN_PAGE} Usuário e/ou senha inválidos`);
        return html('<html><title>Manutenção</title></html>', 503);
      }
      return html('<html>portal</html>');
    }) as typeof fetch;
  }

  function montar() {
    let modo: Modo = 'ok';
    const rows = new Map<string, SigaaCredentialRecord>();
    const repo = {
      upsert: async (i: { userId: string; clientId: string; login: string; secret: EncryptedSecret }) => {
        const rec: SigaaCredentialRecord = { id: 'c1', ...i, status: 'OK', createdAt: new Date() };
        rows.set(`${i.userId}:${i.clientId}`, rec);
        return rec;
      },
      find: async (u: string, c: string) => rows.get(`${u}:${c}`) ?? null,
      setStatus: async () => undefined,
      delete: async () => undefined,
    };
    const cofre = new CofreSigaa(repo as never, (k) => new AesSecretCipher(k.toString('base64')));
    const http = createSigaaHttpClient('https://sigaa.test', fakeFetch(() => modo));
    const link = new SigaaLink(http);
    return { cofre, link, rows, setModo: (m: Modo) => (modo = m) };
  }

  it('conectar, errar, SIGAA fora, rede fora, gravar, abrir: nada vaza, nem logando tudo de propósito', async () => {
    const { cofre, link, rows, setModo } = montar();
    const senha = Secret.of(CANARIO);
    const filtro = new ApiErrorFilter();
    const resposta = () => {
      const r: { body?: unknown; status: (n: number) => typeof r; setHeader: () => typeof r; json: (b: unknown) => void; headersSent: boolean } = {
        headersSent: false,
        status: () => r,
        setHeader: () => r,
        json: (b) => void (r.body = b),
      };
      return r;
    };
    const respostas: unknown[] = [];
    const erros: unknown[] = [];

    const saida = await captureOutput(async () => {
      const log = new Logger('Canario');
      for (const m of ['senha_errada', 'fora_do_ar', 'rede'] as const) {
        setModo(m);
        const e = await link.validar(`txn-${m}`, 'fulano', senha, 'u1').catch((x: unknown) => x);
        erros.push(e);
        // Um descuido típico: logar o erro inteiro. Mesmo assim, nada da senha.
        console.error(e);
        log.error(e);
        const r = resposta();
        filtro.catch(e, { switchToHttp: () => ({ getResponse: () => r }) } as never);
        respostas.push(r.body);
      }

      setModo('ok');
      await link.validar('txn-ok', 'fulano', senha, 'u1');
      cofre.aguardar('txn-ok', { login: 'fulano', senha });
      // Descuido: logar o cofre inteiro, com a senha esperando em memória.
      console.log(cofre);
      cofre.vincularCodigo('txn-ok', 'hash-1');
      const k = await cofre.gravarNoToken('hash-1', { userId: 'u1', clientId: 'cli' });
      const aberto = await cofre.abrir({ userId: 'u1', clientId: 'cli' }, k!);
      console.log(aberto);
      log.log(JSON.stringify(aberto));
      expect(aberto!.senha.reveal()).toBe(CANARIO);

      // Erro inesperado (500) passando pelo filtro, que loga tipo e mensagem.
      const r = resposta();
      filtro.catch(new Error(`falhou ao processar ${senha}`), { switchToHttp: () => ({ getResponse: () => r }) } as never);
      respostas.push(r.body);
    });

    const tudo = [
      saida,
      ...erros.map((e) => (e instanceof Error ? `${e.message}\n${e.stack}\n${inspect(e)}` : String(e))),
      JSON.stringify(respostas),
      JSON.stringify([...rows.values()]),
    ].join('\n');
    expect(tudo).not.toContain(CANARIO);
    // Sanidade: a captura funcionou (senão o teste passaria em branco).
    expect(saida).toContain('Secret([redacted])');
  });
});

describe('canário: tokens do Moodle e do Google nunca aparecem em log nem em erro', () => {
  const WSTOKEN = 'CANARIO-moodle-wstoken-4b2c';
  const REFRESH = 'CANARIO-google-refresh-8e1d';
  const ACCESS = 'CANARIO-google-access-3a7f';

  it('Moodle: erro do servidor que repete o token, ctx e cliente logados inteiros', async () => {
    const ctx: SourceContext = {
      userId: 'u1',
      accountKey: 'ava.test:fulano',
      siteUrl: 'https://ava.test',
      credentials: { kind: 'token', token: Secret.of(WSTOKEN) },
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify({ exception: 'x', errorcode: 'invalidtoken', message: `token ${WSTOKEN} inválido` }), {
        status: 200,
      })) as typeof fetch;
    const erros: unknown[] = [];
    const saida = await captureOutput(async () => {
      const access = accessOf(ctx);
      console.log(ctx, access);
      const e = await new MoodleClient(fetchFn).call(access, 'core_webservice_get_site_info').catch((x: unknown) => x);
      erros.push(e);
      console.error(e);
    });
    const tudo = [saida, ...erros.map((e) => (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)))].join('\n');
    expect(tudo).not.toContain(WSTOKEN);
    expect(saida).toContain('Secret([redacted])');
  });

  it('Google: renovação, chamada com erro, auth e ctx logados inteiros', async () => {
    let tokenOk = true;
    const fetchFn = (async (url: string | URL) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return tokenOk
          ? new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }), { status: 200 })
          : new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      return new Response('{}', { status: 403 });
    }) as typeof fetch;
    const auth = new GoogleAuth({ clientId: 'cid', clientSecret: 'cs', fetchFn });
    const http = new GoogleHttp(auth, fetchFn);
    const rt = Secret.of(REFRESH);
    const erros: unknown[] = [];
    const saida = await captureOutput(async () => {
      erros.push(await http.get(rt, 'https://classroom.googleapis.com/v1/courses').catch((x: unknown) => x));
      console.log(auth, http, { credentials: { kind: 'token', token: rt } });
      tokenOk = false;
      erros.push(await new GoogleAuth({ clientId: 'cid', clientSecret: 'cs', fetchFn }).accessToken(rt).catch((x: unknown) => x));
      for (const e of erros) console.error(e);
    });
    const tudo = [saida, ...erros.map((e) => (e instanceof Error ? `${e.message}\n${e.stack}` : String(e)))].join('\n');
    expect(tudo).not.toContain(REFRESH);
    expect(tudo).not.toContain(ACCESS);
    expect(saida).toContain('Secret([redacted])');
  });
});

describe('canário: cópia mestra do SIGAA (passkey)', () => {
  // Sentinelas nos campos que o navegador cifra/gera: nenhum pode sair em log, erro ou resposta de erro.
  const CT = 'CANARIOcifradoPeloNavegador0123456789abc';
  const IV = 'CANARIOiv0123456'; // 16 caracteres = 12 bytes
  const SAL = 'CANARIOsalt' + 'x'.repeat(32); // 43 caracteres = 32 bytes
  const CRED = 'CANARIOcredencial-abc123';
  const slot = (id: string) => ({ credentialId: id, prfSalt: SAL, iv: IV, ciphertext: CT, label: 'iPhone' });

  it('as 4 rotas (listar, gravar, abrir, remover) e todos os seus erros não vazam nada além do que devolvem', async () => {
    const { SigaaPasskeys } = await import('../src/application/web/sigaa-passkeys.service');
    const { InMemorySlots } = await import('./support/slot-fake');
    const { toApiError } = await import('../src/interface/web/api-error.filter');
    let aberto = true;
    const svc = new SigaaPasskeys(new InMemorySlots(), { sigaaOpens: async () => aberto } as never);
    const p = { userId: 'u1', clientId: 'ufba-web' };
    const erros: unknown[] = [];
    const tenta = async (f: () => Promise<unknown>) => void (await f().catch((e) => erros.push(e)));

    const out = await captureOutput(async () => {
      await svc.save(p, slot(CRED));
      await svc.list(p);
      await svc.slot(p, CRED);
      await tenta(() => svc.slot(p, CRED + '-nao-existe'));
      await tenta(() => svc.remove(p, CRED + '-nao-existe'));
      aberto = false;
      await tenta(() => svc.save(p, slot(CRED))); // SIGAA não conectado nesta sessão
      aberto = true;
      for (let i = 0; i < 5; i++) await tenta(() => svc.save(p, slot(`${CRED}-${i}`))); // chega ao limite
      for (let i = 0; i < 12; i++) await tenta(() => svc.slot(p, CRED)); // estoura as 10 por minuto
      await svc.remove(p, CRED);
    });

    expect(erros.length).toBeGreaterThan(3);
    const respostas = erros.map((e) => JSON.stringify(toApiError(e)) + String(e) + inspect(e, { depth: 10 }));
    for (const visto of [out, ...respostas]) {
      for (const s of [CT, IV, SAL, CRED, 'CANARIO']) expect(visto).not.toContain(s);
    }
  });
});

describe('canário: correio do QR (pairings)', () => {
  const PUB = 'CANARIOpub' + 'P'.repeat(77);
  const IV = 'CANARIOiv0123456';
  const CT = 'CANARIOpacoteLacrado0123456789abcdefghij';

  it('criar, ver, entregar e ler, mais os erros, não vazam o pacote nem o id do pedido', async () => {
    const { SigaaPairings } = await import('../src/application/web/sigaa-pairings.service');
    const { InMemoryPairings } = await import('./support/pairing-fake');
    const { toApiError } = await import('../src/interface/web/api-error.filter');
    const svc = new SigaaPairings(new InMemoryPairings());
    const dono = { userId: 'u1', clientId: 'ufba-web' };
    const outro = { userId: 'u2', clientId: 'ufba-web' };
    const erros: unknown[] = [];
    const tenta = async (f: () => Promise<unknown>) => void (await f().catch((e) => erros.push(e)));
    let id = '';

    const out = await captureOutput(async () => {
      id = (await svc.create(dono, { label: 'Firefox no Windows' })).id;
      await svc.info(dono, id);
      await tenta(() => svc.info(outro, id));
      await svc.deliver(dono, id, { pub: PUB, iv: IV, ciphertext: CT });
      await tenta(() => svc.deliver(dono, id, { pub: PUB, iv: IV, ciphertext: CT })); // já entregue
      await tenta(() => svc.deliver(outro, id, { pub: PUB, iv: IV, ciphertext: CT })); // outra conta
      await svc.read(dono, id);
      await tenta(() => svc.read(dono, id)); // uso único
      for (let i = 0; i < 12; i++) await tenta(() => svc.deliver(dono, id, { pub: PUB, iv: IV, ciphertext: CT })); // estoura 10/min
    });

    expect(erros.length).toBeGreaterThan(3);
    const respostas = erros.map((e) => JSON.stringify(toApiError(e)) + String(e) + inspect(e, { depth: 10 }));
    for (const visto of [out, ...respostas]) {
      for (const s of [PUB, IV, CT, id, 'CANARIO']) expect(visto).not.toContain(s);
    }
  });
});
