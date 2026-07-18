import type { UiLanguage } from './settings-defaults'

export type I18nKey =
  | 'autoOffDesc'
  | 'autoOnDesc'
  | 'autoStart'
  | 'autoStop'
  | 'bilingual'
  | 'browserEngine'
  | 'cannotReadPage'
  | 'chromeUnavailable'
  | 'cloudConfigNeeded'
  | 'cloudEngine'
  | 'configured'
  | 'customLanguage'
  | 'detecting'
  | 'displayMode'
  | 'engineBrowserReady'
  | 'engineCloud'
  | 'engineSummary'
  | 'extensionSettings'
  | 'fullPageBilingual'
  | 'fullPageTranslationOnly'
  | 'interfaceLanguage'
  | 'meetingAssistant'
  | 'meetingAssistantHint'
  | 'startMeetingAssistant'
  | 'openSettings'
  | 'pauseThisSite'
  | 'popupCurrentSite'
  | 'popupDetectedLanguage'
  | 'popupUsageBilingual'
  | 'popupUsageTranslationOnly'
  | 'settingsSaved'
  | 'setupRequired'
  | 'statusAnalyzing'
  | 'statusComplete'
  | 'statusFailedPair'
  | 'statusNoText'
  | 'statusPartialComplete'
  | 'statusPartialFailed'
  | 'statusTranslated'
  | 'statusTranslatedFailed'
  | 'statusTranslatingNew'
  | 'statusTranslatingPage'
  | 'statusWaiting'
  | 'sourceLanguage'
  | 'targetLanguage'
  | 'translateThisPage'
  | 'translationEngine'
  | 'translationOnly'
  | 'unavailable'
  | 'updating'

const STRINGS: Record<UiLanguage, Record<I18nKey, string>> = {
  zh: {
    autoOffDesc: '关闭：点击按钮后翻译',
    autoOnDesc: '开启：自动翻译页面',
    autoStart: '启动自动翻译',
    autoStop: '关闭自动翻译',
    bilingual: '双语对照',
    browserEngine: 'Chrome 内置翻译',
    cannotReadPage: '无法读取此页面',
    chromeUnavailable: '已保存。当前语言对无法使用 Chrome 翻译。',
    cloudConfigNeeded: 'Cloud Model 需要先完成配置',
    cloudEngine: 'Cloud Model',
    configured: '已配置',
    customLanguage: '自定义',
    detecting: '检测中...',
    displayMode: '显示模式',
    engineBrowserReady: '已保存。Chrome 翻译已就绪。',
    engineCloud: 'Cloud Model',
    engineSummary: '引擎：{engine}',
    extensionSettings: '扩展设置',
    fullPageBilingual: '整页双语对照',
    fullPageTranslationOnly: '整页仅译文',
    interfaceLanguage: '界面语言',
    meetingAssistant: '会议助手',
    meetingAssistantHint: '监听麦克风与会议声音，并打开实时总结双屏。',
    startMeetingAssistant: '启动会议助手',
    openSettings: '打开设置',
    pauseThisSite: '暂停此网站',
    popupCurrentSite: '当前网站',
    popupDetectedLanguage: '识别语言',
    popupUsageBilingual: '点击下方按钮切换整页双语翻译。',
    popupUsageTranslationOnly: '点击下方按钮用译文替换页面文字。',
    settingsSaved: '已保存。打开的页面已同步。',
    setupRequired: '需要配置',
    statusAnalyzing: '正在分析页面文本',
    statusComplete: '翻译完成',
    statusFailedPair: '页面翻译失败。当前语言对可能不可用。',
    statusNoText: '当前页面未找到可翻译文本',
    statusPartialComplete: '翻译部分完成',
    statusPartialFailed: '页面翻译部分失败',
    statusTranslated: '已翻译 {count} 个文本块',
    statusTranslatedFailed: '已翻译 {success} 个，失败 {failed} 个',
    statusTranslatingNew: '正在翻译新内容',
    statusTranslatingPage: '正在翻译页面',
    statusWaiting: '正在等待页面内容',
    sourceLanguage: '源语言',
    targetLanguage: '目标语言',
    translateThisPage: '翻译当前页面',
    translationEngine: '翻译引擎',
    translationOnly: '仅译文',
    unavailable: '不可用',
    updating: '更新中...',
  },
  en: {
    autoOffDesc: 'Off: translate after clicking the button',
    autoOnDesc: 'On: translate pages automatically',
    autoStart: 'Start auto translation',
    autoStop: 'Stop auto translation',
    bilingual: 'Bilingual',
    browserEngine: 'Chrome built-in translation',
    cannotReadPage: 'Cannot read this page',
    chromeUnavailable: 'Saved. Chrome translation is unavailable for this language pair.',
    cloudConfigNeeded: 'Cloud Model needs to be configured first',
    cloudEngine: 'Cloud Model',
    configured: 'Configured',
    customLanguage: 'Custom',
    detecting: 'Detecting...',
    displayMode: 'Display mode',
    engineBrowserReady: 'Saved. Chrome translation is ready.',
    engineCloud: 'Cloud Model',
    engineSummary: 'Engine: {engine}',
    extensionSettings: 'Extension settings',
    fullPageBilingual: 'Full-page bilingual',
    fullPageTranslationOnly: 'Full-page translation only',
    interfaceLanguage: 'Interface language',
    meetingAssistant: 'Meeting Assistant',
    meetingAssistantHint: 'Listen to microphone and meeting audio, then open the live summary screens.',
    startMeetingAssistant: 'Start Meeting Assistant',
    openSettings: 'Open settings',
    pauseThisSite: 'Pause this site',
    popupCurrentSite: 'Current site',
    popupDetectedLanguage: 'Detected language',
    popupUsageBilingual: 'Use the button below to toggle full-page bilingual translation.',
    popupUsageTranslationOnly: 'Use the button below to replace page text with translations.',
    settingsSaved: 'Saved. Open pages are synced.',
    setupRequired: 'Setup required',
    statusAnalyzing: 'Analyzing page text',
    statusComplete: 'Translation complete',
    statusFailedPair: 'Page translation failed. The current language pair may be unavailable.',
    statusNoText: 'No translatable text found on this page',
    statusPartialComplete: 'Translation partially complete',
    statusPartialFailed: 'Page translation partially failed',
    statusTranslated: '{count} translated',
    statusTranslatedFailed: '{success} translated, {failed} failed',
    statusTranslatingNew: 'Translating new content',
    statusTranslatingPage: 'Translating page',
    statusWaiting: 'Waiting for page content',
    sourceLanguage: 'Source language',
    targetLanguage: 'Target language',
    translateThisPage: 'Translate this page',
    translationEngine: 'Translation engine',
    translationOnly: 'Translation only',
    unavailable: 'Unavailable',
    updating: 'Updating...',
  },
}

export function uiText(
  language: UiLanguage,
  key: I18nKey,
  vars: Record<string, string | number> = {},
): string {
  let text = STRINGS[language][key] ?? STRINGS.zh[key]
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}
