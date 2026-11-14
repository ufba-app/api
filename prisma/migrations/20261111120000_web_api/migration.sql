-- AlterTable
ALTER TABLE "oauth_clients" ADD COLUMN     "logo_bytes" BYTEA,
ADD COLUMN     "logo_hash" TEXT,
ADD COLUMN     "logo_mime" TEXT;

-- AlterTable
ALTER TABLE "oauth_tokens" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "last_used_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_logo_hash_key" ON "oauth_clients"("logo_hash");

