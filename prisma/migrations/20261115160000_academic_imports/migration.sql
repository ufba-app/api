-- CreateEnum
CREATE TYPE "AcademicImportStatus" AS ENUM ('RUNNING', 'NEEDS_CONFIRMATION', 'READY', 'FAILED');

-- DropIndex
DROP INDEX "transcript_entries_transcript_id_term_code_key";

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "reader" TEXT NOT NULL DEFAULT 'ai',
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "academic_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL,

    CONSTRAINT "academic_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_imports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "AcademicImportStatus" NOT NULL,
    "failure" TEXT,
    "program_id" TEXT,
    "draft" JSONB,
    "profile" JSONB,
    "verified" BOOLEAN,
    "reader" TEXT,
    "components_count" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "imported_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_import_log" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT,
    "verified" BOOLEAN,
    "components_count" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,

    CONSTRAINT "academic_import_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academic_consents_user_id_key" ON "academic_consents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_imports_user_id_key" ON "academic_imports"("user_id");

-- CreateIndex
CREATE INDEX "academic_import_log_user_id_started_at_idx" ON "academic_import_log"("user_id", "started_at");

-- CreateIndex
CREATE INDEX "academic_import_log_started_at_idx" ON "academic_import_log"("started_at");

-- AddForeignKey
ALTER TABLE "academic_consents" ADD CONSTRAINT "academic_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_imports" ADD CONSTRAINT "academic_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_import_log" ADD CONSTRAINT "academic_import_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

