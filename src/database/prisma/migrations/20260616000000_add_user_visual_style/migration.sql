-- CreateTable
CREATE TABLE "UserVisualStyle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserVisualStyle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserVisualStyle_userId_idx" ON "UserVisualStyle"("userId");

-- AddForeignKey
ALTER TABLE "UserVisualStyle" ADD CONSTRAINT "UserVisualStyle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
