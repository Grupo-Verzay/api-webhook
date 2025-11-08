export const extraRules = `
• Comportamiento: Tras ejecutar un flujo o una tool, responde únicamente lo indicado en “Regla/parámetro”.
• Si no hay una orden clara, formula una pregunta contextual mínima para guiar al siguiente paso.
• Prohibido: responder en JSON, objetos, código, backticks o bloques de “\`\`\`”.
• La salida debe ser SIEMPRE texto natural en español.
`;

export const ERROR_OPENAI_EMPTY_RESPONSE = `¡Ups! Algo salió mal 😅
Parece que hubo un problema al procesar tu mensaje. ¿Podrías intentarlo de nuevo?`;

export const extraRulesV2 = ``;


//export const systemPromptWorkflow = (input, formattedList) =>''
export const systemPromptWorkflow = (input, formattedList) => {

  return `
  # 🎯 Objetivo
  Detectar todos los flujos cuyo nombre comience exactamente con el valor de 'nombre_flujo' recibido como input, y retornar un objeto con:
  - Una lista de coincidencias exactas de nombre.
  - El texto original del usuario como "detalles".
  
  # 📥 Input 
  "${JSON.stringify(input)}"
  
  # 📋 Lista de flujos disponibles (formato JSON simulado):
    [
    ${formattedList}
    ]
  
  # ✅ Formato de salida (JSON):
  {
    "nombre_flujo": ["Nombre exacto del flujo 1", "Nombre exacto del flujo 2"],
    "detalles": "Texto original del usuario"
  }
  
  # ⚠️ Reglas
  - Solo incluir nombres exactos que comiencen con el input.
  - Si no hay coincidencias, devolver:
    { "nombre_flujo": [], "detalles": "${input}" }
  - No inventar nombres ni modificar los existentes.
   -sin texto adicional, explicaciones, o encabezados.
    - **NO** uses backticks (\`\`\`), bloques de código, ni la palabra 'json'.
     - La respuesta debe poder ser procesada directamente por un parser de JSON.

  
  # 🚫 Prohibido
  - No agregar contexto, explicaciones ni mensajes adicionales.
  - No incluir flujos que contengan el texto, solo los que comienzan con ese texto.
  - No devolver similares.
  
  ---
  
  # ✅ Ejemplos válidos
  
  Input:
  nombre_flujo: "Catálogo de productos"
  
  Respuesta:
  {
    "nombre_flujo": [
      "Catálogo de productos - zapatos clásicos",
      "Catálogo de productos - zapatos deportivos",
      "Catálogo de productos - zapatos para dama"
    ],
    "detalles": "Catálogo de productos"
  }
  
  ---
  
  Input:
  nombre_flujo: "Curso Ambiental"
  
  Respuesta:
  {
    "nombre_flujo": [
      "Curso Ambiental para empresas",
      "Curso Ambiental - nivel básico"
    ],
    "detalles": "Curso Ambiental"
  }
  
  ---
  
  Input:
  nombre_flujo: "Menú del día"
  
  Respuesta:
  {
    "nombre_flujo": [
      "Menú del día"
    ],
    "detalles": "Menú del día"
  }
  
  ---
  
  Input:
  nombre_flujo: "Descuentos exclusivos"
  
  Respuesta:
  {
    "nombre_flujo": [],
    "detalles": "Descuentos exclusivos"
  }
  
  `;
};