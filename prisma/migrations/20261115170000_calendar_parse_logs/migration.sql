-- CreateTable
CREATE TABLE "calendar_parse_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_url" TEXT NOT NULL,
    "source_sha256" TEXT,
    "term" TEXT,
    "status" TEXT NOT NULL,
    "verified" BOOLEAN,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "contract" JSONB,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "seen_by" UUID,
    "seen_at" TIMESTAMP(3),

    CONSTRAINT "calendar_parse_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_parse_logs_source_sha256_key" ON "calendar_parse_logs"("source_sha256");

-- CreateIndex
CREATE INDEX "calendar_parse_logs_status_seen_idx" ON "calendar_parse_logs"("status", "seen");

-- CreateIndex
CREATE INDEX "calendar_parse_logs_term_idx" ON "calendar_parse_logs"("term");
