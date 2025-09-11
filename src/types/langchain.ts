// src/modules/ai-agent/types.ts

// Importa la configuración de los proveedores de IA. Este objeto actúa como la "fuente de verdad"
// que define qué proveedores y modelos están disponibles, permitiendo que los tipos se generen
// automáticamente a partir de esta única fuente de datos.
import { providersConfig } from "src/modules/ai-agent/config/providers";

/**
 * Tipo de unión que representa los nombres de todos los proveedores de IA disponibles.
 * Se genera dinámicamente a partir de las claves del objeto `providersConfig`.
 * Esto garantiza que solo se puedan usar nombres de proveedor válidos ('openai' | 'anthropic' | 'google'),
 * previniendo errores de tipografía o la selección de un proveedor no configurado.
 */
export type Provider = keyof typeof providersConfig;

/**
 * Define la estructura de configuración para un modelo de IA.
 * Este tipo genérico es la clave de la validación, ya que crea una "unión discriminada".
 *
 * @template P - Un tipo de proveedor, que debe ser una de las claves de `providersConfig`.
 * Cuando se usa, el valor de `P` restringe los modelos válidos para esa configuración.
 *
 * @property provider - El nombre del proveedor de IA (ej. 'openai'). Su valor determina
 * la lista de modelos permitidos para la propiedad 'model'.
 * @property model    - El nombre del modelo específico a utilizar (ej. 'gpt-4o').
 * TypeScript infiere y restringe automáticamente este valor
 * a los modelos válidos para el proveedor seleccionado.
 * @property apiKey   - La clave de API necesaria para la autenticación con el proveedor.
 */
export type ModelConfig<P extends Provider> = {
  provider: P;
  model:  (typeof providersConfig)[P];
  apiKey: string;
};

/**
 * Función factory de ejemplo que demuestra el uso seguro del tipo `ModelConfig`.
 * Utiliza un tipo genérico (`<P extends Provider>`) para heredar las restricciones
 * de tipo y garantizar que el objeto de configuración proporcionado sea válido.
 *
 * @param config - Un objeto de configuración que contiene el proveedor, el modelo
 * y la clave de API, validado en tiempo de compilación por TypeScript.
 */
const exampleFactoryClient = <P extends Provider>(config: ModelConfig<P>) => {
  const { provider, model } = config;

  console.log(`Creando modelo de ${provider}: ${model}`);

  // Aquí se implementaría la lógica de instanciación real, por ejemplo:
  // switch (provider) {
  //   case 'openai':
  //     return new ChatOpenAI({ model, apiKey });
  //   case 'anthropic':
  //     return new ChatAnthropic({ model, apiKey });
  //   // etc.
  // }
};

// Ejemplo de uso: La llamada a la función es segura y el autocompletado funciona.
// Si intentas usar un modelo que no es de OpenAI (por ejemplo, 'gemini-pro'),
// TypeScript te mostrará un error de compilación.
exampleFactoryClient({ provider: "openai", model: "gpt-4o", apiKey: "ejemplo_api_key_openai" });
exampleFactoryClient({provider:"google",model:"gemini-2.5-flash",apiKey:''})