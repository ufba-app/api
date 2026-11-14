const NAME_MAX = 60;

/** Nome para mostrar: sem controle nem caracteres de direção (bidi), espaços colapsados, até 60 caracteres. */
export function sanitizeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  const chars = [...clean];
  return chars.length > NAME_MAX ? chars.slice(0, NAME_MAX - 1).join('') + '…' : clean;
}
