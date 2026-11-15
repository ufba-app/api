-- Remove o papel 'dev' do time (sobra de 20261114230000_team_roles, que já rodou em produção e não pode ser editada).
-- Idempotente: sem o papel, não faz nada. Os grants e as atribuições também saem por cascata, mas ficam explícitos.
DELETE FROM "user_team_roles" WHERE "role_key" = 'dev';
DELETE FROM "team_role_grants" WHERE "role_key" = 'dev';
DELETE FROM "team_roles" WHERE "key" = 'dev';
