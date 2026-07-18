# Infron Translate

Infron Translate is a Chrome Manifest V3 extension for in-page translation. It detects the source language from the current webpage, lets the user choose a target language, and keeps the original page content visible.

The extension supports two main workflows:

- **Lens translation** for translating the text or image currently under focus.
- **Full-page bilingual translation** for appending translated text below the original DOM content.

## Current Capabilities

- Click page text or images to translate them in a floating lens.
- Enable automatic lens translation so moving the pointer over text or images shows translations immediately.
- Detect the source language from the current page instead of requiring manual source-language setup.
- Let users choose the target language from the settings page.
- Translate full pages while preserving the original page layout and text.
- Choose the full-page text engine: external LLM or Chrome built-in Translator API.
- Use an external vision-capable model to translate readable text inside images.
- Cache repeated text and image translations to avoid duplicate requests.
- Pause translation per site from the extension popup.
- Configure typography for inserted full-page translations.

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

The source language is detected from the current webpage. The user only chooses the target language.

### External Model

The external model is used for:

- Lens text translation.
- Image text translation.
- Full-page translation when the full-page engine is set to external LLM.

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

Chrome Translator is only used for full-page text translation. Lens translation and image translation use the external model.

## Usage

### Lens Translation

Automatic lens translation is off by default.

When automatic translation is off:

1. Click a text block or image on the page.
2. The lens appears beside the selected content.
3. The original page remains unchanged.
4. Press `Esc` to close the lens.

When automatic translation is on:

1. Move the pointer over page text or images.
2. The lens updates automatically.
3. Click the current target to pin the lens.
4. Press `Esc` to close the lens.

### Full-Page Bilingual Translation

Use the popup button or the full-page shortcut:

- macOS: `Option+Shift+;`
- Windows/Linux: `Alt+Shift+;`

Full-page mode scans rendered DOM text, prioritizes visible content, and appends translations below the original text. Press the shortcut again, or press `Esc`, to remove inserted translations.

The full-page translator also watches for DOM updates, so it can translate content that appears later through infinite scroll, dialogs, drawers, or open Shadow DOM.

### Automatic Bilingual Pages

When automatic bilingual pages are enabled, the extension detects the current page language and starts full-page translation when appropriate. Paused sites are always skipped.

If full-page mode uses Chrome Translator, automatic startup only happens when the detected source language and selected target language are available. If full-page mode uses the external LLM, matched page text is sent to the configured service.

## Image Translation

Image translation requires an external multimodal model that supports OpenAI-compatible `image_url` input.

Supported image formats:

- JPEG
- PNG
- WebP
- GIF

Limits and exclusions:

- Maximum image size: 4 MB.
- SVG is not supported.
- `blob:` image URLs are not supported.

## Privacy and Network Behavior

- API keys are stored in `chrome.storage.local`.
- Content scripts do not receive the API key, Base URL, model, or provider configuration.
- External LLM translation sends text only to the configured `baseURL`.
- Chrome Translator full-page mode processes text on device.
- Image translation uploads the complete image to the configured multimodal model.
- Automatic lens translation and external full-page translation can proactively send visible page text to the configured service.
- Paused sites do not start lens translation, automatic translation, or full-page translation.
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
- Clicking text or an image opens the translation lens when automatic translation is off.
- Moving over text or an image opens the translation lens when automatic translation is on.
- Clicking the current target pins the lens.
- `Esc` closes the lens and exits full-page translation.
- Full-page mode appends translations below original text without removing source content.
- Full-page mode can be toggled off cleanly.
- Chrome Translator full-page mode works for supported detected language pairs.
- External LLM full-page mode sends batched text requests and does not fall back silently.
- Image translation works for supported image formats and rejects unsupported images clearly.
- Repeated text and image resources reuse cached translations.
- Paused sites do not translate automatically.
