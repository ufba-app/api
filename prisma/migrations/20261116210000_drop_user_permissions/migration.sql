-- As permissões passaram a ser por app (`client_permissions`). A tabela por pessoa só é apagada se estiver vazia: concessões
-- antigas valiam para todo app e NÃO são migradas (cada app exige consentimento explícito), então existir linha pede decisão humana.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user_permissions") THEN
    RAISE EXCEPTION 'user_permissions tem linhas: nao foi apagada. As permissoes agora sao por app (client_permissions) e as antigas nao sao migradas. Confira as linhas, decida e esvazie a tabela antes de repetir a migracao.';
  END IF;
END $$;

-- DropTable
DROP TABLE "user_permissions";
