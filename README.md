# AI 聊天助手

基于 React + TypeScript + Vite 的 AI 聊天 Web 应用，接入智谱 AI 流式对话接口。

## 技术栈

| 用途 | 依赖 |
| --- | --- |
| 框架 | React 19 + TypeScript + Vite 8 |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite` 插件，无 config 文件） |
| Markdown 渲染 | react-markdown 10 |
| 代码高亮 | react-syntax-highlighter 16（按需注册语言） |
| 对话接口 | 智谱 AI Chat Completions API（stream 模式） |
| 本地存储 | LocalStorage |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env.local   # Windows: copy .env.example .env.local
#    在 .env.local 中填入 VITE_ZHIPU_API_KEY

# 3. 启动开发服务器
npm run dev
```

## 可用脚本

- `npm run dev` 启动开发服务器
- `npm run build` 类型检查 + 生产构建
- `npm run preview` 预览构建产物
- `npm run lint` 静态检查
- `npm run verify` 运行全部本地验证（无需真实 API Key）
  - `verify:api` 用 mock SSE 验证 `src/api.ts` 流式解析
  - `verify:storage` 用 mock localStorage 验证 `src/storage.ts` 读写与容错
  - `verify:markdown` 把组件真实打包后渲染，验证代码高亮与语言别名
  - `verify:streaming` 验证打字机节流的合并、实时性与不丢字
  - `verify:proxy` 用 mock 请求验证服务端代理的转发、鉴权与入参校验

## 两种运行模式

| | 本地开发（直连） | 部署上线（服务端代理） |
| --- | --- | --- |
| 触发条件 | 设置了 `VITE_ZHIPU_API_KEY` | **不设置** `VITE_ZHIPU_API_KEY` |
| 请求目标 | 浏览器直连智谱 API | 同源的 `/api/chat` |
| Key 位置 | 打包进前端产物（任何人可见） | 仅服务端环境变量 |
| 适用场景 | 本地调试 | 任何公网部署 |

**部署时务必不要配置 `VITE_ZHIPU_API_KEY`。** 所有 `VITE_` 前缀的变量都会被 Vite 打包进前端产物，配了就等于把 Key 明文发布到网上。留空即可自动切换到代理模式。

## 目录结构

```
api/
└── chat.ts          服务端代理（Serverless Function），持有 API Key
src/
├── api.ts           智谱 AI 流式接口封装（SSE 解析 / 错误处理 / 中断）
├── storage.ts       LocalStorage 读写（含脏数据校验与版本 key）
├── types.ts         Message 等类型定义
├── components/
│   ├── ChatInterface.tsx  聊天主容器：消息列表 + 输入区 + 流式状态
│   ├── ChatMessage.tsx    单条消息气泡（用户在右、AI 在左）
│   ├── CopyButton.tsx     带状态反馈的复制按钮（已复制 / 复制失败）
│   └── Markdown.tsx       Markdown 渲染 + 代码高亮
├── utils/
│   ├── clipboard.ts       复制文本（异步剪贴板 + execCommand 兜底）
│   └── deltaBuffer.ts     打字机节流：合并 token 为低频状态更新
├── vite-env.d.ts    环境变量类型声明
├── App.tsx
├── index.css        Tailwind 入口
└── main.tsx
```

## 流式接口用法

```ts
import { streamChatCompletion } from './api'

// 方式一：异步生成器，逐块产出增量文本
for await (const delta of streamChatCompletion(messages, { signal })) {
  setAnswer((prev) => prev + delta)
}

// 方式二：回调式，同时拿到完整回答
const answer = await requestChatStream(messages, { onDelta: setText, signal })
```

错误统一抛出 `ChatApiError`，`message` 可直接展示给用户；用户中断时透传原生 `AbortError`。

## 对话持久化

- 存储 key：`ai-chat-assistant:messages:v1`，**末尾的 `v1` 是 schema 版本号**。以后 `Message` 结构变更时递增版本号，旧数据自然失效。
- 消息变化后防抖 400ms 写入，避免流式过程中每个 token 都全量序列化一次。
- 读取时逐条校验（role / content / timestamp），脏数据单条丢弃而非整列报废；保存时跳过尚未产出内容的占位气泡。
- 隐私模式、禁用 localStorage 或超出配额时静默降级，不影响聊天主流程。

## 交互与体验约定

- **自动滚动**：仅在用户停留在底部 60px 内时才吸底；用户上翻查看历史时不会被流式输出强行拽回。自动滚动后 500ms 内忽略 scroll 事件，避免把自身滚动误判成用户滚动。
- **复制**：AI 回答气泡下方、代码块标题栏均可复制。`navigator.clipboard` 在非 HTTPS 环境不可用，已用 textarea + `execCommand` 兜底；失败会显示"复制失败"。
- **复制按钮常驻显示**（而非 hover 才出现），触屏设备也点得到。
- **代码高亮**：按需注册语言，并为 `js`/`ts`/`sh`/`py`/`html`/`xml` 等常见简写别名注册。未注册的语言降级为纯文本，不会崩。
- **错误提示**：`ChatApiError` 的文案直接红条展示，并在下一次发送时自动清除。

## 流式渲染性能

三者必须配合，缺一个效果都会大打折扣：

1. **打字机节流**（`src/utils/deltaBuffer.ts`）：把高频 token 合并成最小 40ms 一次的状态更新，约 25 次/秒。超过间隔后的第一个 token 会同步立即刷新，保证首字不等帧、不牺牲体感；结束时 `dispose()` 必须冲刷残余，否则最后几个字会丢。
2. **`ChatMessage` 用 `memo` 包裹**：每次刷新只重建最后一条 AI 消息，历史消息不再跟着重渲染，其 Markdown 也不会被反复重新解析——这项对长对话的影响比节流本身更大。
3. **每个请求独立一份缓冲区**：避免用户中途清空对话后，上一轮残余文本串到新回答里。

调优点：`STREAM_FLUSH_INTERVAL_MS`（`ChatInterface.tsx`）越小越实时、越大越省 CPU；30~60ms 是兼顾体感与性能的区间。

## 部署

### 前置检查

```bash
npm install
npm run verify    # 37 项本地验证，无需真实 Key
npm run build     # 确认构建通过
```

### 部署到 Vercel（推荐）

1. **建 Git 仓库并推送**
   ```bash
   git init
   git add .
   git commit -m "feat: AI 聊天助手"
   # 在 GitHub 新建空仓库后：
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
   `.gitignore` 已忽略 `.env.local`、`.vercel`、`dist`，Key 不会被推上去。

2. **导入项目**
   登录 [vercel.com](https://vercel.com/) → Add New → Project → 选择刚推的仓库。
   Framework Preset 会自动识别为 **Vite**，构建命令 `npm run build`、输出目录 `dist`，一般无需改动。

3. **配置环境变量（最关键的一步）**
   在 Project → Settings → Environment Variables 中只添加这一条：

   | Name | Value |
   | --- | --- |
   | `ZHIPU_API_KEY` | 你的智谱 API Key |

   **不要添加 `VITE_ZHIPU_API_KEY`。** 它的值会被打进前端产物，等于把 Key 明文公开。

4. **部署**
   保存后点 Deploy（或重新 Deploy 一次让环境变量生效）。完成后拿到 `xxx.vercel.app` 域名。

5. **验证**
   - 打开域名发一条消息，能流式返回即成功
   - DevTools → Network → 找到 `/api/chat`，确认响应是 `text/event-stream`
   - 在页面上右键"查看源代码"，搜索 Key 的前几位，**应当搜不到**
   - 如果页面提示"服务端未配置 ZHIPU_API_KEY"，说明第 3 步没加上或加了没重新部署

### 部署到其他平台

| 平台 | 静态前端 | 后端代理 | 说明 |
| --- | --- | --- | --- |
| Vercel | ✅ | ✅ `api/` 目录自动识别 | 最省事，海外访问快 |
| Netlify | ✅ | 需把 `api/chat.ts` 改为 `netlify/functions/` 格式 | 函数写法需微调 |
| 腾讯云 EdgeOne Pages | ✅ | ✅ 边缘函数 | 国内访问快，需按平台要求改写函数签名 |
| GitHub Pages | ✅ | ❌ 纯静态，无后端 | 只能走直连模式，Key 会暴露，**不建议** |
| 自建服务器 | ✅ `npm run build` 后的 dist | ✅ 任意 Node 服务 | 最灵活，需自己运维 |

若目标平台不支持 Serverless Function，可把 `api/chat.ts` 的逻辑搬到一个最小 Node 服务（Express/Koa）里，前端把 `VITE_CHAT_ENDPOINT` 指向它的完整 URL 即可。

### 部署后的额度风险（重要）

加代理只是让 Key **不以明文出现**，但你的代理地址仍然是"任何人都能调用你的额度"。公开分享前建议至少做一层限制：登录鉴权、邀请码、按 IP 限流，或在 `api/chat.ts` 里加口令校验。当前实现已做了基础防护（最多 50 条消息、总长度 20000 字符上限），但**没有身份校验**。

## 注意事项

- API Key 只从环境变量读取（`import.meta.env` / `process.env`），禁止硬编码
- `.env.local` 已在 `.gitignore` 中忽略，切勿提交
- 公网部署走服务端代理，不要设置任何 `VITE_ZHIPU_API_KEY`
- 新增代码语法高亮语言时，需在 `src/components/Markdown.tsx` 中显式 `registerLanguage`，避免引入全量语言包
