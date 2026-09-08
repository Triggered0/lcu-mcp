# Phase 2: CDP Multi-Target Discovery (`lol_cdp_targets`) & Client Screenshot (`lol_cdp_screenshot`)

## Goal

Provide deep frontend visibility into the League Client CEF renderers:
1. **Target Inspection (`lol_cdp_targets`)**: Enumerate all active CDP debugging targets (main UX, popups, background scripts, DevTools frames) with metadata and connection status.
2. **Visual Screenshot Capture (`lol_cdp_screenshot`)**: Capture high-fidelity screenshots of the League client UI via CDP `Page.captureScreenshot`, returning base64/image content blocks and optionally saving to disk for visual verification.

## Architecture

```
                       ┌─────────────────────────┐
                       │  http://127.0.0.1:port  │
                       └───────────┬─────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   GET /json/list                             Page.captureScreenshot
   (Redact target URLs)                       (Active CEF Page target)
              │                                         │
              ▼                                         ▼
   ┌──────────────────────┐                   ┌──────────────────────┐
   │   lol_cdp_targets    │                   │ lol_cdp_screenshot   │
   │  [{ id, type, ... }] │                   │ Base64 image + disk  │
   └──────────────────────┘                   └──────────────────────┘
```

## Locked Decisions

| Decision | Rationale |
|---|---|
| Redact secrets from target URLs | Target URLs often carry the LCU session token in the query or basic auth (`https://riot:PASS@...`). Redact using existing `redactUrl`. |
| Dual output for screenshots | Return MCP image content `{ type: "image", data, mimeType }` so multimodal assistants can inspect the UI directly, plus file save support (`savePath`) for persistent logs. |
| Target-aware screenshotting | By default screenshots the active `page` target; accepts optional `targetId` to screenshot specific popup/utility windows. |
| Page domain activation | Ensure `Page.enable` is invoked prior to `Page.captureScreenshot` to satisfy CEF requirements. |

## Tool Definitions

### 1. `lol_cdp_targets`
- **Description**: List all active CDP targets available on the League Client DevTools port (main page, popups, workers).
- **Input**: None
- **Output**:
  ```ts
  {
    port: number,
    targets: Array<{
      id: string,
      type: string,
      title: string,
      url: string,
      webSocketDebuggerUrl?: string
    }>
  }
  ```

### 2. `lol_cdp_screenshot`
- **Description**: Capture a screenshot of the League Client window using CDP. Returns image data and can optionally save to disk.
- **Input Schema**:
  ```ts
  {
    targetId: z.string().optional().describe('CDP target ID to screenshot (defaults to active main page)'),
    format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image encoding format'),
    quality: z.number().int().min(0).max(100).optional().describe('Compression quality for jpeg/webp'),
    savePath: z.string().optional().describe('Optional absolute path to save the screenshot on disk')
  }
  ```
- **Output**:
  Returns MCP text summary and MCP image content block with base64 data.
