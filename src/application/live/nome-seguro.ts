/**
 * Nome de arquivo seguro para o Moodle: só o último segmento, sem controle, até 255 caracteres (preserva a extensão).
 * Fica na aplicação para que a checagem de extensão use o mesmo nome que o Moodle recebe.
 */
export function nomeSeguro(nome: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (nome.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const limpo = base === '' || base === '.' || base === '..' ? 'arquivo' : base;
  if (limpo.length <= 255) return limpo;
  const ponto = limpo.lastIndexOf('.');
  const ext = ponto > 0 && limpo.length - ponto <= 32 ? limpo.slice(ponto) : '';
  return limpo.slice(0, 255 - ext.length) + ext;
}
