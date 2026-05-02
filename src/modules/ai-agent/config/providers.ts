/**
 * Proveedores y modelos disponibles para langchain
 *
 * Recomendaciones de costo-beneficio:
 *  - openai  → gpt-4o-mini   (rápido, económico, ideal para la mayoría de agentes)
 *  - google  → gemini-2.5-flash (muy rápido, muy económico, excelente calidad)
 *
 * Opciones premium (mayor calidad, mayor costo):
 *  - openai  → gpt-4o
 *  - google  → gemini-2.5-pro
 */

export const providersConfig = {
  openai: ['gpt-4o-mini', 'gpt-5-mini'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
} as const;
