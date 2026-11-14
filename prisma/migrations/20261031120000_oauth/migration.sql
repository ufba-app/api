-- AlterTable
ALTER TABLE "users" ADD COLUMN "email" TEXT;

-- CreateTable
CREATE TABLE "oauth_clients" (
    "client_id" TEXT NOT NULL,
    "client_name" TEXT,
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("client_id")
);

-- CreateTable
CREATE TABLE "oauth_pending" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "state" TEXT,
    "code_challenge" TEXT NOT NULL,
    "scope" TEXT,
    "user_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_pending_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "code_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "scope" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("code_hash")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "scope" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "oauth_pending_expires_at_idx" ON "oauth_pending"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_codes_expires_at_idx" ON "oauth_codes"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_tokens_user_id_idx" ON "oauth_tokens"("user_id");

-- CreateIndex
CREATE INDEX "oauth_tokens_expires_at_idx" ON "oauth_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
