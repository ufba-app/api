import { driveViewUrl, extractDriveLinks, parseDriveLink } from './drive-link';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('parseDriveLink: pastas', () => {
  it.each([
    `https://drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com/drive/folders/${ID}?usp=sharing`,
    `https://drive.google.com/drive/u/1/folders/${ID}`,
    `https://drive.google.com/drive/folderview?id=${ID}`,
  ])('reconhece a pasta %s', (url) => {
    expect(parseDriveLink(url)).toEqual({ kind: 'folder', id: ID });
  });

  it.each([
    `https://drive.google.com/drive/folders/curto`,
    `https://evil.example/drive/folders/${ID}`,
    `https://docs.google.com/drive/folders/${ID}`,
    `https://drive.google.com/drive/folderview?id=curto`,
  ])('recusa %s', (url) => {
    expect(parseDriveLink(url)).toBeNull();
  });

  it('driveViewUrl: o link que a PESSOA abre no navegador, por tipo', () => {
    expect(driveViewUrl({ kind: 'folder', id: ID })).toBe(`https://drive.google.com/drive/folders/${ID}`);
    expect(driveViewUrl({ kind: 'file', id: ID })).toBe(`https://drive.google.com/file/d/${ID}/view`);
    expect(driveViewUrl({ kind: 'doc', id: ID })).toBe(`https://docs.google.com/document/d/${ID}/edit`);
    expect(driveViewUrl({ kind: 'sheet', id: ID })).toBe(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(driveViewUrl({ kind: 'slides', id: ID })).toBe(`https://docs.google.com/presentation/d/${ID}/edit`);
  });
});

describe('parseDriveLink', () => {
  it.each([
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, { kind: 'file', id: ID }],
    [`https://drive.google.com/file/u/1/d/${ID}/view`, { kind: 'file', id: ID }],
    [`https://drive.google.com/open?id=${ID}`, { kind: 'file', id: ID }],
    [`https://drive.google.com/uc?export=download&id=${ID}`, { kind: 'file', id: ID }],
    [`https://docs.google.com/document/d/${ID}/edit`, { kind: 'doc', id: ID }],
    [`https://docs.google.com/document/u/0/d/${ID}/edit?tab=t.0`, { kind: 'doc', id: ID }],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, { kind: 'sheet', id: ID }],
    [`https://docs.google.com/presentation/d/${ID}/edit`, { kind: 'slides', id: ID }],
    [`http://drive.google.com/file/d/${ID}/view`, { kind: 'file', id: ID }],
  ])('reconhece %s', (url, esperado) => {
    expect(parseDriveLink(url)).toEqual(esperado);
  });

  it.each([
    `https://docs.google.com/forms/d/${ID}/edit`,
    `https://docs.google.com/document/d/e/2PACX-1vQ/pub`,
    `https://evil.example/file/d/${ID}/view`,
    `https://drive.google.com.evil.example/file/d/${ID}/view`,
    `https://evil.example/?u=https://drive.google.com/file/d/${ID}/view`,
    `https://user@drive.google.com@evil.example/file/d/${ID}/view`,
    `https://drive.google.com/file/d/curto/view`,
    `https://drive.google.com/file/d/${ID}%2F..%2Fx/view`,
    `ftp://drive.google.com/file/d/${ID}/view`,
    `javascript:alert(1)`,
    `não é url`,
    ``,
  ])('recusa %s', (url) => {
    expect(parseDriveLink(url)).toBeNull();
  });

  it('o subdomínio de outro host do Google não vale (só drive.google.com e docs.google.com)', () => {
    expect(parseDriveLink(`https://script.google.com/file/d/${ID}/view`)).toBeNull();
    expect(parseDriveLink(`https://sites.google.com/document/d/${ID}/edit`)).toBeNull();
  });
});

describe('extractDriveLinks', () => {
  it('acha hrefs (com o texto do link como nome) e URLs soltas, sem repetir, na ordem', () => {
    const html =
      `<p>Slides: <a href="https://docs.google.com/presentation/d/${ID}/edit?usp=sharing&amp;x=1">Aula 3</a></p>` +
      `<p>Lista: https://drive.google.com/file/d/${ID.replace('1A', '2B')}/view</p>` +
      `<a href='https://drive.google.com/file/d/${ID.replace('1A', '3C')}/view'><b>Lista 2</b></a>` +
      `<a href="https://docs.google.com/presentation/d/${ID}/edit">de novo</a>` +
      `<a href="https://exemplo.com/x">fora</a>`;
    const r = extractDriveLinks(html, [`https://docs.google.com/document/d/${ID.replace('1A', '4D')}/edit`]);
    expect(r.map((l) => [l.kind, l.id.slice(0, 2), l.label])).toEqual([
      ['doc', '4D', undefined],
      ['slides', '1A', 'Aula 3'],
      ['file', '2B', undefined],
      ['file', '3C', 'Lista 2'],
    ]);
  });

  it('o texto do link que é só a URL não vira nome', () => {
    const u = `https://drive.google.com/file/d/${ID}/view`;
    expect(extractDriveLinks(`<a href="${u}">${u}</a>`)[0].label).toBeUndefined();
  });

  it('sem HTML e sem URLs: vazio; links de fora e pastas são ignorados', () => {
    expect(extractDriveLinks(undefined)).toEqual([]);
    expect(extractDriveLinks(`<a href="https://docs.google.com/forms/d/${ID}/edit">form</a> https://evil.example/x`)).toEqual([]);
    expect(extractDriveLinks(`<a href="https://drive.google.com/drive/folders/${ID}">Slides / Arquivos</a>`)).toEqual([{ kind: 'folder', id: ID, label: 'Slides / Arquivos' }]);
  });

  it('no máximo 50 links por chamada', () => {
    const urls = Array.from({ length: 80 }, (_, i) => `https://drive.google.com/file/d/${String(i).padStart(12, 'a')}/view`);
    expect(extractDriveLinks(undefined, urls)).toHaveLength(50);
  });
});
