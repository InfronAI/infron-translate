import { describe, it, expect } from 'vitest'
import {
  detectProvider,
  resolveProvider,
  applyProviderRequestBody,
} from '../../src/shared/providers'

describe('detectProvider', () => {
  it('detects infron from host', () => {
    expect(detectProvider('https://llm.onerouter.pro/v1', 'deepseek/deepseek-v3.2')).toBe(
      'infron',
    )
  })

  it('detects openrouter from host', () => {
    expect(detectProvider('https://openrouter.ai/api/v1', 'openai/gpt-4o-mini')).toBe(
      'openrouter',
    )
  })
})

describe('applyProviderRequestBody', () => {
  it('leaves OpenAI-compatible request bodies unchanged', () => {
    const body: Record<string, unknown> = { model: 'gpt-4o-mini' }
    applyProviderRequestBody(body, 'openai', 'off')
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})

describe('resolveProvider', () => {
  it('respects explicit preference', () => {
    expect(resolveProvider('openrouter', 'https://api.openai.com/v1', 'gpt')).toBe(
      'openrouter',
    )
  })
})
