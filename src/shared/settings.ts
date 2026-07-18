import { mergeSettings, type UserSettings } from './settings-defaults'

export const STORAGE_KEY = 'settings'

/** Trusted extension pages/background only; content scripts must request redacted settings. */
export async function loadSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return mergeSettings(result[STORAGE_KEY])
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export {
  DEFAULT_SETTINGS,
  mergeSettings,
  isConfigured,
  missingConfigFields,
} from './settings-defaults'
export type {
  UserSettings,
  TranslationEngine,
  TranslationDisplayMode,
} from './settings-defaults'
