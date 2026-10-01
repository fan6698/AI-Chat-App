import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'vite'

/**
 * 校验 Markdown 渲染与代码高亮。
 *
 * 注意：不能用 createServer + ssrLoadModule —— SSR 模式下依赖会被外部化，
 * Node 加载到的是含全部语言的 CJS 版本，任何语言都能高亮，测不出"按需注册"的真实效果。
 * 这里连同 react-dom/server 一起打包（ssr.noExternal），还原浏览器侧的依赖解析。
 */
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-verify-'))

await build({
  root: process.cwd(),
  logLevel: 'error',
  ssr: { noExternal: true },
  build: {
    ssr: 'scripts/md-verify-entry.ts',
    outDir,
    emptyOutDir: true,
  },
})

const { Markdown, renderToStaticMarkup, createElement } = await import(
  'file://' + path.join(outDir, 'md-verify-entry.js').replace(/\\/g, '/')
)

function render(md) {
  return renderToStaticMarkup(createElement(Markdown, null, md))
}

function renderCode(language, code) {
  return render('```' + language + '\n' + code + '\n```')
}

/** Prism 高亮后会输出 class="token 的 span */
function tokenCount(html) {
  return (html.match(/class="token/g) || []).length
}

const results = []

// 1. 已注册语言与别名都必须真正高亮（模型常输出 js / sh / py 这类简写）
const highlighted = {
  ts: 'const a: number = 1',
  js: "const b = 'x'",
  tsx: 'const el = <div />',
  json: '{"a": 1}',
  py: "print('hi')",
  html: '<div class="w">hi</div>',
}
for (const [language, code] of Object.entries(highlighted)) {
  const html = renderCode(language, code)
  assert.ok(tokenCount(html) > 0, `${language} 未高亮`)
}
results.push('已注册语言与别名高亮 OK（' + Object.keys(highlighted).join('/') + '）')

// 2. 未注册语言：不崩、内容保留、仅无高亮（避免全量语言被打包）
{
  const html = renderCode('rust', 'fn main() {}')
  assert.match(html, /main/, '未注册语言丢失了内容')
  assert.equal(tokenCount(html), 0, '未注册语言不应产生高亮 token')
  results.push('未注册语言降级为纯文本 OK')
}

// 3. 不应残留 react-markdown 默认生成的 <pre> 包裹
{
  const html = renderCode('ts', 'let x = 1')
  assert.ok(!html.includes('<pre'), '代码块外层仍有多余的 <pre> 包裹')
  results.push('无多余 <pre> 包裹 OK')
}

// 4. 行内代码走独立样式，不走代码块高亮
{
  const html = render('使用 `npm install` 安装依赖')
  assert.equal(tokenCount(html), 0, '行内代码不应触发代码块高亮')
  assert.match(html, /npm install/)
  results.push('行内代码渲染 OK')
}

// 5. 代码块应带语言标签与复制按钮
{
  const html = renderCode('ts', 'let x = 1')
  assert.match(html, /复制/, '代码块缺少复制按钮')
  assert.match(html, /ts/, '代码块缺少语言标签')
  results.push('代码块语言标签 + 复制按钮 OK')
}

// 6. 普通 Markdown 仍能正常渲染
{
  const html = render('**加粗** 与 [链接](https://example.com)')
  assert.match(html, /<strong>/, '加粗未渲染')
  assert.match(html, /<a /, '链接未渲染')
  results.push('普通 Markdown 渲染 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)
