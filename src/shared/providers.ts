/**
 * Multi-provider OpenAI-compatible adapters.
 */

export type ProviderId = 'openai' | 'infron' | 'openrouter'

/** User-facing reasoning preference for translation (default off/lowest). */
export type ReasoningPref = 'off' | 'low' | 'medium' | 'high'

export type ProviderPreset = {
  id: ProviderId
  label: string
  baseURL: string
  modelHint: string
  modelCandidates: string[]
  /** Domains that identify this provider when baseURL matches. */
  hostHints: string[]
  modelHints: string[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI Compatible',
    baseURL: 'https://api.openai.com/v1',
    modelHint: 'gpt-4o-mini',
    modelCandidates: [
      'gpt-4o-mini',
      'gpt-4o',
      'gpt-4.1-mini',
      'gpt-4.1',
      'gpt-4.1-nano',
      'gpt-5-mini',
      'gpt-5',
      'gpt-5-nano',
      'o4-mini',
      'o3-mini',
    ],
    hostHints: ['api.openai.com', 'openai.com'],
    modelHints: ['gpt-', 'o1', 'o3', 'o4'],
  },
  {
    id: 'infron',
    label: 'Infron.ai',
    baseURL: 'https://llm.onerouter.pro/v1',
    modelHint: 'deepseek/deepseek-v3.2',
    modelCandidates: [
      'deepseek/deepseek-v3.2',
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'openai/gpt-4.1-mini',
      'google/gemini-3-flash-preview',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4.5',
      'qwen/qwen3-235b-a22b',
      'qwen/qwen3-30b-a3b',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    hostHints: ['llm.onerouter.pro', 'infron.ai'],
    modelHints: ['deepseek/', 'openai/', 'anthropic/', 'google/', 'qwen/'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter.ai',
    baseURL: 'https://openrouter.ai/api/v1',
    modelHint: 'openai/gpt-4o-mini',
    modelCandidates: [
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'openai/gpt-4.1-mini',
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3.5-haiku',
      'google/gemini-2.5-flash',
      'google/gemini-2.0-flash-001',
      'deepseek/deepseek-chat',
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    hostHints: ['openrouter.ai'],
    modelHints: ['openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/'],
  },
]

export function detectProvider(baseURL: string, model: string): ProviderId {
  const host = safeHost(baseURL)
  const m = model.toLowerCase()

  for (const p of PROVIDER_PRESETS) {
    if (p.hostHints.some((h) => host.includes(h))) return p.id
  }
  for (const p of PROVIDER_PRESETS) {
    if (p.modelHints.some((h) => m.includes(h))) return p.id
  }
  return 'openai'
}

export function resolveProvider(
  preferred: ProviderId | string | undefined,
  baseURL: string,
  model: string,
): ProviderId {
  if (preferred && preferred !== '') {
    if (preferred === 'openai' || preferred === 'infron' || preferred === 'openrouter') {
      return preferred
    }
  }
  return detectProvider(baseURL, model)
}

function safeHost(baseURL: string): string {
  try {
    const u = new URL(baseURL.includes('://') ? baseURL : `https://${baseURL}`)
    return u.hostname.toLowerCase()
  } catch {
    return baseURL.toLowerCase()
  }
}

/**
 * Mutate chat/completions body with provider-specific flags.
 * Current supported providers are OpenAI-compatible and require no special body fields.
 */
export function applyProviderRequestBody(
  body: Record<string, unknown>,
  _provider: ProviderId,
  _reasoning: ReasoningPref,
): void {
  void body
}

/** Human label for settings UI */
export function reasoningPrefLabel(p: ReasoningPref): string {
  switch (p) {
    case 'off':
      return 'Off / lowest (recommended, fast)'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High (slower)'
  }
}
