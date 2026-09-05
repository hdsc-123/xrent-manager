-- CreateTable
CREATE TABLE "MfaLoginProof" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaLoginProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaLoginProof_tokenHash_key" ON "MfaLoginProof"("tokenHash");

-- CreateIndex
CREATE INDEX "MfaLoginProof_userId_idx" ON "MfaLoginProof"("userId");

-- CreateIndex
CREATE INDEX "MfaLoginProof_expiresAt_idx" ON "MfaLoginProof"("expiresAt");

-- AddForeignKey
ALTER TABLE "MfaLoginProof" ADD CONSTRAINT "MfaLoginProof_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
