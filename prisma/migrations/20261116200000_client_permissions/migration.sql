-- CreateTable
CREATE TABLE "client_permissions" (
    "user_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_permissions_pkey" PRIMARY KEY ("user_id","client_id","key")
);

-- CreateIndex
CREATE INDEX "client_permissions_user_id_idx" ON "client_permissions"("user_id");

-- AddForeignKey
ALTER TABLE "client_permissions" ADD CONSTRAINT "client_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
