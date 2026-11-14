-- CreateTable
CREATE TABLE "memory_projects" (
    "id" UUID NOT NULL,
    "workspace" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "owner_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_project_members" (
    "project_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "user_id" UUID,
    "level" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "invited_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_project_members_pkey" PRIMARY KEY ("project_id","email")
);

-- CreateTable
CREATE TABLE "memory_sync_jobs" (
    "user_id" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_sync_jobs_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "memory_projects_owner_id_idx" ON "memory_projects"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_projects_workspace_project_key" ON "memory_projects"("workspace", "project");

-- CreateIndex
CREATE INDEX "memory_project_members_user_id_idx" ON "memory_project_members"("user_id");

-- CreateIndex
CREATE INDEX "memory_project_members_email_idx" ON "memory_project_members"("email");

-- CreateIndex
CREATE INDEX "memory_sync_jobs_next_run_at_idx" ON "memory_sync_jobs"("next_run_at");

-- AddForeignKey
ALTER TABLE "memory_projects" ADD CONSTRAINT "memory_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_project_members" ADD CONSTRAINT "memory_project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "memory_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_project_members" ADD CONSTRAINT "memory_project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Projetos do time (ufba-app/{api,web,docs}), criados antes de qualquer usuario (S12): ownerId nulo = time.
INSERT INTO "memory_projects" ("id", "workspace", "project", "title", "owner_id")
VALUES
  (gen_random_uuid(), 'ufba-app', 'api', 'API', NULL),
  (gen_random_uuid(), 'ufba-app', 'web', 'Web', NULL),
  (gen_random_uuid(), 'ufba-app', 'docs', 'Docs', NULL)
ON CONFLICT ("workspace", "project") DO NOTHING;
