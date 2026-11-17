import type { SourceHealthRow } from '../ports/source-health';
import { accountHealth, fromRecord, sigaaHealth, siasbHealth } from './connection-health';

const T = new Date('2026-11-16T12:00:00Z');
const NOW = T.getTime();
const H = 60 * 60 * 1000;
const row = (o: Partial<SourceHealthRow>): SourceHealthRow => ({
  provider: 'MOODLE',
  accountKey: 'a',
  state: 'ok',
  reason: null,
  lastSuccessAt: T,
  lastFailureAt: null,
  ...o,
});

describe('saúde: SIGAA, Moodle e Classroom', () => {
  it('desconectado não tem saúde', () => {
    expect(sigaaHealth('disconnected', undefined)).toBeNull();
  });
  it('senha pedida e trancado exigem ação', () => {
    expect(sigaaHealth('password_required', undefined)).toMatchObject({ state: 'action_required', reason: 'password_required', action: 'reconnect' });
    expect(sigaaHealth('locked', row({}))).toMatchObject({ state: 'action_required', reason: 'locked', action: 'unlock' });
  });
  it('conectado: sem registro é unknown/never_read; ok com último sucesso; falha vira degraded', () => {
    expect(sigaaHealth('connected', undefined)).toMatchObject({ state: 'unknown', reason: 'never_read', since: null });
    expect(fromRecord('O AVA', row({}))).toEqual({ state: 'ok', reason: null, message: 'Funcionando.', action: null, since: T.toISOString() });
    const falha = new Date(NOW - H);
    expect(fromRecord('O AVA', row({ state: 'failing', reason: 'source_unavailable', lastFailureAt: falha }))).toMatchObject({
      state: 'degraded',
      reason: 'source_unavailable',
      action: 'retry',
      since: falha.toISOString(),
    });
  });
  it('conta que a fonte recusou: reconectar, mesmo com sucesso gravado antes', () => {
    expect(accountHealth('AVA', 'reconnect_required', row({}))).toMatchObject({
      state: 'action_required',
      reason: 'token_revoked',
      message: 'Reconecte o AVA: o acesso foi recusado ou expirou.',
      action: 'reconnect',
    });
  });
});

describe('saúde: SIASB', () => {
  const base = { status: 'connected' as const, expiresAt: null, syncedAt: new Date(NOW - H), syncResult: 'OK' as const, now: NOW };
  it('desconectado: null', () => expect(siasbHealth({ ...base, status: 'disconnected' })).toBeNull());
  it('sessão vencida ou sync que pediu reconexão: action_required', () => {
    expect(siasbHealth({ ...base, status: 'reconnect_required' })).toMatchObject({ state: 'action_required', reason: 'session_expired' });
    expect(siasbHealth({ ...base, syncResult: 'RECONNECT_REQUIRED' })).toMatchObject({ state: 'action_required', reason: 'session_expired' });
  });
  it('SIASB fora do ar na última sincronização: degraded', () => {
    expect(siasbHealth({ ...base, syncResult: 'UNAVAILABLE' })).toMatchObject({ state: 'degraded', reason: 'source_unavailable' });
  });
  it('cópia com mais de 3 h: stale_copy com as horas na frase', () => {
    expect(siasbHealth({ ...base, syncedAt: new Date(NOW - 5 * H - 1000) })).toMatchObject({
      state: 'degraded',
      reason: 'stale_copy',
      message: 'Os dados do SIASB são de 5 h atrás.',
    });
  });
  it('fim estimado em até 3 dias: expiring_soon', () => {
    expect(siasbHealth({ ...base, expiresAt: new Date(NOW + 2 * 24 * H) })).toMatchObject({ state: 'degraded', reason: 'expiring_soon', action: 'reconnect' });
  });
  it('nunca sincronizou: unknown; sincronizou há pouco: ok', () => {
    expect(siasbHealth({ ...base, syncedAt: null, syncResult: null })).toMatchObject({ state: 'unknown', reason: 'never_read' });
    expect(siasbHealth(base)).toMatchObject({ state: 'ok', reason: null });
  });
});
