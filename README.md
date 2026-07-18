# Infron Translate

Infron Translate is a Chrome Manifest V3 extension for full-page bilingual translation. It detects the source language from the current webpage, lets the user choose a target language, and inserts translations into the page while keeping the original content visible.

## Current Capabilities

- Detect the source language from the current page and allow a manual source-language override from the popup.
- Let users choose the target language from the popup or settings page.
- Translate rendered DOM text and append translations below the original text.
- Toggle full-page bilingual mode from the popup.
- Automatically start bilingual mode on eligible pages.
- Choose the full-page translation engine: external LLM or Chrome built-in Translator API.
- Process dynamically added content from infinite scroll, dialogs, drawers, and open Shadow DOM.
- Cache repeated text translations to avoid duplicate requests.
- Pause translation per site from the extension popup.
- Configure typography for inserted translations.

## Installation

```bash
npm install
npm run build
```

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated `dist/` directory.

## Configuration

Open the extension popup and choose **Open settings**.

### Target Language

The source language is detected from the current webpage. The popup shows the detected language and lets the user keep automatic detection or choose a manual source language. The target language can also be changed directly from the popup.

### External Model

The external model is used when the full-page engine is set to external LLM.

Required fields:

| Field | Example |
|---|---|
| Provider | Auto, OpenAI, DeepSeek, StepFun |
| Base URL | `https://api.openai.com/v1` |
| API Key | Your API key |
| Model | `gpt-4o-mini` |
| Target language | `zh` |

The configured service must expose an OpenAI-compatible `/chat/completions` endpoint. Remote endpoints must use HTTPS. HTTP is allowed only for loopback hosts such as `localhost`, `127.0.0.1`, and `[::1]`.

### Chrome Built-In Translator

Full-page translation can use Chrome's on-device Translator API. The settings page checks whether the API is available and whether the language pack for the selected target language can be used.

## Usage

### Full-Page Bilingual Translation

Use the popup button to start or stop full-page bilingual translation.

Full-page mode scans rendered DOM text, prioritizes visible content, and appends translations below the original text. Use the popup button again to remove inserted translations.

The full-page translator watches DOM updates, so it can translate content that appears later through infinite scroll, dialogs, drawers, or open Shadow DOM.

### Automatic Bilingual Pages

When automatic bilingual pages are enabled, the extension detects the current page language and starts full-page translation when appropriate. Paused sites are always skipped.

If full-page mode uses Chrome Translator, automatic startup only happens when the detected source language and selected target language are available. If full-page mode uses the external LLM, matched page text is sent to the configured service.

## Privacy and Network Behavior

- API keys are stored in `chrome.storage.local`.
- Content scripts do not receive the API key, Base URL, model, or provider configuration.
- External LLM translation sends text only to the configured `baseURL`.
- Chrome Translator full-page mode processes text on device.
- External full-page translation can proactively send visible page text to the configured service.
- Paused sites do not start full-page translation.
- The extension does not include analytics, telemetry, or remote code.

## Development

```bash
npm install
npm run dev
npm run build
npm test
```

Scripts:

- `npm run dev`: start Vite development mode.
- `npm run build`: run TypeScript checks and build the extension into `dist/`.
- `npm test`: run the Vitest suite.
- `npm run test:watch`: run Vitest in watch mode.

## Manual QA

- Settings persist after saving and reloading a page.
- The popup button starts and stops full-page bilingual translation.
- Full-page mode appends translations below original text without removing source content.
- Full-page mode can be toggled off cleanly.
- Chrome Translator full-page mode works for supported detected language pairs.
- External LLM full-page mode sends batched text requests and does not fall back silently.
- Repeated text reuses cached translations.
- Paused sites do not translate automatically.
