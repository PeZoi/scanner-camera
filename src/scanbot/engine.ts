/**
 * Phải trùng phiên bản `scanbot-web-sdk` trong package.json (engine WASM tải từ CDN).
 * Production: nên self-host `bundle/bin/complete/` — xem README Scanbot.
 */
export const SCANBOT_WEB_SDK_VERSION = '8.1.1' as const

export function scanbotEnginePath(): string {
  return `https://cdn.jsdelivr.net/npm/scanbot-web-sdk@${SCANBOT_WEB_SDK_VERSION}/bundle/bin/complete/`
}
