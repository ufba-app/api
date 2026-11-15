-- CreateTable
CREATE TABLE "sigaa_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "login" TEXT NOT NULL,
    "cookie_ciphertext" TEXT,
    "cookie_iv" TEXT,
    "cookie_auth_tag" TEXT,
    "last_used_at" TIMESTAMP(3),
    "lock_token" TEXT,
    "locked_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sigaa_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sigaa_sessions_user_id_login_key" ON "sigaa_sessions"("user_id", "login");

-- AddForeignKey
ALTER TABLE "sigaa_sessions" ADD CONSTRAINT "sigaa_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

