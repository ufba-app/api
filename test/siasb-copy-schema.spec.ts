import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('schema da cópia do SIASB', () => {
  const src = readFileSync(join(__dirname, '..', 'prisma', 'models', 'siasb', 'siasb-copy.prisma'), 'utf8');
  const blocks = src.split(/^model /m).slice(1);

  it('os modelos apagam em cascata com a pessoa (garante DELETE /me)', () => {
    expect(blocks.map((b) => b.split(/\s/)[0]).sort()).toEqual([
      'SiasbSyncState',
      'SiasbSyncedAttendance',
      'SiasbSyncedDiscipline',
      'SiasbSyncedSession',
      'SiasbWriteAudit',
    ]);
    for (const b of blocks) expect(b).toMatch(/@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
  });

  it('a auditoria das escritas não tem campo de texto livre', () => {
    const b = blocks.find((x) => x.startsWith('SiasbWriteAudit'))!;
    const fields = b
      .split('\n')
      .filter((l) => /^\s{2}\w+\s+\w+/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(fields.sort()).toEqual(['at', 'attendanceId', 'id', 'kind', 'result', 'targetId', 'user', 'userId']);
    expect(b).toMatch(/@@index\(\[userId, at\]\)/);
    expect(b).toMatch(/@@map\("siasb_write_audit"\)/);
  });
});
