import { Logger } from '@nestjs/common';
import { programLabelFor, resetProgramLabelWarnings } from './program-label';

describe('programLabelFor', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetProgramLabelWarnings();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('formato completo conhecido: não avisa', () => {
    programLabelFor('ENGENHARIA DA COMPUTAÇÃO/EPOLI - SALVADOR - BACHARELADO - PRESENCIAL - N');
    expect(warn).not.toHaveBeenCalled();
  });

  it('formato fora do padrão: avisa UMA vez por formato, sem o texto do curso', () => {
    programLabelFor('CURSO SECRETO - SALVADOR');
    programLabelFor('OUTRO CURSO SECRETO - CAMAÇARI');
    programLabelFor('CURSO X/ESC - SALVADOR - GRAU RARO - PRESENCIAL - D');
    programLabelFor('');
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      'formato do nome do curso fora do padrão: partial:2p',
      'formato do nome do curso fora do padrão: full:5p:desconhecido=grau+turno',
      'formato do nome do curso fora do padrão: raw',
    ]);
    expect(lines.join('\n')).not.toMatch(/SECRETO|Secreto|SALVADOR|Salvador|CAMAÇARI/);
  });
});
