import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCalendarLinks } from './supac-links';

const PAGE = 'https://supac.ufba.br/calendario-academico';

describe('parseCalendarLinks', () => {
  it('na página real da SUPAC (15/11/2026): só os PDFs cujo texto é um semestre, resolvidos contra a página', () => {
    const html = readFileSync(join(__dirname, '__fixtures__', 'supac-page.html'), 'utf-8');
    const links = parseCalendarLinks(html, PAGE);
    expect(links.map((l) => l.term)).toEqual(['2026.2', '2026.1', '2025.2', '2025.1', '2024.2', '2024.1', '2023.2', '2023.1', '2022.2', '2022.1', '2021.2', '2021.1']);
    expect(links[0]).toEqual({ term: '2026.2', url: 'https://supac.ufba.br/sites/supac.ufba.br/files/calendario_2026.2_27.10.26.pdf' });
    expect(links.every((l) => l.url.startsWith('https://supac.ufba.br/') && l.url.endsWith('.pdf'))).toBe(true);
    // As resoluções do CONSEPE são PDF, mas o texto do link não é um semestre.
    expect(links.some((l) => /resolu/i.test(l.url))).toBe(false);
  });

  it('href absoluto, com barra inicial e sem barra; sem repetir a URL', () => {
    const html = [
      '<a href="https://supac.ufba.br/a/x.pdf"><span>2026.2</span></a>',
      '<a href="/b/y.pdf"> 2026.1 </a>',
      '<a href="c/z.pdf">2025.2</a>',
      '<a href="/b/y.pdf">2026.1</a>',
      '<a href="/b/resolucao.pdf">Resolução 01/2026</a>',
      '<a href="/b/outra.html">2025.1</a>',
      '<a href="javascript:void(0)">2024.1</a>',
    ].join('\n');
    expect(parseCalendarLinks(html, PAGE)).toEqual([
      { term: '2026.2', url: 'https://supac.ufba.br/a/x.pdf' },
      { term: '2026.1', url: 'https://supac.ufba.br/b/y.pdf' },
      { term: '2025.2', url: 'https://supac.ufba.br/c/z.pdf' },
    ]);
  });

  it('página sem nenhum link de calendário devolve lista vazia (o chamador trata como erro)', () => {
    expect(parseCalendarLinks('<html><a href="/x.pdf">Resolução</a></html>', PAGE)).toEqual([]);
  });
});
