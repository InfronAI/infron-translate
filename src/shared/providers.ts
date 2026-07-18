/**
 * Multi-provider OpenAI-compatible adapters.
 * Focus: StepFun + DeepSeek — keep translation fast by disabling/minimizing thinking.
 */

export type ProviderId = 'auto' | 'openai' | 'deepseek' | 'stepfun'

/** User-facing reasoning preference for translation (default off/lowest). */
export type ReasoningPref = 'off' | 'low' | 'medium' | 'high'

export type ProviderPreset = {
  id: Exclude<ProviderId, 'auto'>
  label: string
  baseURL: string
  modelHint: string
  /** Domains that identify this provider when baseURL matches. */
  hostHints: string[]
  modelHints: string[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI / Generic compatible',
    baseURL: 'https://api.openai.com/v1',
    modelHint: 'gpt-4o-mini',
    hostHints: ['api.openai.com', 'openai.com'],
    modelHints: ['gpt-', 'o1', 'o3', 'o4'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    modelHint: 'deepseek-chat',
    hostHints: ['deepseek.com', 'api.deepseek.com'],
    modelHints: ['deepseek'],
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    baseURL: 'https://api.stepfun.com/v1',
    modelHint: 'step-3.5-flash',
    hostHints: ['stepfun.com', 'stepfun.ai', 'api.stepfun.com', 'api.stepfun.ai'],
    modelHints: ['step-', 'stepfun'],
  },
]

export function detectProvider(baseURL: string, model: string): Exclude<ProviderId, 'auto'> {
  const host = safeHost(baseURL)
  const m = model.toLowerCase()

  for (const p of PROVIDER_PRESETS) {
    if (p.id === 'openai') continue
    if (p.hostHints.some((h) => host.includes(h))) return p.id
    if (p.modelHints.some((h) => m.includes(h))) return p.id
  }
  if (PROVIDER_PRESETS[0].hostHints.some((h) => host.includes(h))) return 'openai'
  if (PROVIDER_PRESETS[0].modelHints.some((h) => m.includes(h))) return 'openai'
  return 'openai'
}

export function resolveProvider(
  preferred: ProviderId | string | undefined,
  baseURL: string,
  model: string,
): Exclude<ProviderId, 'auto'> {
  if (preferred && preferred !== 'auto' && preferred !== '') {
    if (preferred === 'deepseek' || preferred === 'stepfun' || preferred === 'openai') {
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
 * Mutate chat/completions body with provider-specific flags for speed.
 * - DeepSeek: thinking.type = disabled when pref is off
 * - StepFun: reasoning_effort = low (lowest) when off/low; medium/high as requested
 * Unknown providers: no-op (keep generic OpenAI body)
 */
export function applyProviderRequestBody(
  body: Record<string, unknown>,
  provider: Exclude<ProviderId, 'auto'>,
  reasoning: ReasoningPref,
): void {
  if (provider === 'deepseek') {
    // DeepSeek V3/V4 OpenAI format: disable thinking for translation speed
    // Docs: {"thinking": {"type": "enabled" | "disabled"}}
    if (reasoning === 'off') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
      // deepseek maps low/medium → high; only high/max are real — still set for compatibility
      body.reasoning_effort = reasoning === 'high' ? 'high' : 'high'
    }
    return
  }

  if (provider === 'stepfun') {
    // Chat Completions: reasoning_effort = low | medium | high
    // Translation is "info extraction / rewrite" → low is appropriate; cannot fully off
    if (reasoning === 'off' || reasoning === 'low') {
      body.reasoning_effort = 'low'
    } else if (reasoning === 'medium') {
      body.reasoning_effort = 'medium'
    } else {
      body.reasoning_effort = 'high'
    }
    return
  }

  // openai / generic: leave body unchanged
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
