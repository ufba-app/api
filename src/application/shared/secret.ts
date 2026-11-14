import { inspect } from 'node:util';

export const REDACTED = '[redacted]';

// O valor fica fora do objeto: espalhar ({...s}), clonar ou serializar o Secret não leva nada junto.
const values = new WeakMap<Secret, string>();

/**
 * Valor sensível (a senha do SIGAA). Impresso, interpolado, serializado em JSON ou inspecionado por log/console, vira
 * `[redacted]`. O valor real só sai por `reveal()`, chamado no último ponto possível (o corpo do login no SIGAA e a
 * cifragem no cofre). Ver o teste "canário" em test/secret-canary.spec.ts.
 */
export class Secret {
  private constructor(value: string) {
    values.set(this, value);
    Object.freeze(this);
  }

  static of(value: string): Secret {
    return new Secret(value);
  }

  reveal(): string {
    return values.get(this) ?? '';
  }

  isEmpty(): boolean {
    return this.reveal().length === 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
