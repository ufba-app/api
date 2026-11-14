/**
 * Vínculo fixo entre a conta do ufba.app e a conta da pessoa numa fonte, nos dois sentidos:
 * - uma conta da fonte (o CPF no SIGAA, o usuário do AVA no Moodle) só pertence a UMA conta do ufba.app;
 * - uma conta do ufba.app só fica ligada a UMA conta de cada fonte.
 * O perfil do aluno se molda a essa conta, então ela não troca. Para trocar, a pessoa exclui a conta do ufba.app.
 */

export type BoundSource = 'SIGAA' | 'MOODLE';

/** Quem é a pessoa na fonte, já normalizado (comparável). Nunca é guardado em claro: vira hash na infraestrutura. */
export interface SourceSubject {
  source: BoundSource;
  value: string;
}

/**
 * SIGAA: o login é o CPF. Com ou sem máscara (`000.000.000-00`), vira os 11 dígitos. Logins que não são CPF (contas
 * antigas) ficam como digitados, sem espaços nas pontas e em minúsculas.
 */
export function sigaaSubject(login: string): SourceSubject {
  const trimmed = login.trim();
  const digits = trimmed.replace(/[.\-\s]/g, '');
  const value = /^\d{11}$/.test(digits) ? digits : trimmed.toLowerCase();
  return { source: 'SIGAA', value };
}

/** Moodle: o id numérico do usuário no AVA (não editável), com o host do AVA. */
export function moodleSubject(host: string, moodleUserId: number): SourceSubject {
  return { source: 'MOODLE', value: `${host.trim().toLowerCase()}:${moodleUserId}` };
}

/** O que o AVA diz de quem é o token. */
export interface MoodleIdentity {
  /** Método de login da conta no AVA. `shibboleth` = login institucional da UFBA. */
  auth: string;
  username: string;
}

/**
 * A conta do AVA é desta pessoa? Só contas do login institucional (Shibboleth), cujo usuário é o mesmo do e-mail
 * institucional do login do ufba.app (`luiz.a` ↔ `luiz.a@ufba.br`). O usuário do Moodle não é editável pelo aluno; o
 * e-mail do perfil do Moodle não entra na regra.
 */
export function moodleBelongsTo(m: MoodleIdentity, loginEmail: string, institutionalDomain: string): boolean {
  if (m.auth !== 'shibboleth') return false;
  const expected = `${m.username.trim().toLowerCase()}@${institutionalDomain.trim().toLowerCase()}`;
  return expected === loginEmail.trim().toLowerCase();
}

/** Vínculos que já existem, vistos do lado desta pessoa e do lado da conta da fonte. */
export interface BindingState {
  /** Hash do titular a que ESTA conta do ufba.app já está ligada nesta fonte, se houver. */
  mine: string | null;
  /** Conta do ufba.app dona deste titular, se houver. */
  ownerOfSubject: string | null;
}

export type BindingDecision = 'bind' | 'already_bound' | 'taken' | 'mismatch';

/**
 * - `already_bound`: esta conta já é dona deste titular (reconectar, outro navegador, senha nova);
 * - `mismatch`: esta conta já está ligada a OUTRO titular da fonte;
 * - `taken`: este titular já é de OUTRA conta do ufba.app;
 * - `bind`: ninguém ligado ainda, pode criar o vínculo.
 */
export function decideBinding(userId: string, subjectHash: string, state: BindingState): BindingDecision {
  if (state.mine !== null) return state.mine === subjectHash ? 'already_bound' : 'mismatch';
  if (state.ownerOfSubject !== null) return state.ownerOfSubject === userId ? 'already_bound' : 'taken';
  return 'bind';
}
