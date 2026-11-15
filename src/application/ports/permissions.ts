export interface UserPermissionRow {
  key: string;
  enabled: boolean;
}

/** Interruptores por pessoa (`user_permissions`). Sem linha = desligado. Só chave e valor, nada de dado da fonte. */
export abstract class UserPermissionRepository {
  abstract list(userId: string): Promise<UserPermissionRow[]>;
  abstract set(userId: string, key: string, enabled: boolean, at: Date): Promise<void>;
  /** Apaga as linhas de uma fonte (chaves `<fonte>.*`), ao desconectar a fonte. */
  abstract deleteBySource(userId: string, source: string): Promise<void>;
}
