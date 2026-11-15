import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', name), 'utf-8')) as {
  build?: Record<string, unknown>;
  deploy?: Record<string, unknown>;
};

describe('configuração do Railway', () => {
  it('o cron do calendário tem config própria: Dockerfile, comando do job, agendamento semanal em UTC, sem healthcheck e sem reinício', () => {
    const cron = read('railway.cron.json');
    expect(cron.build).toEqual({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' });
    expect(cron.deploy).toEqual({
      startCommand: 'node dist/src/calendar-job.js',
      cronSchedule: '0 9 * * 1',
      restartPolicyType: 'NEVER',
    });
    expect(cron.deploy).not.toHaveProperty('healthcheckPath');
    expect(cron.deploy).not.toHaveProperty('restartPolicyMaxRetries');
  });

  it('o railway.json da API continua com healthcheck e sem agendamento nem comando de job', () => {
    const api = read('railway.json');
    expect(api.deploy).toMatchObject({ healthcheckPath: '/health', restartPolicyType: 'ON_FAILURE' });
    expect(api.deploy).not.toHaveProperty('cronSchedule');
    expect(api.deploy).not.toHaveProperty('startCommand');
  });

  it('o comando do job existe no build e o job não depende do migrate do CMD do Dockerfile', () => {
    const docker = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf-8');
    // O migrate só está no CMD; o startCommand do cron o substitui (a API é quem migra).
    expect(docker).toMatch(/CMD \[.*prisma migrate deploy.*main\.js/);
    const job = readFileSync(join(__dirname, '..', 'src', 'calendar-job.ts'), 'utf-8');
    expect(job).toContain('process.exit(code)');
    expect(job).not.toContain('migrate');
  });
});
