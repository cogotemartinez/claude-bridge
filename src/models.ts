export interface BridgeModel {
  id: string;
  cliAlias: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
}

// Los ids que expone el bridge. IMPORTANTE: el `cliAlias` es lo que decide qué
// modelo corre de verdad — el CLI resuelve `opus`/`sonnet`/`haiku`/`fable` al
// último de cada familia. Verificado el 2026-09-02 con `claude -p ... --model X
// --output-format json`: opus→claude-opus-5, sonnet→claude-sonnet-5,
// haiku→claude-haiku-4-5. O sea: el bridge YA corría la familia 5 mientras se
// anunciaba como "Claude Opus 4". Los ids nuevos dicen la verdad; los viejos
// quedan como alias para que la config existente (openclaw.json, crons) siga
// resolviendo mientras se migra.
const MODELS: BridgeModel[] = [
  {
    id: "claude-opus-5",
    cliAlias: "opus",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "claude-sonnet-5",
    cliAlias: "sonnet",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "claude-haiku-4-5",
    cliAlias: "haiku",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
  {
    // Fable tiene su PROPIO límite de uso, separado del de Opus: cuando se agota,
    // el CLI responde "You've reached your Fable limit" (medido el 2026-09-02) y el
    // turno falla. Por eso no es primary de nadie por defecto: se elige a mano.
    id: "claude-fable-5-1",
    cliAlias: "fable",
    name: "Claude Fable 5.1",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
];

export function resolveModel(requested: string): BridgeModel {
  const byId = MODELS.find((m) => m.id === requested);
  if (byId) return byId;

  // Alias cortos + los ids viejos de la familia 4, que siguen escritos en
  // openclaw.json y en los payloads de varios crons. Mapearlos acá evita un
  // cutover atómico: la config vieja resuelve al modelo nuevo de la misma familia.
  const aliasMap: Record<string, string> = {
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
    fable: "claude-fable-5-1",
    "claude-opus-4": "claude-opus-5",
    "claude-sonnet-4": "claude-sonnet-5",
    "claude-haiku-4": "claude-haiku-4-5",
  };
  const fromAlias = MODELS.find((m) => m.id === aliasMap[requested]);
  if (fromAlias) return fromAlias;

  // Passthrough
  return {
    id: requested,
    cliAlias: requested,
    name: requested,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
  };
}

export function listModels(): BridgeModel[] {
  return MODELS;
}
