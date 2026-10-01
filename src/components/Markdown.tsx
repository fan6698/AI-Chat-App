import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import ReactMarkdown, { type Components } from 'react-markdown'
import CopyButton from './CopyButton'

// 按需注册，避免打包全部语言（全量约 950 kB，按需后体积大幅下降）
// 同一份语法注册到多个别名：模型常输出 js / sh / py 这类简写，
// 未注册的语言会静默不高亮，补上别名即可覆盖。
const LANGUAGE_ALIASES: Array<[string, typeof javascript]> = [
  ['bash', bash],
  ['sh', bash],
  ['shell', bash],
  ['zsh', bash],
  ['css', css],
  ['javascript', javascript],
  ['js', javascript],
  ['json', json],
  ['jsx', jsx],
  ['python', python],
  ['py', python],
  ['markup', markup],
  ['html', markup],
  ['xml', markup],
  ['tsx', tsx],
  ['typescript', typescript],
  ['ts', typescript],
]

for (const [name, grammar] of LANGUAGE_ALIASES) {
  SyntaxHighlighter.registerLanguage(name, grammar)
}

/** 代码块：语言标签 + 复制按钮 + 高亮主体 */
function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-black/10">
      <div className="flex items-center justify-between bg-black/5 px-3 py-1">
        <span className="font-mono text-[11px] text-slate-500">{language}</span>
        <CopyButton text={code} variant="code" />
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneLight}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          padding: '0.75rem',
          fontSize: '0.8125rem',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

const components: Components = {
  // 让 pre 直接透传子节点，否则代码块会被 react-markdown 默认生成的 <pre> 多包一层，
  // 既带来多余的 monospace/white-space 继承，也让代码块容器的样式难以控制
  pre({ children }) {
    return <>{children}</>
  },

  code({ className, children }) {
    const language = /language-(\w+)/.exec(className ?? '')?.[1]

    if (!language) {
      return (
        <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[0.85em] text-pink-600">
          {children}
        </code>
      )
    }

    return (
      <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />
    )
  },
}

interface MarkdownProps {
  children: string
}

export default function Markdown({ children }: MarkdownProps) {
  return (
    <div className="text-sm leading-relaxed break-words [&_li]:ml-5 [&_li]:list-disc [&_ol]:my-2 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:my-0 [&_ul]:my-2 [&_ul]:list-disc">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  )
}
