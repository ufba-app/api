-- DropIndex
DROP INDEX "oauth_clients_logo_hash_key";

-- CreateIndex
CREATE INDEX "oauth_clients_logo_hash_idx" ON "oauth_clients"("logo_hash");

