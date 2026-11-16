-- CreateTable
CREATE TABLE "siasb_write_audit" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "attendance_id" TEXT,
    "target_id" TEXT,
    "result" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "siasb_write_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "siasb_write_audit_user_id_at_idx" ON "siasb_write_audit"("user_id", "at");

-- AddForeignKey
ALTER TABLE "siasb_write_audit" ADD CONSTRAINT "siasb_write_audit_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

