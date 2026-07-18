export const LANGUAGE_OPTIONS = [
  ['ar', 'Arabic'],
  ['bg', 'Bulgarian'],
  ['bn', 'Bengali'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hr', 'Croatian'],
  ['hu', 'Hungarian'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['kn', 'Kannada'],
  ['ko', 'Korean'],
  ['lt', 'Lithuanian'],
  ['mr', 'Marathi'],
  ['nl', 'Dutch'],
  ['no', 'Norwegian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['sv', 'Swedish'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['th', 'Thai'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'],
  ['cn', 'Chinese'],
  ['zh-Hant', 'Traditional Chinese'],
] as const

export function languageLabel(code: string): string {
  if (code === 'auto') return 'Auto detect'
  if (code === 'zh') return 'Chinese · cn'
  const option = LANGUAGE_OPTIONS.find(([value]) => value === code)
  return option ? `${option[1]} · ${option[0]}` : code
}

export function browserLanguageCode(code: string): string {
  return code === 'cn' ? 'zh' : code
}
