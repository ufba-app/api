-- Limpeza da revisão de segurança da DK (sem mudança de schema; só dados).
--
-- B1: a cópia única 'ufba-web' (uma por pessoa) saiu: a cópia da DK do painel agora é POR SESSÃO ('ufba-web:<sessão>').
-- Nenhuma sessão abre mais a linha antiga.
DELETE FROM "sigaa_credentials" WHERE "client_id" = 'ufba-web';

-- B3: formato antigo (a senha cifrada por cliente, antes do cofre com DK). Sem cofre (sigaa_vaults) essas linhas nunca mais
-- são lidas: seriam ciphertext órfão guardado sem prazo. O cliente pede reautorização.
DELETE FROM "sigaa_credentials" WHERE "user_id" NOT IN (SELECT "user_id" FROM "sigaa_vaults");
