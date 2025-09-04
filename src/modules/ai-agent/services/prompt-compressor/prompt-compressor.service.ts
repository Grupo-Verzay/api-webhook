import { Injectable } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import OpenAI from 'openai';
import { HumanMessage, SystemMessage } from 'node_modules/@langchain/core/messages.cjs';

type CompressorFormat = 'yaml' | 'json';

@Injectable()
export class PromptCompressorService {
    constructor() { }

    private SYSTEM(format: CompressorFormat) {
        const schemaYAML = `
goal: "<1 frase clara>"
inputs: ["..."]
constraints: ["..."]
must_keep: ["..."]
steps: ["..."]
output_spec: "<...>"
notes: ["..."]
`.trim();

        const schemaJSON = JSON.stringify({
            goal: "<1 frase clara>",
            inputs: [],
            constraints: [],
            must_keep: [],
            steps: [],
            output_spec: "<...>",
            notes: [],
        });

        const schema = format === 'yaml' ? schemaYAML : schemaJSON;

        return `
Eres "Prompt Compressor", experto en condensar prompts sin pérdida de intención.
Reglas:
1) Devuelve SOLO el ${format.toUpperCase()} con el esquema dado (sin texto extra).
2) Mantén objetivo, restricciones, formato y entidades críticas (personas, endpoints, variables, montos, fechas).
3) Deduplica ideas y elimina relleno (saludos, repeticiones, justificaciones).
4) Si no hay una sección, omítela (no inventes).
5) No cambies significados ni condiciones.
6) Limita cada sección a lo esencial (1–5 ítems).
Esquema:
${schema}
`.trim();
    }

    async compress({
        client,
        input,
        format = 'yaml',
        maxTokens = 350,
        temperature = 0.1,
    }: {
        client: BaseChatModel;
        input: string;
        format?: CompressorFormat;
        maxTokens?: number;
        temperature?: number;
    }): Promise<string> {
        const messages = [
            new SystemMessage({
                content: [
                    { type: "text", text: this.SYSTEM(format) }
                ]
            }),
            new HumanMessage({
                content: [
                    { type: "text", text: input }
                ]
            })
        ]
        // const res = await client.chat.completions.create({
        //     model: 'gpt-4o-mini', // consistente con tu stack
        //     temperature,
        //     max_tokens: maxTokens,
        //     messages: [
        //         { role: 'system', content: this.SYSTEM(format) },
        //         { role: 'user', content: input },
        //     ],
        // });
        client.withConfig({ runName: "tempModel" });
        const resR = await client.invoke(messages, {
            configurable: {
                "tempModel": {
                    temperature,
                    max_tokens: maxTokens,
                },
            },
        })


        // return res.choices?.[0]?.message?.content?.trim() ?? '';
        return resR.content.toString().trim() ?? '';
    }

    /**
     * Compacta un historial largo a un único bloque (extractivo + abstractive).
     * Recibe varias entradas (mensajes previos) y devuelve un resumen fiel.
     */
    async compressHistory({
        client,
        messages,
        maxTokens = 400,
    }: {
        client: BaseChatModel,
        messages: string[];
        maxTokens?: number;
    }): Promise<string> {
        const joined = messages
            .filter(Boolean)
            .map((m, i) => `#${i + 1} ${m}`)
            .join('\n');

        // Pedimos un extracto tipo “brief” + bullets de restricciones y hechos duros
        const sys = `
Eres "History Condenser". Resume el historial a un solo bloque que conserve:
- objetivo(s) del usuario y del asistente
- decisiones ya tomadas / intenciones ejecutadas
- restricciones (fechas, montos, límites, must/never)
- entidades críticas (nombres, endpoints, variables)
- formato de salida si aplica
Devuelve texto plano conciso (no más de ~400 tokens).
No agregues nada que no esté en el historial.
`.trim();

        // const res = await client.chat.completions.create({
        //     model: 'gpt-4o-mini',
        //     temperature: 0.0,
        //     max_tokens: maxTokens,
        //     messages: [
        //         { role: 'system', content: sys },
        //         { role: 'user', content: joined },
        //     ],
        // });
        client.withConfig({ runName: "tempModel" });
        const resR = await client.invoke([
            new SystemMessage({
                content: [{ type: "text", text: sys }]
            }),
            new HumanMessage({
                content: [{ type: "text", text: joined }]
            })
        ], {
            configurable: {
                "tempModel": {
                    max_tokens: maxTokens,
                },
            },
        })
        

        return resR.content.toString().trim() ?? '';
    }

    /**
     * Verificador simple: asegura que entidades/fechas/números críticos sigan presentes
     * tras la compresión. Si falla, puedes optar por: (a) bajar compresión, (b) fallback.
     */
    verifyCoverage({
        original,
        compressed,
        requiredTerms = [],
    }: {
        original: string;
        compressed: string;
        requiredTerms?: string[]; // términos que sí o sí deben estar
    }): { ok: boolean; missing: string[] } {
        const musts = new Set<string>();

        // 1) extrae números/fechas del original (muy básico y determinista)
        const nums = (original.match(/\b\d[\d./:-]*/g) || []).slice(0, 20);
        nums.forEach((n) => musts.add(n));

        // 2) termos forzados declarados por el caller (endpoints, variables, intent names…)
        (requiredTerms || []).forEach((t) => {
            if (t && t.length <= 64) musts.add(t);
        });

        const miss: string[] = [];
        const compLower = compressed.toLowerCase();

        for (const t of musts) {
            if (!t) continue;
            if (!compLower.includes(t.toLowerCase())) {
                miss.push(t);
            }
        }
        return { ok: miss.length === 0, missing: miss };
    }
}
