Loaded Prisma config from "C:\Proyectos\Agente IA\api-webhook\prisma.config.ts".
-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('FRIO', 'TIBIO', 'CALIENTE', 'FINALIZADO', 'DESCARTADO');

-- CreateEnum
CREATE TYPE "CrmFollowUpStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDIENTE', 'CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIDA', 'FINALIZADO', 'DESCARTADO');

-- CreateEnum
CREATE TYPE "FinanceAccountType" AS ENUM ('COMPANY', 'PERSONAL');

-- CreateEnum
CREATE TYPE "FinanceTxStatus" AS ENUM ('ACTIVE', 'VOIDED', 'DELETED');

-- CreateEnum
CREATE TYPE "FinanceTxType" AS ENUM ('SALE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('enterprise', 'lite', 'unico', 'basico', 'intermedio', 'avanzado', 'personalizado');

-- CreateEnum
CREATE TYPE "PromptStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "RepeatType" AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'WEEKDAYS', 'EVERYDAY');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin', 'reseller', 'super_admin');

-- CreateEnum
CREATE TYPE "ThemeApp" AS ENUM ('Default', 'Red', 'Rose', 'Orange', 'Green', 'Blue', 'Yellow', 'Violet', 'Cyan', 'Black', 'White', 'Teal', 'MidnightBlue', 'AquaBlue', 'LightBlue');

-- CreateEnum
CREATE TYPE "TipoRegistro" AS ENUM ('REPORTE', 'SOLICITUD', 'PEDIDO', 'RECLAMO', 'PAGO', 'RESERVA', 'PRODUCTO');

-- CreateEnum
CREATE TYPE "TypePromptAi" AS ENUM ('TRAINING', 'FAQs', 'ACTIONS', 'DATA_CAPTURE', 'DATA_QUERY', 'ANALYZER');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('PAID', 'UNPAID');

-- CreateEnum
CREATE TYPE "ServiceAccessStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('WHATSAPP_RECEIPT', 'WOMPI_WEBHOOK', 'MANUAL');

-- CreateTable
CREATE TABLE "Account" (
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("provider","providerAccountId")
);

-- CreateTable
CREATE TABLE "AgentPrompt" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "status" "PromptStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sections" JSONB NOT NULL,
    "promptText" TEXT NOT NULL,
    "businessName" TEXT,
    "businessSector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPromptRevision" (
    "id" UUID NOT NULL,
    "promptId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "sectionsSnapshot" JSONB NOT NULL,
    "promptTextSnapshot" TEXT NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "AgentPromptRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'PENDIENTE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "serviceId" TEXT,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuidesUrl" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT,

    CONSTRAINT "GuidesUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instancias" (
    "id" SERIAL NOT NULL,
    "instanceName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "instanceType" TEXT DEFAULT 'Whatsapp',

    CONSTRAINT "Instancias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Manual" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Manual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "showInSidebar" BOOLEAN DEFAULT true,
    "hiddenModuleToSelector" BOOLEAN DEFAULT false,
    "adminOnly" BOOLEAN NOT NULL DEFAULT false,
    "requiresPremium" BOOLEAN NOT NULL DEFAULT false,
    "allowedPlans" "Plan"[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "showOnlySelectedPlans" BOOLEAN DEFAULT false,
    "customUrl" TEXT,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customUrl" TEXT,

    CONSTRAINT "ModuleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pausar" (
    "userId" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL DEFAULT 'Fue un gusto ayudarte.',
    "tipo" TEXT NOT NULL DEFAULT 'abrir',
    "baseurl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "apikeyId" TEXT NOT NULL,
    "instanciaId" TEXT NOT NULL,
    "id" SERIAL NOT NULL,

    CONSTRAINT "Pausar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(65,2) NOT NULL,
    "sku" TEXT,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "images" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptInstance" (
    "id" SERIAL NOT NULL,
    "instanceType" TEXT,
    "description" TEXT,
    "content" TEXT,
    "instanceId" INTEGER,
    "userId" TEXT NOT NULL,

    CONSTRAINT "PromptInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registro" (
    "tipo" "TipoRegistro" NOT NULL,
    "fecha" TIMESTAMP(3),
    "estado" TEXT,
    "resumen" TEXT,
    "lead" BOOLEAN,
    "nombre" TEXT,
    "detalles" TEXT,
    "meta" JSONB,
    "sessionId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "id" SERIAL NOT NULL,

    CONSTRAINT "Registro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reminders" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "time" TEXT,
    "repeatType" "RepeatType" DEFAULT 'NONE',
    "repeatEvery" INTEGER,
    "endsAt" TIMESTAMP(3),
    "instanceName" TEXT,
    "serverUrl" TEXT,
    "apikey" TEXT,
    "userId" TEXT,
    "workflowId" TEXT,
    "remoteJid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pushName" TEXT,
    "isSchedule" BOOLEAN DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isCampaign" BOOLEAN DEFAULT false,

    CONSTRAINT "Reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "messageText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "userId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "pushName" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" BOOLEAN NOT NULL,
    "id" SERIAL NOT NULL,
    "seguimientos" TEXT DEFAULT '',
    "inactividad" TEXT DEFAULT '',
    "sessionDelay" TEXT,
    "flujos" TEXT DEFAULT '',
    "remoteJidAlt" TEXT,
    "agentDisabled" BOOLEAN NOT NULL DEFAULT false,
    "signature_enabled" BOOLEAN NOT NULL DEFAULT false,
    "leadStatus" "LeadStatus",
    "lead_status_reason" TEXT,
    "lead_status_source_hash" TEXT,
    "lead_status_updated_at" TIMESTAMP(3),
    "lead_score" INTEGER,
    "lead_score_reason" TEXT,
    "lead_scored_at" TIMESTAMP(3),
    "assigned_advisor_id" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AntifloodBlock" (
    "id" SERIAL NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AntifloodBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionTag" (
    "sessionId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    CONSTRAINT "SessionTag_pkey" PRIMARY KEY ("sessionId","tagId")
);

-- CreateTable
CREATE TABLE "SessionTrigger" (
    "id" SERIAL NOT NULL,
    "time" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sessionId" INTEGER NOT NULL,

    CONSTRAINT "SessionTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMessage" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Sin título',
    "typePrompt" "TypePromptAi" DEFAULT 'TRAINING',

    CONSTRAINT "SystemMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "apiUrl" TEXT NOT NULL DEFAULT 'https://api.openAI.co',
    "company" TEXT NOT NULL DEFAULT 'Empresa Demo',
    "lat" TEXT NOT NULL DEFAULT '0.0000',
    "lng" TEXT NOT NULL DEFAULT '0.0000',
    "mapsUrl" TEXT NOT NULL DEFAULT 'https://maps.google.com/?q=0,0',
    "notificationNumber" TEXT NOT NULL DEFAULT '0000000000',
    "openingPhrase" TEXT DEFAULT 'DEPRECATED',
    "apiKeyId" TEXT,
    "del_seguimiento" TEXT DEFAULT 'Estamos para servirle.',
    "advisor_signature" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'basico',
    "autoReactivate" TEXT,
    "webhookUrl" TEXT DEFAULT 'https://n8npro.verzay.co/webhook',
    "theme" "ThemeApp" DEFAULT 'Default',
    "muteAgentResponses" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT,
    "meetingDuration" INTEGER,
    "onFacebook" BOOLEAN NOT NULL DEFAULT false,
    "onInstagram" BOOLEAN NOT NULL DEFAULT false,
    "aiModelId" TEXT,
    "defaultAiModelId" TEXT,
    "defaultProviderId" TEXT,
    "delayTimeGPT" TEXT,
    "meetingUrl" TEXT,
    "preferredCurrencyCode" TEXT NOT NULL DEFAULT 'COP',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "passPlainTxt" TEXT DEFAULT 'IA@verzay.1234',
    "enabledSynthesizer" BOOLEAN NOT NULL DEFAULT false,
    "status" BOOLEAN NOT NULL DEFAULT true,
    "enabledCrmFollowUps" BOOLEAN NOT NULL DEFAULT false,
    "enabledLeadStatusClassifier" BOOLEAN NOT NULL DEFAULT false,
    "enableVoiceResponses" BOOLEAN NOT NULL DEFAULT false,
    "voiceId" TEXT NOT NULL DEFAULT 'nova',
    "voiceInstructions" TEXT,
    "voiceModel" TEXT DEFAULT 'gpt-4o-mini-tts',
    "elevenLabsApiKey" TEXT,
    "elevenLabsVoiceId" TEXT,
    "ttsProvider" TEXT DEFAULT 'openai',
    "owner_id" TEXT,
    "advisor_role" TEXT,
    "advisor_available" BOOLEAN NOT NULL DEFAULT true,
    "auto_assign_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_assign_max_chats" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotificationContact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotificationContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_follow_ups" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceReportId" INTEGER,
    "remoteJid" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "leadStatusSnapshot" "LeadStatus" NOT NULL,
    "summary_snapshot" TEXT,
    "rule_key" TEXT NOT NULL,
    "source_hash" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "CrmFollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "cancel_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "max_attempts" INTEGER NOT NULL DEFAULT 2,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "generated_message" TEXT,
    "error_reason" TEXT,
    "last_processed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "goal_snapshot" TEXT,
    "prompt_snapshot" TEXT,
    "fallback_message_snapshot" TEXT,
    "allowed_weekdays_snapshot" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "send_start_time_snapshot" TEXT,
    "send_end_time_snapshot" TEXT,

    CONSTRAINT "crm_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_follow_up_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadStatus" "LeadStatus" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "delay_minutes" INTEGER NOT NULL DEFAULT 60,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "goal" TEXT,
    "prompt" TEXT,
    "fallback_message" TEXT,
    "allowed_weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "send_start_time" TEXT NOT NULL DEFAULT '08:00',
    "send_end_time" TEXT NOT NULL DEFAULT '18:00',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_follow_up_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAvailability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "UserAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("identifier")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateAt" TIMESTAMP(3) NOT NULL,
    "umbral" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isPro" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "triggerOnNewSession" BOOLEAN NOT NULL DEFAULT false,
    "isFunnelStep" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowExecutionLock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "lockKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowExecutionLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionWorkflowState" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "workflowId" TEXT NOT NULL,
    "currentNodeId" TEXT,
    "intentionAttempts" INTEGER NOT NULL DEFAULT 0,
    "intentionStatus" TEXT NOT NULL DEFAULT 'idle',
    "intentionData" JSONB,
    "lastPromptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionWorkflowState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEdge" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceHandle" TEXT NOT NULL DEFAULT 'default',
    "targetHandle" TEXT,

    CONSTRAINT "WorkflowEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNode" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT NOT NULL,
    "url" TEXT,
    "delay" TEXT,
    "inactividad" BOOLEAN,
    "name_file" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "posX" DOUBLE PRECISION,
    "posY" DOUBLE PRECISION,
    "intentionMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "intentionPrompt" TEXT,
    "keywords" TEXT,
    "miniPrompt" TEXT,
    "noMatchMessage" TEXT,
    "threshold" DOUBLE PRECISION,
    "followUpCancelOnReply" BOOLEAN NOT NULL DEFAULT true,
    "followUpGoal" TEXT,
    "followUpMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "followUpMode" TEXT NOT NULL DEFAULT 'static',
    "followUpPrompt" TEXT,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkflowNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "costPerToken" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modelName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aiModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinanceAccountType" NOT NULL DEFAULT 'PERSONAL',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "currencyCode" TEXT,

    CONSTRAINT "finance_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_attachments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_categories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FinanceTxType" NOT NULL,
    "color" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_currencies" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "finance_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "FinanceTxType" NOT NULL,
    "status" "FinanceTxStatus" NOT NULL DEFAULT 'ACTIVE',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "counterparty" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "discount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "extra" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sessionId" INTEGER,
    "externalReference" TEXT,
    "paymentSource" "PaymentSource",

    CONSTRAINT "finance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ia_credits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "used" INTEGER NOT NULL DEFAULT 0,
    "renewalDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ia_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "n8n_chat_histories" (
    "id" SERIAL NOT NULL,
    "session_id" VARCHAR(255) NOT NULL,
    "message" JSONB NOT NULL,

    CONSTRAINT "n8n_chat_histories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller" (
    "id" SERIAL NOT NULL,
    "resellerid" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "theme" "ThemeApp" NOT NULL DEFAULT 'Default',

    CONSTRAINT "reseller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "sent_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rr" (
    "id" SERIAL NOT NULL,
    "workflowId" TEXT,
    "mensaje" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT,

    CONSTRAINT "rr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seguimientos" (
    "id" SERIAL NOT NULL,
    "idNodo" TEXT,
    "serverurl" TEXT,
    "instancia" TEXT,
    "apikey" TEXT,
    "remoteJid" TEXT,
    "mensaje" TEXT,
    "tipo" TEXT,
    "time" TEXT,
    "name_file" TEXT,
    "consecutivo" TEXT,
    "media" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "error_reason" TEXT,
    "followUpAttempt" INTEGER NOT NULL DEFAULT 0,
    "followUpCancelOnReply" BOOLEAN NOT NULL DEFAULT true,
    "followUpGoal" TEXT,
    "followUpMaxAttempts" INTEGER NOT NULL DEFAULT 3,
    "followUpMode" TEXT NOT NULL DEFAULT 'static',
    "followUpPrompt" TEXT,
    "followUpStatus" TEXT NOT NULL DEFAULT 'pending',
    "generated_message" TEXT,
    "workflow_id" TEXT,

    CONSTRAINT "seguimientos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_client_data" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "source" TEXT DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_client_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_data_tool_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "toolDescription" TEXT NOT NULL,
    "toolType" TEXT NOT NULL DEFAULT 'search_by_field',
    "searchField" TEXT,
    "promptTemplate" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "toolCategory" TEXT NOT NULL DEFAULT 'data_query',

    CONSTRAINT "external_data_tool_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_ai_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "user_ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBilling" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "price" DECIMAL(18,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'COP',
    "paymentMethodLabel" TEXT,
    "paymentNotes" TEXT,
    "dueDate" TIMESTAMP(3),
    "billingStatus" "BillingStatus" NOT NULL DEFAULT 'UNPAID',
    "accessStatus" "ServiceAccessStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "lastPaymentAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "lastReminderDueDate" TIMESTAMP(3),
    "graceDays" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "notifyRemoteJid" TEXT,
    "serviceActiveDaysTotal" INTEGER NOT NULL DEFAULT 0,
    "serviceEndAt" TIMESTAMP(3),
    "serviceEndsAt" TIMESTAMP(3),
    "serviceName" TEXT,
    "serviceStartAt" TIMESTAMP(3),
    "lastInstanceName" TEXT,
    "licenseDays" INTEGER,

    CONSTRAINT "UserBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_follow_ups_archive" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceReportId" INTEGER,
    "remoteJid" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "leadStatusSnapshot" "LeadStatus" NOT NULL,
    "summary_snapshot" TEXT,
    "rule_key" TEXT NOT NULL,
    "source_hash" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "CrmFollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "cancel_on_reply" BOOLEAN NOT NULL DEFAULT true,
    "max_attempts" INTEGER NOT NULL DEFAULT 2,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "generated_message" TEXT,
    "error_reason" TEXT,
    "last_processed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "goal_snapshot" TEXT,
    "prompt_snapshot" TEXT,
    "fallback_message_snapshot" TEXT,
    "allowed_weekdays_snapshot" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "send_start_time_snapshot" TEXT,
    "send_end_time_snapshot" TEXT,

    CONSTRAINT "crm_follow_ups_archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baileys_contacts" (
    "id" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "pushName" TEXT,
    "phoneNumber" TEXT,
    "lastBody" TEXT,
    "lastType" TEXT,
    "lastAt" TIMESTAMP(3),
    "lastFromMe" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "baileys_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baileys_messages" (
    "id" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT,
    "type" TEXT NOT NULL DEFAULT 'conversation',
    "mediaUrl" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baileys_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatConversationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentTrigger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'keywords',
    "condition" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntentTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNavPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "displayLabel" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UserNavPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_UserModules" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_UserModules_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "AgentPrompt_agentId_idx" ON "AgentPrompt"("agentId");

-- CreateIndex
CREATE INDEX "AgentPrompt_businessName_idx" ON "AgentPrompt"("businessName");

-- CreateIndex
CREATE INDEX "AgentPrompt_businessSector_idx" ON "AgentPrompt"("businessSector");

-- CreateIndex
CREATE INDEX "AgentPrompt_sections_idx" ON "AgentPrompt" USING GIN ("sections");

-- CreateIndex
CREATE INDEX "AgentPrompt_status_idx" ON "AgentPrompt"("status");

-- CreateIndex
CREATE INDEX "AgentPrompt_userId_idx" ON "AgentPrompt"("userId");

-- CreateIndex
CREATE INDEX "AgentPromptRevision_publishedAt_idx" ON "AgentPromptRevision"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPromptRevision_promptId_revisionNumber_key" ON "AgentPromptRevision"("promptId", "revisionNumber");

-- CreateIndex
CREATE INDEX "Appointment_userId_startTime_idx" ON "Appointment"("userId", "startTime");

-- CreateIndex
CREATE INDEX "Appointment_sessionId_idx" ON "Appointment"("sessionId");

-- CreateIndex
CREATE INDEX "Appointment_serviceId_idx" ON "Appointment"("serviceId");

-- CreateIndex
CREATE INDEX "Instancias_userId_idx" ON "Instancias"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_userId_title_idx" ON "Product"("userId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_name_key" ON "PromptTemplate"("name");

-- CreateIndex
CREATE INDEX "Registro_tipo_fecha_idx" ON "Registro"("tipo", "fecha");

-- CreateIndex
CREATE INDEX "Registro_sessionId_idx" ON "Registro"("sessionId");

-- CreateIndex
CREATE INDEX "Service_userId_idx" ON "Service"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_remoteJid_idx" ON "Session"("userId", "remoteJid");

-- CreateIndex
CREATE INDEX "AntifloodBlock_blockedUntil_idx" ON "AntifloodBlock"("blockedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AntifloodBlock_remoteJid_instanceName_key" ON "AntifloodBlock"("remoteJid", "instanceName");

-- CreateIndex
CREATE UNIQUE INDEX "SessionTrigger_sessionId_key" ON "SessionTrigger"("sessionId");

-- CreateIndex
CREATE INDEX "SystemMessage_userId_idx" ON "SystemMessage"("userId");

-- CreateIndex
CREATE INDEX "Tag_userId_idx" ON "Tag"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_slug_key" ON "Tag"("userId", "slug");

-- CreateIndex
CREATE INDEX "Tools_userId_idx" ON "Tools"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "UserNotificationContact_userId_idx" ON "UserNotificationContact"("userId");

-- CreateIndex
CREATE INDEX "crm_follow_ups_sessionId_status_idx" ON "crm_follow_ups"("sessionId", "status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_status_scheduled_for_idx" ON "crm_follow_ups"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "crm_follow_ups_userId_status_idx" ON "crm_follow_ups"("userId", "status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_remoteJid_instanceId_status_idx" ON "crm_follow_ups"("remoteJid", "instanceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "crm_follow_ups_sessionId_rule_key_source_hash_key" ON "crm_follow_ups"("sessionId", "rule_key", "source_hash");

-- CreateIndex
CREATE INDEX "crm_follow_up_rules_user_idx" ON "crm_follow_up_rules"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_follow_up_rules_user_lead_status_uidx" ON "crm_follow_up_rules"("userId", "leadStatus");

-- CreateIndex
CREATE UNIQUE INDEX "UserAvailability_userId_dayOfWeek_startTime_endTime_key" ON "UserAvailability"("userId", "dayOfWeek", "startTime", "endTime");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_key" ON "VerificationToken"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_name_userId_key" ON "Workflow"("name", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowExecutionLock_lockKey_key" ON "WorkflowExecutionLock"("lockKey");

-- CreateIndex
CREATE INDEX "WorkflowExecutionLock_userId_instanceName_remoteJid_workflo_idx" ON "WorkflowExecutionLock"("userId", "instanceName", "remoteJid", "workflowId");

-- CreateIndex
CREATE INDEX "SessionWorkflowState_workflowId_idx" ON "SessionWorkflowState"("workflowId");

-- CreateIndex
CREATE INDEX "SessionWorkflowState_sessionId_idx" ON "SessionWorkflowState"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionWorkflowState_sessionId_workflowId_key" ON "SessionWorkflowState"("sessionId", "workflowId");

-- CreateIndex
CREATE INDEX "WorkflowEdge_workflowId_idx" ON "WorkflowEdge"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowEdge_sourceId_idx" ON "WorkflowEdge"("sourceId");

-- CreateIndex
CREATE INDEX "WorkflowEdge_targetId_idx" ON "WorkflowEdge"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEdge_workflowId_sourceId_sourceHandle_key" ON "WorkflowEdge"("workflowId", "sourceId", "sourceHandle");

-- CreateIndex
CREATE INDEX "WorkflowNode_workflowId_idx" ON "WorkflowNode"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_providerId_name_key" ON "ai_models"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_name_key" ON "ai_providers"("name");

-- CreateIndex
CREATE INDEX "finance_accounts_userId_idx" ON "finance_accounts"("userId");

-- CreateIndex
CREATE INDEX "finance_accounts_userId_currencyCode_idx" ON "finance_accounts"("userId", "currencyCode");

-- CreateIndex
CREATE UNIQUE INDEX "finance_accounts_userId_name_key" ON "finance_accounts"("userId", "name");

-- CreateIndex
CREATE INDEX "finance_attachments_transactionId_idx" ON "finance_attachments"("transactionId");

-- CreateIndex
CREATE INDEX "finance_attachments_userId_idx" ON "finance_attachments"("userId");

-- CreateIndex
CREATE INDEX "finance_categories_userId_type_idx" ON "finance_categories"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "finance_categories_userId_type_name_key" ON "finance_categories"("userId", "type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_externalReference_key" ON "finance_transactions"("externalReference");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_accountId_occurredAt_idx" ON "finance_transactions"("userId", "accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_categoryId_occurredAt_idx" ON "finance_transactions"("userId", "categoryId", "occurredAt");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_currencyCode_occurredAt_idx" ON "finance_transactions"("userId", "currencyCode", "occurredAt");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_occurredAt_idx" ON "finance_transactions"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_type_status_idx" ON "finance_transactions"("userId", "type", "status");

-- CreateIndex
CREATE INDEX "finance_transactions_userId_sessionId_occurredAt_idx" ON "finance_transactions"("userId", "sessionId", "occurredAt");

-- CreateIndex
CREATE INDEX "finance_transactions_paymentSource_idx" ON "finance_transactions"("paymentSource");

-- CreateIndex
CREATE UNIQUE INDEX "ia_credits_userId_key" ON "ia_credits"("userId");

-- CreateIndex
CREATE INDEX "weekly_reports_userId_idx" ON "weekly_reports"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "seguimientos_idempotencyKey_key" ON "seguimientos"("idempotencyKey");

-- CreateIndex
CREATE INDEX "external_client_data_userId_idx" ON "external_client_data"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "external_client_data_userId_remoteJid_key" ON "external_client_data"("userId", "remoteJid");

-- CreateIndex
CREATE INDEX "external_data_tool_configs_userId_idx" ON "external_data_tool_configs"("userId");

-- CreateIndex
CREATE INDEX "external_data_tool_configs_isEnabled_idx" ON "external_data_tool_configs"("isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "external_data_tool_configs_userId_toolKey_key" ON "external_data_tool_configs"("userId", "toolKey");

-- CreateIndex
CREATE UNIQUE INDEX "user_ai_configs_userId_providerId_key" ON "user_ai_configs"("userId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBilling_userId_key" ON "UserBilling"("userId");

-- CreateIndex
CREATE INDEX "UserBilling_accessStatus_idx" ON "UserBilling"("accessStatus");

-- CreateIndex
CREATE INDEX "UserBilling_billingStatus_idx" ON "UserBilling"("billingStatus");

-- CreateIndex
CREATE INDEX "UserBilling_dueDate_idx" ON "UserBilling"("dueDate");

-- CreateIndex
CREATE INDEX "UserBilling_serviceEndsAt_idx" ON "UserBilling"("serviceEndsAt");

-- CreateIndex
CREATE INDEX "crm_follow_ups_archive_remoteJid_instanceId_status_idx" ON "crm_follow_ups_archive"("remoteJid", "instanceId", "status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_archive_sessionId_status_idx" ON "crm_follow_ups_archive"("sessionId", "status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_archive_status_scheduled_for_idx" ON "crm_follow_ups_archive"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "crm_follow_ups_archive_userId_status_idx" ON "crm_follow_ups_archive"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "crm_follow_ups_archive_sessionId_rule_key_source_hash_idx" ON "crm_follow_ups_archive"("sessionId", "rule_key", "source_hash");

-- CreateIndex
CREATE INDEX "baileys_contacts_instanceName_idx" ON "baileys_contacts"("instanceName");

-- CreateIndex
CREATE INDEX "baileys_contacts_instanceName_lastAt_idx" ON "baileys_contacts"("instanceName", "lastAt");

-- CreateIndex
CREATE UNIQUE INDEX "baileys_contacts_instanceName_remoteJid_key" ON "baileys_contacts"("instanceName", "remoteJid");

-- CreateIndex
CREATE INDEX "baileys_messages_instanceName_remoteJid_timestamp_idx" ON "baileys_messages"("instanceName", "remoteJid", "timestamp");

-- CreateIndex
CREATE INDEX "baileys_messages_instanceName_timestamp_idx" ON "baileys_messages"("instanceName", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "baileys_messages_instanceName_messageId_key" ON "baileys_messages"("instanceName", "messageId");

-- CreateIndex
CREATE INDEX "ChatConversationPreference_userId_pinnedAt_idx" ON "ChatConversationPreference"("userId", "pinnedAt");

-- CreateIndex
CREATE INDEX "ChatConversationPreference_userId_archivedAt_idx" ON "ChatConversationPreference"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "ChatConversationPreference_userId_deletedAt_idx" ON "ChatConversationPreference"("userId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversationPreference_userId_remoteJid_key" ON "ChatConversationPreference"("userId", "remoteJid");

-- CreateIndex
CREATE INDEX "IntentTrigger_userId_idx" ON "IntentTrigger"("userId");

-- CreateIndex
CREATE INDEX "IntentTrigger_userId_isActive_idx" ON "IntentTrigger"("userId", "isActive");

-- CreateIndex
CREATE INDEX "UserNavPreference_userId_idx" ON "UserNavPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNavPreference_userId_moduleId_key" ON "UserNavPreference"("userId", "moduleId");

-- CreateIndex
CREATE INDEX "_UserModules_B_index" ON "_UserModules"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPrompt" ADD CONSTRAINT "AgentPrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPromptRevision" ADD CONSTRAINT "AgentPromptRevision_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "AgentPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPromptRevision" ADD CONSTRAINT "AgentPromptRevision_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instancias" ADD CONSTRAINT "Instancias_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleItem" ADD CONSTRAINT "ModuleItem_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pausar" ADD CONSTRAINT "Pausar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptInstance" ADD CONSTRAINT "PromptInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registro" ADD CONSTRAINT "Registro_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTag" ADD CONSTRAINT "SessionTag_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTag" ADD CONSTRAINT "SessionTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTrigger" ADD CONSTRAINT "SessionTrigger_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemMessage" ADD CONSTRAINT "SystemMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tools" ADD CONSTRAINT "Tools_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_defaultAiModelId_fkey" FOREIGN KEY ("defaultAiModelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotificationContact" ADD CONSTRAINT "UserNotificationContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_sourceReportId_fkey" FOREIGN KEY ("sourceReportId") REFERENCES "Registro"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_up_rules" ADD CONSTRAINT "crm_follow_up_rules_user_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAvailability" ADD CONSTRAINT "UserAvailability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionWorkflowState" ADD CONSTRAINT "SessionWorkflowState_currentNodeId_fkey" FOREIGN KEY ("currentNodeId") REFERENCES "WorkflowNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionWorkflowState" ADD CONSTRAINT "SessionWorkflowState_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionWorkflowState" ADD CONSTRAINT "SessionWorkflowState_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEdge" ADD CONSTRAINT "WorkflowEdge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "WorkflowNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEdge" ADD CONSTRAINT "WorkflowEdge_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "WorkflowNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEdge" ADD CONSTRAINT "WorkflowEdge_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNode" ADD CONSTRAINT "WorkflowNode_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "finance_currencies"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_attachments" ADD CONSTRAINT "finance_attachments_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "finance_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_attachments" ADD CONSTRAINT "finance_attachments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_categories" ADD CONSTRAINT "finance_categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "finance_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "finance_currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ia_credits" ADD CONSTRAINT "ia_credits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller" ADD CONSTRAINT "reseller_resellerid_fkey" FOREIGN KEY ("resellerid") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller" ADD CONSTRAINT "reseller_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_client_data" ADD CONSTRAINT "external_client_data_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_data_tool_configs" ADD CONSTRAINT "external_data_tool_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ai_configs" ADD CONSTRAINT "user_ai_configs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ai_configs" ADD CONSTRAINT "user_ai_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBilling" ADD CONSTRAINT "UserBilling_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baileys_messages" ADD CONSTRAINT "baileys_messages_instanceName_remoteJid_fkey" FOREIGN KEY ("instanceName", "remoteJid") REFERENCES "baileys_contacts"("instanceName", "remoteJid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversationPreference" ADD CONSTRAINT "ChatConversationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNavPreference" ADD CONSTRAINT "UserNavPreference_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNavPreference" ADD CONSTRAINT "UserNavPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserModules" ADD CONSTRAINT "_UserModules_A_fkey" FOREIGN KEY ("A") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserModules" ADD CONSTRAINT "_UserModules_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

