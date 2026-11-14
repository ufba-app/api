-- CreateTable
CREATE TABLE "source_bindings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_bindings_user_id_provider_key" ON "source_bindings"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "source_bindings_provider_subject_hash_key" ON "source_bindings"("provider", "subject_hash");

-- AddForeignKey
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

