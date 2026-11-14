-- CreateTable
CREATE TABLE "memory_users" (
    "user_id" UUID NOT NULL,
    "memory_username" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proxy_credential_id" TEXT,
    "proxy_key_ciphertext" TEXT,
    "proxy_key_iv" TEXT,
    "proxy_key_auth_tag" TEXT,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_users_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_users_memory_username_key" ON "memory_users"("memory_username");

-- AddForeignKey
ALTER TABLE "memory_users" ADD CONSTRAINT "memory_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

