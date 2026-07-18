# Chrome 透镜英语学习插件 — 设计文档

**日期：** 2026-07-12  
**状态：** Draft for review  
**仓库：** `chrome-trans`

## 1. 问题与目标

在任意英文网页上持续沉浸阅读，需要偶尔「偷看」中文释义，但**不能**让中文逐渐占据视野、打断英语输入。

### 1.1 成功标准

- 默认始终显示页面原始英文，正文不被替换。
- 用户**按住**快捷键时出现**矩形透镜**，显示指针下文本块的中文译文；**松开**立即消失。
- 进入页面后自动预译**可见区**文本（可配置关闭），透镜尽量即开即看。
- 用户可配置 **OpenAI 兼容**接口（`baseURL` + `API Key` + `model`）。
- 通过结构化 DOM 块 + JSON Schema 批量生成译文，结果可映射回页面块。

### 1.2 非目标（MVP）

- 永久或块级点击替换正文为中文。
- 像素级中英双层叠放 / clip 挖洞透视。
- 多厂商原生 SDK（Claude / Gemini 专用协议等）。
- 生词本、单词级 gloss、朗读、跨域 iframe 内部文本。
- 整页截图 / OCR 翻译层。

## 2. 产品决策摘要

| 决策点 | 选择 |
|--------|------|
| 交互范式 | 悬浮矩形透镜（非圆形） |
| 激活方式 | 按住快捷键显示，松开消失 |
| 中文呈现 | 锚定段落块：透镜内显示当前块译文（非版式像素对齐） |
| 预译策略 | 进页自动预译可见区（可关） |
| AI | 仅 OpenAI 兼容 Chat Completions |
| 架构 | 文本块注册表 + Map&lt;id, translation&gt; + 透镜 UI |

**学习原则：** 其他「替换 / 钉住 / 整页中文」交互会迫使中文暴露越来越多；透镜偷看不改变默认阅读通道。

## 3. 架构

Chrome **Manifest V3** 扩展，四个逻辑模块：

```
┌─────────────────┐     messages      ┌──────────────────────────┐
│ Content Script  │ ◄──────────────► │ Background Service Worker│
│ · 抽块 / 注册表  │                   │ · 读 storage 中的 Key     │
│ · 滚动增量补译   │                   │ · 调 OpenAI-compatible    │
│ · 透镜 + 快捷键  │                   │ · schema 校验 / 分片重试   │
└────────┬────────┘                   │ · 可选 session 缓存       │
         │                            └──────────────────────────┘
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Lens Overlay UI │     │ Options / Popup │
│ 矩形面板 + 高亮  │     │ 配置 AI 与开关   │
└─────────────────┘     └─────────────────┘
```

### 3.1 Options / Popup

- `baseURL`（如 `https://api.openai.com/v1` 或兼容网关）
- `API Key`
- `model`
- 源语言 / 目标语言（默认 `en` → `zh`）
- 自动预译开关（默认开）
- 本站启用/暂停（按 hostname 黑/白名单，MVP 至少支持「暂停此站」）
- 透镜快捷键配置与说明（MVP：Content 内 `keydown`/`keyup` 实现「按住」；默认 `Alt+Shift+L`，Options 可改）

### 3.2 Background Service Worker

- 唯一允许读取 API Key 的上下文。
- 接收 `translate-batch` 消息，过滤已缓存 id，按块数/字符上限分片请求。
- 调用 `POST {baseURL}/chat/completions`（路径与兼容端点对齐；可配置是否已含 `/v1`）。
- 优先使用 `response_format: { type: "json_schema", json_schema: ... }`；不支持则降级为严格 JSON prompt + 本地解析。
- 校验响应；失败重试策略见 §6。
- 可选：`chrome.storage.session` 按 `pageKey` 缓存译文。

### 3.3 Content Script

- 页面 load / 可见稳定后 `extractVisibleBlocks()`。
- 维护内存结构：
  - `BlockRegistry`: `id → { el, text, tag, status }`
  - `TranslationMap`: `id → string`
- 滚动 debounce、MutationObserver（节流）触发增量抽块与补译。
- 监听快捷键：`keydown` / `keyup` / `window.blur` 实现按住语义（见 §8）。
- 透镜激活期间：`mousemove` → `elementFromPoint` / `elementsFromPoint` → 解析所属注册块 → 更新 UI。

### 3.4 Lens UI

- 注入到页面的 overlay（Shadow DOM 推荐，避免站点 CSS 污染）。
- 矩形面板跟随指针（偏移，避免遮挡光标），限制在 viewport 内。
- 源块 `outline` 高亮（仅激活期间）。
- 状态：就绪 / 翻译中 / 无可译文本 / 失败。

## 4. 数据流

```
Page load
  → extractVisibleBlocks()
  → runtime.sendMessage({ type: "translate-batch", pageKey, blocks })
  → Background: OpenAI-compatible completion (json_schema)
  → { items: [{ id, translation }] }
  → Content: TranslationMap update
User holds hotkey + moves mouse
  → elementFromPoint → nearest registered block
  → Lens shows translation (or pending/error state)
User releases hotkey
  → Lens unmount / hide; page still pure English
```

### 4.1 文本块抽取（MVP）

**候选标签：** `p, h1–h6, li, blockquote, figcaption, td, th, dt, dd, summary`。  
对 `div/span` 仅在「直接文本足够长且无块级子结构」时保守纳入，避免把整页壳节点当成一块。

**跳过：** `nav, script, style, noscript, code, pre, textarea, input, [contenteditable], [aria-hidden="true"]`，以及扩展自身 UI。

**可见性：** 与视口相交；可预取视口外约半屏以减少滚动空白。排除 `display:none`、零尺寸、不可见。

**文本：** `trim` 后长度不低于阈值（建议 8–12 字符）；过滤纯数字/纯符号。

**稳定 id：** `hash(normalizedText + tag + coarsePath)`；同页相同 id 合并。`normalizedText` 做空白折叠。节点被替换时允许新 id；旧译文 cache 可按 text hash 命中。

### 4.2 请求逻辑结构

```json
{
  "source_lang": "en",
  "target_lang": "zh",
  "blocks": [
    { "id": "b_a1f3", "tag": "h1", "text": "The Rise of Language Learning" },
    { "id": "b_92c0", "tag": "p", "text": "Modern tools make immersion..." }
  ]
}
```

实际发往模型时：system/user prompt 说明「忠实翻译、保持术语、不要解释、只输出 schema 对象」；`blocks` 作为 user 内容传入。

### 4.3 响应 JSON Schema

```json
{
  "name": "translate_batch_result",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["items"],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["id", "translation"],
          "properties": {
            "id": { "type": "string" },
            "translation": { "type": "string" }
          }
        }
      }
    }
  }
}
```

Content 侧只接受 **id 属于本批请求** 的条目；未知 id 丢弃。缺失 id 保持 `pending/failed`，可在后续批补齐。

### 4.4 分片、滚动与 SPA

- 单批上限：约 20–40 块 **或** 总字符上限（实现时定具体数字，优先字符上限防超 context）。
- 滚动：`scroll` / `resize` 后 **300ms debounce**，只提交**尚未成功翻译**且新进入预取区的块。
- SPA：`MutationObserver` 节流（如 500ms）增量扫描；移除节点从「可命中」集合剔除，译文可保留在 Map 中。
- 缓存：`pageKey = origin + pathname + 粗粒度 search`（忽略 tracking 参数可后期优化）；session 级即可。

## 5. 透镜交互细节

| 项 | 规则 |
|----|------|
| 默认快捷键 | `Alt/Option + Shift + L`（Options 可改） |
| 开 | 按住该组合键 |
| 关 | 松开 → 立即隐藏透镜与源块高亮 |
| 位置 | 指针旁固定偏移；贴边时镜像 |
| 尺寸 | 宽度默认 ~320px（范围 280–360）；高度随内容，最大高度后透镜内滚动 |
| 锚定 | `elementsFromPoint` 向上找最近注册块（弱网时可显示上一块直至指针进入新块） |
| 形状 | **矩形**圆角面板，非圆形 |

### 5.1 透镜状态文案

| 状态 | 展示 |
|------|------|
| ready | 该块中文全文（`textContent`） |
| pending | 「翻译中…」；可触发该块优先插队请求 |
| empty | 「此处无可译文本」 |
| error | 简短错误说明（如「翻译失败」） |
| unconfigured | 「请先配置 API」 |

## 6. 错误处理

| 情况 | 行为 |
|------|------|
| 未配置 baseURL/Key/model | 不自动狂发请求；popup/透镜提示去 Options |
| HTTP 401/403 | 停止批量；提示检查 Key |
| 429 / 5xx | 指数退避，有限次重试（如最多 3 次） |
| 网络失败 | 标记本批失败；透镜显示网络错误 |
| JSON 解析/schema 失败 | 同批重试 1 次；仍失败则块标 `error` |
| 部分 id 缺失 | 已返回的写入 Map；缺失保持 pending/error |

不在页面抛未捕获异常；Background 与 Content 用消息协议返回 `{ ok, error?, data? }`。

## 7. 安全与权限

- API Key 仅存 `chrome.storage.local`，仅 Background 读取；禁止写入页面 `window` 或 DOM。
- 透镜内容一律 `textContent` / 等价安全 API，防止译文 XSS。
- Host 权限：MVP 使用 **optional host permissions**（用户对当前站授权后注入），或文档说明为何需要 `<all_urls>`；默认推荐 optional + activeTab 组合以降低审核与用户顾虑。
- 不收集用户阅读内容到自有服务器（MVP 无后端）；流量仅用户配置的 AI 端点。

## 8. 消息协议（草案）

```ts
// Content → Background
type ToBackground =
  | { type: "translate-batch"; pageKey: string; blocks: { id: string; tag: string; text: string }[] }
  | { type: "get-settings" }
  | { type: "ping" };

// Background → Content
type FromBackground =
  | { type: "translate-batch-result"; ok: true; translations: { id: string; translation: string }[] }
  | { type: "translate-batch-result"; ok: false; error: string; failedIds?: string[] }
  | { type: "settings"; settings: UserSettings };
```

**按住检测（明确决策）：** MVP 在 Content Script 内用 `keydown` / `keyup` / `window.blur` 实现按住语义，默认键位 `Alt+Shift+L`；Options 可改修饰键组合。不依赖 `chrome.commands` 做按住（commands 难以表达 keyup）。后续若需要全局级命令，可再增加可选的 toggle 命令，但不作为默认学习路径。

## 9. 配置默认值

| 键 | 默认 |
|----|------|
| baseURL | 空（或 `https://api.openai.com/v1` 占位提示） |
| apiKey | 空 |
| model | 空（或 `gpt-4o-mini` 作为 placeholder 文案） |
| sourceLang | `en` |
| targetLang | `zh` |
| autoTranslate | `true` |
| lensWidthPx | `320` |
| minTextLength | `10` |
| batchCharLimit | `6000` |
| prefetchMarginPx | 半屏约 `0.5 * viewportHeight` |

## 10. 测试策略

### 10.1 单元（纯函数）

- 文本规范化与 id hash 稳定性。
- 块过滤（过短、跳过标签、去重）。
- 响应 JSON 校验与 id 白名单过滤。
- 分片算法（块数/字符上限）。

### 10.2 集成 / 手工

- 静态文章页：预译后按住透镜，多段落切换正确。
- 松开后无残留高亮与面板。
- 滚动加载更多：新段落可补译。
- 错误：错误 Key、断开网络时的 UI。
- Options 保存后 background 使用新配置。

### 10.3 回归关注点

- 站点 CSS 不得破坏透镜（Shadow DOM）。
- 不修改原文 DOM 文本节点内容。
- 快速移动鼠标时透镜内容不严重错乱（以当前块为准即可）。

## 11. 仓库与实现轮廓（非本阶段编码）

建议目录（实现计划可微调）：

```
chrome-trans/
  manifest.json
  src/
    background/
    content/
      extract.ts
      registry.ts
      lens.ts
      index.ts
    shared/
      schema.ts
      messages.ts
      settings.ts
    options/
    popup/
  docs/superpowers/specs/
```

技术选型：TypeScript + 轻量打包（如 Vite + `@crxjs/vite-plugin` 或等价 MV3 方案）。实现计划阶段确定。

## 12. 里程碑（供实现计划拆分）

1. MV3 脚手架 + Options 存取 settings  
2. 抽块 + 注册表 + 假译文（本地 echo）验证透镜  
3. Background OpenAI 兼容客户端 + json_schema 批量翻译  
4. 自动预译可见区 + 滚动增量  
5. 错误处理、暂停本站、session 缓存  
6. 手工测试清单与 README

## 13. 开放细节（实现时可定，不阻塞设计）

- 精确默认快捷键与冲突规避文案。
- batch 字符上限与 model context 的自适应（MVP 固定阈值即可）。
- tracking query 从 pageKey 中剥离的规则。
- popup 是否展示「本页已译块数」调试信息。
