import type { TranslateBlock } from './messages'

export const TRANSLATE_BATCH_JSON_SCHEMA = {
  name: 'translate_batch_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'translation'],
          properties: {
            id: { type: 'string' },
            translation: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export const IMAGE_TRANSLATION_JSON_SCHEMA = {
  name: 'image_translation_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['translation'],
    properties: {
      translation: { type: 'string' },
    },
  },
} as const

export type TranslateBatchResult = {
  items: { id: string; translation: string }[]
}

export function parseTranslateBatchResult(
  raw: unknown,
  allowedIds: Set<string>,
): { ok: true; items: { id: string; translation: string }[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || !('items' in raw)) {
    return { ok: false, error: 'items missing' }
  }
  if (!Array.isArray(raw.items)) return { ok: false, error: 'items missing' }

  const out: { id: string; translation: string }[] = []
  for (const row of raw.items) {
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      !('translation' in row)
    ) {
      continue
    }
    const { id, translation } = row
    if (typeof id !== 'string' || typeof translation !== 'string') continue
    if (!allowedIds.has(id)) continue
    out.push({ id, translation })
  }
  return { ok: true, items: out }
}

export function parseImageTranslationResult(
  raw: unknown,
): { ok: true; translation: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || !('translation' in raw)) {
    return { ok: false, error: 'translation missing' }
  }
  if (typeof raw.translation !== 'string' || !raw.translation.trim()) {
    return { ok: false, error: 'translation empty' }
  }
  return { ok: true, translation: raw.translation.trim() }
}

export function buildTranslateImagePrompt(sourceLang: string, targetLang: string): string {
  const languageInstruction =
    sourceLang === 'auto'
      ? `Detect the source language of visible text in this image and translate it to ${targetLang}.`
      : `Read visible text in this image and translate it from ${sourceLang} to ${targetLang}.`
  return [
    languageInstruction,
    'Preserve the original reading order and line breaks where meaningful.',
    'Do not describe the image. If it has no readable text, return an empty translation.',
    'Return ONLY JSON matching: { "translation": string }.',
  ].join('\n')
}

export function buildTranslateUserPrompt(
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
): string {
  const languageInstruction =
    sourceLang === 'auto'
      ? `Detect each block's source language and translate it to ${targetLang}.`
      : `Translate each block from ${sourceLang} to ${targetLang}.`
  return [
    languageInstruction,
    'Return ONLY JSON matching the schema: { "items": [{ "id", "translation" }] }.',
    'Keep meaning faithful. No explanations.',
    'Blocks:',
    JSON.stringify(blocks),
  ].join('\n')
}
