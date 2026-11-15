import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('schema da cópia do SIASB', () => {
  it('os quatro modelos apagam em cascata com a pessoa (garante DELETE /me)', () => {
    const src = readFileSync(join(__dirname, '..', 'prisma', 'models', 'siasb', 'siasb-copy.prisma'), 'utf8');
    const blocks = src.split(/^model /m).slice(1);
    expect(blocks.map((b) => b.split(/\s/)[0]).sort()).toEqual(['SiasbSyncState', 'SiasbSyncedAttendance', 'SiasbSyncedDiscipline', 'SiasbSyncedSession']);
    for (const b of blocks) expect(b).toMatch(/@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
  });
});
