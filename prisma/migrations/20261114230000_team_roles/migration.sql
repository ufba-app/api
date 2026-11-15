-- CreateTable
CREATE TABLE "team_roles" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "team_roles_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "team_role_grants" (
    "role_key" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "level" TEXT NOT NULL,

    CONSTRAINT "team_role_grants_pkey" PRIMARY KEY ("role_key","project_id")
);

-- CreateTable
CREATE TABLE "user_team_roles" (
    "user_id" UUID NOT NULL,
    "role_key" TEXT NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_team_roles_pkey" PRIMARY KEY ("user_id","role_key")
);

-- CreateIndex
CREATE INDEX "user_team_roles_role_key_idx" ON "user_team_roles"("role_key");

-- AddForeignKey
ALTER TABLE "team_role_grants" ADD CONSTRAINT "team_role_grants_role_key_fkey" FOREIGN KEY ("role_key") REFERENCES "team_roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_role_grants" ADD CONSTRAINT "team_role_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "memory_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_team_roles" ADD CONSTRAINT "user_team_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_team_roles" ADD CONSTRAINT "user_team_roles_role_key_fkey" FOREIGN KEY ("role_key") REFERENCES "team_roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;


-- Papeis do time (configuracao). Mudar aqui exige migracao/PR (escrita em docs publica no docs.ufba.app).
INSERT INTO "team_roles" ("key", "description") VALUES
  ('maintainer', 'Mantenedor: escreve em api, web e docs (publica no docs.ufba.app)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "team_role_grants" ("role_key", "project_id", "level")
SELECT 'maintainer', "id", 'write'
FROM "memory_projects" WHERE "workspace" = 'ufba-app' AND "project" IN ('api', 'web', 'docs')
ON CONFLICT DO NOTHING;
