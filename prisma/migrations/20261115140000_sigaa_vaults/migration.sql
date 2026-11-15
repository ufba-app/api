-- CreateTable
CREATE TABLE "sigaa_vaults" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "login" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_auth_tag" TEXT NOT NULL,
    "status" "SourceAccountStatus" NOT NULL DEFAULT 'OK',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sigaa_vaults_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sigaa_vaults_user_id_key" ON "sigaa_vaults"("user_id");

-- AddForeignKey
ALTER TABLE "sigaa_vaults" ADD CONSTRAINT "sigaa_vaults_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

