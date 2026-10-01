import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const { createDeltaBuffer } = await server.ssrLoadModule('/src/utils/deltaBuffer.ts')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const INTERVAL = 30

/** 记录刷新次数与刷新内容的工具 */
function createRecorder(intervalMs = INTERVAL) {
  const chunks = []
  const buffer = createDeltaBuffer({
    intervalMs,
    onFlush: (delta) => chunks.push(delta),
  })
  return { buffer, chunks, text: () => chunks.join('') }
}

const results = []

// 1. 密集推送：绝大多数 token 应被合并，且最终文本不能丢
{
  const { buffer, chunks, text } = createRecorder()
  for (let i = 0; i < 300; i++) buffer.push('a') // 同一 tick 内 300 个 token
  buffer.dispose()

  assert.equal(text(), 'a'.repeat(300), '合并过程中丢了字符')
  // 预期 2 次：第 1 个 token 立即刷新（首字体感优先），其余 299 个被 dispose 一次性冲刷
  assert.equal(chunks.length, 2, `300 个同 tick token 合并后应有 2 次刷新，实际 ${chunks.length} 次`)
  assert.equal(chunks[0], 'a', '首个 token 应立即单独刷新')
  assert.equal(chunks[1].length, 299, '剩余 token 应合并为一次刷新')
  results.push('密集推送合并 OK（300 token → 2 次刷新）')
}

// 2. 首字必须立刻上屏，不能等一个间隔
{
  const { buffer, chunks } = createRecorder(1000) // 间隔故意设很大
  buffer.push('第')
  assert.equal(chunks.length, 1, '首字未立即刷新，用户会感觉卡顿')
  results.push('首字立即上屏 OK')
}

// 3. 持续流式：刷新次数应与时长相关，而与 token 数无关（这才是节流的关键）
{
  const { buffer, chunks, text } = createRecorder(INTERVAL)
  let pushed = 0
  const start = performance.now()

  while (performance.now() - start < 200) {
    buffer.push('x')
    pushed += 1
    await sleep(2) // 模拟 token 到达间隔
  }
  buffer.dispose()

  const elapsed = performance.now() - start
  assert.equal(text().length, pushed, '流式过程中丢了字符')
  // 刷新次数上限 = 时长 / 间隔 + 少量余量（定时器精度影响）
  const maxExpected = Math.ceil(elapsed / INTERVAL) + 2
  assert.ok(
    chunks.length <= maxExpected,
    `${elapsed.toFixed(0)}ms 内刷新了 ${chunks.length} 次，超过节流上限 ${maxExpected}`,
  )
  assert.ok(pushed > chunks.length, '节流未生效：刷新次数未少于 token 数')
  results.push(
    `持续流式节流 OK（${pushed} token → ${chunks.length} 次刷新，${elapsed.toFixed(0)}ms，上限 ${maxExpected}）`,
  )
}

// 4. dispose 必须冲刷剩余内容，否则最后几个字会丢
{
  const recorder = createRecorder(INTERVAL)
  recorder.buffer.push('尾部残余')
  recorder.buffer.dispose()
  assert.equal(recorder.text(), '尾部残余', 'dispose 未冲刷剩余内容')
  results.push('dispose 冲刷残余 OK')
}

// 5. dispose 之后不应再有定时器回调（避免卸载后继续 setState）
{
  const recorder = createRecorder(INTERVAL)
  recorder.buffer.push('计时')
  recorder.buffer.dispose()
  const countAfterDispose = recorder.chunks.length
  await sleep(INTERVAL * 3)
  assert.equal(recorder.chunks.length, countAfterDispose, 'dispose 后仍在刷新，定时器泄漏')
  results.push('dispose 后无残留定时器 OK')
}

// 6. 顺序与完整性：多轮推送后再 dispose
{
  const recorder = createRecorder(INTERVAL)
  const expected = '你好，这是一段用于校验顺序是否正确的中文文本。'
  for (const char of expected) recorder.buffer.push(char)
  recorder.buffer.dispose()
  assert.equal(recorder.text(), expected, '文本顺序或内容不一致')
  results.push('顺序与完整性 OK')
}

// 7. 空 delta 不应触发无意义的刷新
{
  const recorder = createRecorder(INTERVAL)
  recorder.buffer.push('')
  recorder.buffer.push('')
  assert.equal(recorder.chunks.length, 0, '空内容不应触发刷新')
  recorder.buffer.push('有内容')
  recorder.buffer.dispose()
  assert.equal(recorder.text(), '有内容')
  results.push('空内容不刷新 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)

await server.close()
