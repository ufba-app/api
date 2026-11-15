-- CreateTable
CREATE TABLE "siasb_attendances" (
    "user_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "discipline_id" TEXT NOT NULL,
    "discipline_name" TEXT NOT NULL,
    "treatment_type" TEXT NOT NULL,
    "concluded" BOOLEAN NOT NULL,
    "first_name_ciphertext" TEXT NOT NULL,
    "first_name_iv" TEXT NOT NULL,
    "first_name_auth_tag" TEXT NOT NULL,

    CONSTRAINT "siasb_attendances_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateTable
CREATE TABLE "siasb_sessions" (
    "user_id" UUID NOT NULL,
    "id" TEXT NOT NULL,
    "attendance_id" TEXT NOT NULL,
    "discipline_id" TEXT NOT NULL,
    "discipline_name" TEXT NOT NULL,
    "professor_name" TEXT NOT NULL,
    "location_name" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "rescheduled_start_at" TIMESTAMP(3),
    "status_label" TEXT NOT NULL,

    CONSTRAINT "siasb_sessions_pkey" PRIMARY KEY ("user_id","id")
);

-- CreateTable
CREATE TABLE "siasb_sync_state" (
    "user_id" UUID NOT NULL,
    "last_attempt_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "result" TEXT,
    "next_run_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "siasb_sync_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "siasb_sessions_user_id_start_at_idx" ON "siasb_sessions"("user_id", "start_at");

-- AddForeignKey
ALTER TABLE "siasb_attendances" ADD CONSTRAINT "siasb_attendances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "siasb_sessions" ADD CONSTRAINT "siasb_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "siasb_sync_state" ADD CONSTRAINT "siasb_sync_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

