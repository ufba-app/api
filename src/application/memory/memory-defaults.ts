import { MemoryAccess, MemoryProjectRegistry } from './memory-ports';
import { MemoryProjectRepository, TeamGrantSource } from './project-ports';

/** Projetos do time criados antes de qualquer usuário (S12), para ninguém virar "criador" deles. */
export const SEEDED_PROJECTS: readonly (readonly [string, string])[] = [
  ['ufba-app', 'api'],
  ['ufba-app', 'web'],
  ['ufba-app', 'docs'],
];

export class SeededProjectRegistry extends MemoryProjectRegistry {
  private readonly set: Set<string>;
  constructor(seeded: readonly (readonly [string, string])[] = SEEDED_PROJECTS) {
    super();
    this.set = new Set(seeded.map(([w, p]) => `${w}/${p}`));
  }
  async isRegistered(workspace: string, project: string): Promise<boolean> {
    return this.set.has(`${workspace}/${project}`);
  }
}

export class OpenMemoryAccess extends MemoryAccess {
  async canUse(): Promise<boolean> {
    return true;
  }
}

/** URL pública do memory que o instalador grava (a mesma que a API usa; sem barra final). */
export function memoryPublicUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MEMORY_URL || 'https://memory.ufba.app').replace(/\/+$/, '');
}

/** Projetos registrados = os que a ufba.app conhece (`memory_projects`); o proxy não aceita outro (S12). */
export class DbProjectRegistry extends MemoryProjectRegistry {
  constructor(private readonly projects: MemoryProjectRepository) {
    super();
  }
  async isRegistered(workspace: string, project: string): Promise<boolean> {
    return (await this.projects.findByCoordinates(workspace, project)) !== null;
  }
}

/** Sem papéis do time (a etapa 8 troca por tabelas). */
export class NoTeamGrants extends TeamGrantSource {
  async grantsFor(): Promise<{ projectId: string; level: 'read' | 'write' }[]> {
    return [];
  }
  async involvedUserIds(): Promise<string[]> {
    return [];
  }
}
