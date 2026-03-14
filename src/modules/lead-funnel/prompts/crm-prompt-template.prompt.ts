import { PrismaService } from 'src/database/prisma.service';

import { buildLeadFunnelPrompt } from './lead-funnel.prompt';
import { buildLeadStatusPrompt } from './lead-status.prompt';
import { CRM_AGENT_PROMPT_IDS } from '../../../types/CRM_AGENT_PROMPT_IDS';
const CRM_LEAD_NAME_JSON_PLACEHOLDER = '{{leadNameJson}}';

async function findPromptText(prisma: PrismaService, userId: string, agentId: string) {
  const prompt = await prisma.agentPrompt.findFirst({
    where: {
      userId,
      agentId,
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      promptText: true,
    },
  });

  return String(prompt?.promptText ?? '').trim();
}

export async function resolveLeadStatusPrompt(args: {
  prisma: PrismaService;
  userId: string;
}) {
  const promptText = await findPromptText(
    args.prisma,
    args.userId,
    CRM_AGENT_PROMPT_IDS.leadStatus,
  );

  return promptText || buildLeadStatusPrompt();
}

export async function resolveLeadFunnelPrompt(args: {
  prisma: PrismaService;
  userId: string;
  leadName: string;
}) {
  const promptText = await findPromptText(
    args.prisma,
    args.userId,
    CRM_AGENT_PROMPT_IDS.leadFunnel,
  );

  if (!promptText) {
    return buildLeadFunnelPrompt({ leadName: args.leadName });
  }

  return promptText.split(CRM_LEAD_NAME_JSON_PLACEHOLDER).join(JSON.stringify(args.leadName));
}
