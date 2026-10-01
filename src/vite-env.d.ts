/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 智谱 AI 的 API Key，仅在本地开发（直连模式）下配置。
   * 部署到公网时**不要设置**它：带 VITE_ 前缀的变量会被打包进前端产物，
   * 任何人打开 DevTools 都能看到。留空即自动走服务端代理 /api/chat。
   */
  readonly VITE_ZHIPU_API_KEY?: string
  /** 直连模式下的接口地址前缀，可选，默认官方 v4 地址 */
  readonly VITE_ZHIPU_BASE_URL?: string
  /** 直连模式下使用的模型编码，可选，默认 glm-4-flash */
  readonly VITE_ZHIPU_MODEL?: string
  /** 服务端代理地址，可选，默认同源的 /api/chat */
  readonly VITE_CHAT_ENDPOINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
