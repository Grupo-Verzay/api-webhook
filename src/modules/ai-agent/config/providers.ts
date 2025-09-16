/**
 * Proveedores y modelos disponibles para langchain
 * proveedor:[modelo1,modelo2,modelo3]
 */

export const providersConfig = {
  openai: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o','o4-mini'],
  anthropic: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
  google: ['gemini-pro', 'gemini-1.5-pro','gemini-2.5-flash'],
} as const;