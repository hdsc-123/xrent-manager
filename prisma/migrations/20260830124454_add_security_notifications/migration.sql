-- CreateEnum
CREATE TYPE "SecurityNotificationType" AS ENUM ('EMAIL_CHANGED', 'PASSWORD_CHANGED', 'MFA_ENABLED', 'MFA_DISABLED', 'MFA_RECOVERY_CODES_REGENERATED', 'MFA_RESET', 'ROLE_OR_PERMISSIONS_CHANGED');

-- CreateTable
CREATE TABLE "SecurityNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SecurityNotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "auditLogId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityNotification_tenantId_idx" ON "SecurityNotification"("tenantId");

-- CreateIndex
CREATE INDEX "SecurityNotification_userId_readAt_idx" ON "SecurityNotification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "SecurityNotification_createdAt_idx" ON "SecurityNotification"("createdAt");

-- AddForeignKey
ALTER TABLE "SecurityNotification" ADD CONSTRAINT "SecurityNotification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityNotification" ADD CONSTRAINT "SecurityNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
