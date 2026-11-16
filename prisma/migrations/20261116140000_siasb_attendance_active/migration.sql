-- AlterTable
ALTER TABLE "siasb_attendances" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT false;

-- As linhas antigas não têm a origem real (ativo x inativo): o padrão false não é verdade. Força uma nova sincronização
-- (next_run_at nulo deixa a pessoa devida no próximo ciclo) e faz a cópia contar como nunca sincronizada
-- (last_success_at nulo), para nenhum aviso ser calculado a partir dessas linhas.
UPDATE "siasb_sync_state" SET "next_run_at" = NULL, "last_success_at" = NULL;
