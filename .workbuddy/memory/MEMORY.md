# AI 聊天助手 · 项目长期记忆

## 项目概述
React + TypeScript + Vite 的 AI 聊天 Web 应用，调用智谱 AI Chat Completions API（stream 模式），LocalStorage 存对话历史。

## 部署架构（两种模式，靠 VITE_ZHIPU_API_KEY 是否为空自动切换）
- **直连模式**（本地）：设置了 `VITE_ZHIPU_API_KEY` → 浏览器带 Bearer 直连智谱。Key 会打进产物，仅限本地。
- **代理模式**（部署默认）：不设 `VITE_ZHIPU_API_KEY` → 前端请求同源 `/api/chat`，由 `api/chat.ts`（Vercel Serverless Function）读 `process.env.ZHIPU_API_KEY` 转发，SSE 字节流原样透传，前端解析逻辑不用改。
- 代理已做：仅 POST、入参校验（最多 50 条 / 总长 20000 字符）、上游错误透传、`maxDuration: 60`。**未做身份校验**——公开分享前需自加口令或限流，否则等于开放额度。
- `api/**/*.ts` 已加入 tsconfig.node.json 的 include，享受 Node 类型检查。
- 实测：直连构建产物能 grep 到真实 Key（1 个文件）；无 Key 的部署构建为 0，且正确引用 /api/chat。

## 需求与设计文档
- 三份文档在项目根目录：`PRD.md`（功能与界面）、`tech_design.md`（技术栈/数据结构/API）、`agends.md`（注：文件名是 agends 而非 agents，开发规范）。
- **重要坑点**：这三份 md 是 **UTF-16LE + BOM** 编码，Read 工具会报"binary file"读不出。需先转换：
  ```bash
  iconv -f UTF-16LE -t UTF-8 PRD.md | tr -d '\r' | sed '1s/^\xef\xbb\xbf//' > /tmp/PRD.md
  ```

## 技术栈（2026-10-01 初始化）
- Vite 8.3 + React 19.2 + TypeScript 6.0（模板使用 oxlint 而非 eslint）
- Tailwind CSS **v4**：用 `@tailwindcss/vite` 插件 + `@import 'tailwindcss'`，**无 tailwind.config.js**
- react-markdown 10.1 / react-syntax-highlighter 16.1

## 数据层 API（src/api.ts）
- 智谱端点：`https://open.bigmodel.cn/api/paas/v4/chat/completions`，Bearer 鉴权，stream=true，SSE `data:` 行，结束 `data: [DONE]`
- 对外：`streamChatCompletion(messages, {signal, model, temperature})` 异步生成器；`requestChatStream(messages, {onDelta})` 回调式
- 错误：统一 `ChatApiError`（message 可直接展示）；中断透传原生 `AbortError`，UI 需自行判断 `err.name === 'AbortError'`
- 环境变量：`VITE_ZHIPU_API_KEY`（必填）、`VITE_ZHIPU_MODEL`、`VITE_ZHIPU_BASE_URL`，类型声明在 `src/vite-env.d.ts`

## 本地持久化（src/storage.ts）
- key `ai-chat-assistant:messages:v1`，**末尾 v1 是 schema 版本号**：`Message` 结构变更时必须递增，让旧数据自然失效
- 读取逐条校验（role/content/timestamp），脏数据单条丢弃而非整列报废；保存跳过空内容占位气泡
- localStorage 不可用（隐私模式）或超配额一律静默降级，不抛错、不阻塞聊天
- 写入防抖 400ms（`SAVE_DEBOUNCE_MS`），避免流式时每 token 全量 JSON.stringify

## 界面层（src/components/）
- `ChatInterface.tsx` 持有全部状态（messages/input/loading/error），`ChatMessage.tsx` 是无状态气泡（用户在右、AI 在左）
- 发送流程：构造 `[...messages, userMessage]` 作为 history → 追加空 assistant 占位气泡 → `streamChatCompletion(history)` 逐 token `appendToLastAssistant`
- 多轮对话靠把整个 history 数组传给 API 实现，接口层无状态、无 session
- 加载态：`loading` 控制 textarea `disabled` + 按钮切换为"停止"（AbortController）+ 气泡内显示「思考中…」
- **坑**：textarea 被 `disabled` 会丢焦点，生成结束后必须 `requestAnimationFrame(() => ref.current?.focus())` 收回，否则用户答完要手动点回输入框
- Enter 发送需判 `!event.nativeEvent.isComposing`，否则中文输入法回车选词会误发送

## 流式渲染性能（三者缺一不可）
- `src/utils/deltaBuffer.ts`：合并 token → 最小间隔 40ms 一次 setState（`STREAM_FLUSH_INTERVAL_MS`，30~60ms 合理）；超时后首个 token 同步立即刷新保证首字体感；结束时必须 `dispose()` 冲刷残余，否则丢字
- `ChatMessage` 必须 `memo` 包裹：否则每次刷新会让所有历史消息重渲染并重解析 Markdown，长对话下比节流本身影响更大
- 缓冲区每请求一份（在 handleSend 内创建），避免清空对话后旧请求残余串到新回答

## 交互约定
- 自动滚动：只在用户处于底部 60px 内时吸底（`STICK_THRESHOLD_PX`），上翻不打断；自动滚动后 500ms 内忽略 scroll 事件（`AUTO_SCROLL_GUARD_MS`），否则 smooth 动画的中途位置会被误判成用户滚动
- 复制：`src/utils/clipboard.ts` + `CopyButton.tsx`，异步剪贴板失败时 textarea+execCommand 兜底；按钮常驻而非 hover 显示（触屏可用）
- 代码高亮：`src/components/Markdown.tsx` 里 `LANGUAGE_ALIASES` 数组同时注册别名（js/ts/sh/py/html/xml…），新增语言往数组加即可
- `components.pre` 必须返回 `<>{children}</>`，否则代码块被 react-markdown 默认的 `<pre>` 多包一层

## 验证方式
- `npm run verify` 跑全部（api 9 + storage 9 + markdown 6）
- **markdown 验证必须用 `vite build`（ssr.noExternal）打包后再渲染**；用 `createServer + ssrLoadModule` 会因依赖被外部化而加载到含全部语言的 CJS 版本，导致任何语言都能高亮，测不出 alias 是否生效
- 套路：一律加载真实源码模块，不要拷贝代码去测
- `npm run verify` 跑全部（api 9 例 + storage 9 例）
  - `verify:api` → `scripts/verify-api.mjs`：Vite SSR 加载真实 api.ts + mock fetch，覆盖流式拼接/跨分片/CRLF/[DONE]/401/signal
  - `verify:storage` → `scripts/verify-storage.mjs`：mock window.localStorage，覆盖往返/损坏 JSON/非数组/脏项过滤/占位气泡/清空/隐私模式/超配额
- 套路：**加载真实源码模块**靠 `createServer + ssrLoadModule`（临时 envDir 注入 env），不要拷贝代码去测
- **构建通过不代表 api.ts 被验证**：无组件引用时会被 tree-shake，务必单独跑上面的脚本

## 项目约定
- tsconfig.app.json 已显式开启 `strict: true`（TS6 模板默认不写）
- tsconfig.app.json 开启 `noUnusedLocals` / `noUnusedParameters`，写组件时别留未用变量
- 代码高亮必须用 `PrismLight` + `registerLanguage` 按需注册；全量 Prism 会让 bundle 从 398 kB 涨到 965 kB
- API Key 通过 `import.meta.env.VITE_ZHIPU_API_KEY` 读取，`.env.local` 已 gitignore

## 环境踩坑
- 沙箱下 npm/vite 清理文件时可能报 `[safe-delete] 操作失败: Error during a trash operation`（genie-safe-delete 包装器与 Windows 回收站冲突）。npm install 的 cleanup 警告可忽略；`vite build` 清空 dist 失败时先手动 `rm -rf dist` 再构建。
- Node 用 managed 版本：`export PATH="/c/Users/42990/.workbuddy/binaries/node/versions/22.22.2:$PATH"`
