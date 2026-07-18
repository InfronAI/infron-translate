const ENGLISH_MARKERS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'will',
  'with',
  'you',
])

function primaryLanguage(language: string): string {
  return language.trim().toLocaleLowerCase().split(/[-_]/u)[0]
}

function normalizeDeclaredLanguage(language: string): string {
  const normalized = primaryLanguage(language)
  return /^[a-z]{2,3}$/u.test(normalized) ? normalized : ''
}

function scriptRatios(text: string): {
  latin: number
  han: number
  cyrillic: number
  arabic: number
  devanagari: number
  total: number
} {
  const letters = text.match(/\p{L}/gu) ?? []
  const total = letters.length
  if (!total) return { latin: 0, han: 0, cyrillic: 0, arabic: 0, devanagari: 0, total: 0 }
  return {
    latin: (text.match(/\p{Script=Latin}/gu)?.length ?? 0) / total,
    han: (text.match(/\p{Script=Han}/gu)?.length ?? 0) / total,
    cyrillic: (text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0) / total,
    arabic: (text.match(/\p{Script=Arabic}/gu)?.length ?? 0) / total,
    devanagari: (text.match(/\p{Script=Devanagari}/gu)?.length ?? 0) / total,
    total,
  }
}

export function isLikelyEnglishText(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length < 40) return false
  const latinLetters = text.match(/[a-z]/giu)?.length ?? 0
  if (latinLetters / letters.length < 0.78) return false

  const words = text.toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/gu) ?? []
  if (words.length < 12) return false
  const markerCount = words.reduce(
    (total, word) => total + (ENGLISH_MARKERS.has(word) ? 1 : 0),
    0,
  )
  return markerCount >= Math.max(2, Math.ceil(words.length * 0.035))
}

export function isLikelySourceLanguage(
  sourceLanguage: string,
  declaredLanguage: string,
  textSample: string,
): boolean {
  const source = primaryLanguage(sourceLanguage)
  const declared = primaryLanguage(declaredLanguage)
  if (declared) return declared === source
  return source === 'en' && isLikelyEnglishText(textSample)
}

export function pageMatchesSourceLanguage(
  sourceLanguage: string,
  root: Document = document,
): boolean {
  const declaredLanguage =
    root.documentElement.lang ||
    root.querySelector<HTMLMetaElement>('meta[http-equiv="content-language" i]')?.content ||
    ''
  const sample = (root.body?.innerText || root.body?.textContent || '').slice(0, 12_000)
  return isLikelySourceLanguage(sourceLanguage, declaredLanguage, sample)
}

export function detectPageSourceLanguage(root: Document = document): string {
  const declaredLanguage =
    root.documentElement.lang ||
    root.querySelector<HTMLMetaElement>('meta[http-equiv="content-language" i]')?.content ||
    ''
  const declared = normalizeDeclaredLanguage(declaredLanguage)
  if (declared) return declared

  const sample = (root.body?.innerText || root.body?.textContent || '').slice(0, 12_000)
  if (isLikelyEnglishText(sample)) return 'en'

  const ratios = scriptRatios(sample)
  if (ratios.total < 40) return 'auto'
  if (ratios.han >= 0.45) return 'zh'
  if (ratios.cyrillic >= 0.55) return 'ru'
  if (ratios.arabic >= 0.55) return 'ar'
  if (ratios.devanagari >= 0.55) return 'hi'
  if (ratios.latin >= 0.78) return 'auto'
  return 'auto'
}
