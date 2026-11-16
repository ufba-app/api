/** Uma permissão concedida a um app (cliente OAuth) por uma pessoa. */
export interface ClientPermissionRow {
  clientId: string;
  key: string;
}

/**
 * Permissões POR APP (`client_permissions`): linha existe = concedida àquele app; sem linha = negada. Só chave, nada de dado
 * da fonte. As chaves aqui já foram validadas pelo `PermissionsService`.
 */
export abstract class ClientPermissionRepository {
  /** As chaves concedidas a UM app. */
  abstract keysOf(userId: string, clientId: string): Promise<string[]>;
  /** Todas as concessões da pessoa, de todos os apps. */
  abstract listByUser(userId: string): Promise<ClientPermissionRow[]>;
  /** Troca o conjunto do app pelo informado (vazio limpa), de uma vez. */
  abstract replace(userId: string, clientId: string, keys: readonly string[], at: Date): Promise<void>;
  /** Retira uma chave de um app; `false` se ele não a tinha. */
  abstract revoke(userId: string, clientId: string, key: string): Promise<boolean>;
  /** Retira uma chave de TODOS os apps da pessoa. */
  abstract revokeEverywhere(userId: string, key: string): Promise<void>;
  /** Apaga tudo de um app (ao revogar o app). */
  abstract deleteClient(userId: string, clientId: string): Promise<void>;
  /** Apaga as linhas de uma fonte (chaves `<fonte>.*`), em todos os apps, ao desconectar a fonte. */
  abstract deleteBySource(userId: string, source: string): Promise<void>;
}
