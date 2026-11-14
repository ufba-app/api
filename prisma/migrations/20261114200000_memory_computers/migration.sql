-- CreateTable
CREATE TABLE "memory_computers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "key_preview" TEXT,
    "agents" TEXT[],
    "client_version" TEXT,
    "install_mode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "memory_computers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_authorizations" (
    "device_code_hash" TEXT NOT NULL,
    "user_code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "computer_name" TEXT,
    "os" TEXT,
    "request_ip" TEXT,
    "status" TEXT NOT NULL,
    "user_id" UUID,
    "interval_sec" INTEGER NOT NULL DEFAULT 5,
    "last_polled_at" TIMESTAMP(3),
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "token_hash" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_authorizations_pkey" PRIMARY KEY ("device_code_hash")
);

-- CreateIndex
CREATE INDEX "memory_computers_user_id_revoked_at_idx" ON "memory_computers"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "memory_computers_confirmed_at_created_at_idx" ON "memory_computers"("confirmed_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorizations_user_code_hash_key" ON "device_authorizations"("user_code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "device_authorizations_token_hash_key" ON "device_authorizations"("token_hash");

-- CreateIndex
CREATE INDEX "device_authorizations_expires_at_idx" ON "device_authorizations"("expires_at");

-- CreateIndex
CREATE INDEX "device_authorizations_request_ip_created_at_idx" ON "device_authorizations"("request_ip", "created_at");

-- AddForeignKey
ALTER TABLE "memory_computers" ADD CONSTRAINT "memory_computers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "memory_users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

