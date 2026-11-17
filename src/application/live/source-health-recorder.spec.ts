import type { SourceHealthRepository } from '../ports/source-health';
import { HEALTH_WRITE_THROTTLE_MS, SourceHealthRecorder } from './source-health-recorder';

function setup(fail = false) {
  let t = 1_000_000;
  const calls: string[] = [];
  const repo: SourceHealthRepository = {
    list: async () => [],
    recordSuccess: async (u, p, k, at) => {
      if (fail) throw new Error('db fora');
      calls.push(`ok ${u} ${p} ${k} ${at.getTime()}`);
    },
    recordFailure: async (u, p, k, r, at) => {
      if (fail) throw new Error('db fora');
      calls.push(`fail ${u} ${p} ${k} ${r} ${at.getTime()}`);
    },
  };
  return { rec: new SourceHealthRecorder(repo, () => t), calls, advance: (ms: number) => (t += ms) };
}

describe('SourceHealthRecorder', () => {
  it('não regrava o mesmo estado da mesma conta antes de 10 min', async () => {
    const { rec, calls, advance } = setup();
    await rec.success('u1', 'MOODLE', 'ava:a');
    await rec.success('u1', 'MOODLE', 'ava:a');
    advance(HEALTH_WRITE_THROTTLE_MS - 1);
    await rec.success('u1', 'MOODLE', 'ava:a');
    expect(calls).toHaveLength(1);
    advance(1);
    await rec.success('u1', 'MOODLE', 'ava:a');
    expect(calls).toHaveLength(2);
  });

  it('mudança de estado grava na hora; contas diferentes não se travam', async () => {
    const { rec, calls } = setup();
    await rec.success('u1', 'MOODLE', 'ava:a');
    await rec.failure('u1', 'MOODLE', 'ava:a', 'source_unavailable');
    await rec.failure('u1', 'MOODLE', 'ava:a', 'source_unavailable');
    await rec.success('u1', 'MOODLE', 'ava:b');
    expect(calls.map((c) => c.split(' ').slice(0, 1)[0] + c.split(' ')[3])).toEqual(['okava:a', 'failava:a', 'okava:b']);
  });

  it('nunca lança se o banco falha, e tenta de novo na próxima', async () => {
    const { rec } = setup(true);
    await expect(rec.success('u1', 'MOODLE', 'ava:a')).resolves.toBeUndefined();
    await expect(rec.failure('u1', 'SIGAA', 'sigaa:1', 'source_unavailable')).resolves.toBeUndefined();
  });
});
