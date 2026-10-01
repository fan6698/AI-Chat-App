import assert from 'node:assert/strict'
import { createServer } from 'vite'

// 用 Map 模拟 localStorage，storage.ts 通过 window.localStorage 访问
function createMockStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    _size: () => map.size,
  }
}

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const KEY = 'ai-chat-assistant:messages:v1'
const results = []

/** 每次用例都重新加载模块，避免模块级缓存影响结果 */
async function freshModule(storageImpl) {
  globalThis.window = storageImpl === null ? undefined : { localStorage: storageImpl }
  return server.ssrLoadModule('/src/storage.ts')
}

const now = Date.now()
const good = [
  { role: 'user', content: '你好', timestamp: now },
  { role: 'assistant', content: '我是助手', timestamp: now + 1 },
]

// 1. 空存储
{
  const s = await freshModule(createMockStorage())
  assert.deepEqual(s.loadMessages(), [])
  results.push('空存储返回空列表 OK')
}

// 2. 正常存取往返
{
  const mock = createMockStorage({ [KEY]: JSON.stringify(good) })
  const s = await freshModule(mock)
  assert.deepEqual(s.loadMessages(), good, '往返存取数据不一致')

  s.saveMessages([...good, { role: 'user', content: '再问一句', timestamp: now + 2 }])
  assert.equal(s.loadMessages().length, 3, '追加写入失败')
  results.push('存取往返 OK')
}

// 3. 损坏的 JSON
{
  const s = await freshModule(createMockStorage({ [KEY]: '{这不是合法JSON' }))
  assert.deepEqual(s.loadMessages(), [], '损坏 JSON 未降级为空列表')
  results.push('JSON 损坏降级 OK')
}

// 4. 合法的 JSON 但不是数组
{
  const s = await freshModule(
    createMockStorage({ [KEY]: JSON.stringify({ role: 'user', content: 'hi' }) }),
  )
  assert.deepEqual(s.loadMessages(), [])
  results.push('非数组降级 OK')
}

// 5. 脏项逐条过滤（只留合法的那条）
{
  const dirty = [
    { role: 'user', content: '合法消息', timestamp: now },
    { role: 'system', content: '非法角色', timestamp: now },
    { role: 'user', content: 123, timestamp: now },
    { role: 'user', content: '   ', timestamp: now },
    { role: 'user', content: '缺时间戳' },
    { role: 'assistant', content: 'NaN 时间戳', timestamp: NaN },
    null,
    undefined,
    'string-not-object',
  ]
  const s = await freshModule(createMockStorage({ [KEY]: JSON.stringify(dirty) }))
  const loaded = s.loadMessages()
  assert.equal(loaded.length, 1, `应只剩 1 条合法消息，实际 ${loaded.length} 条`)
  assert.equal(loaded[0].content, '合法消息')
  results.push('脏项逐条过滤（保留 1/9） OK')
}

// 6. 保存时跳过空内容占位气泡
{
  const mock = createMockStorage()
  const s = await freshModule(mock)
  s.saveMessages([
    { role: 'user', content: '提问', timestamp: now },
    { role: 'assistant', content: '', timestamp: now + 1 },
    { role: 'assistant', content: '回答内容', timestamp: now + 2 },
  ])
  const loaded = s.loadMessages()
  assert.equal(loaded.length, 2, '空内容的占位气泡未被跳过')
  assert.ok(!loaded.some((m) => m.content === ''))
  results.push('空占位气泡不入库 OK')
}

// 7. 清空
{
  const mock = createMockStorage({ [KEY]: JSON.stringify(good) })
  const s = await freshModule(mock)
  assert.equal(s.loadMessages().length, 2)
  s.clearMessages()
  assert.deepEqual(s.loadMessages(), [], '清空后仍能读到数据')
  assert.equal(mock._size(), 0, '键未被真正移除')
  results.push('清空对话 OK')
}

// 8. localStorage 不可用 / 抛异常时不能崩
{
  const s = await freshModule(null) // window 不存在
  assert.deepEqual(s.loadMessages(), [])
  assert.doesNotThrow(() => s.saveMessages(good))
  assert.doesNotThrow(() => s.clearMessages())
  results.push('localStorage 不可用时静默降级 OK')
}

// 9. setItem 抛异常（如超配额）不应影响聊天流程
{
  const throwing = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    },
    removeItem: () => {},
    clear: () => {},
  }
  const s = await freshModule(throwing)
  assert.doesNotThrow(() => s.saveMessages(good))
  results.push('超出配额时写入静默失败 OK')
}

console.log(results.map((r) => '  ✓ ' + r).join('\n'))
console.log(`\n全部 ${results.length} 项通过`)

await server.close()
