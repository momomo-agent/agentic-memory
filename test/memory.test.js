// agentic-memory unit tests
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createMemory,
  createManager,
  createKnowledgeStore,
  estimateTokens,
  chunkText,
  cosineSimilarity,
  localEmbed,
} = require('../memory.js')

describe('agentic-memory', () => {
  // ── createMemory ──

  it('1. createMemory — creates an instance', () => {
    const mem = createMemory()
    assert.ok(mem, 'should return an instance')
    assert.equal(typeof mem.add, 'function')
    assert.equal(typeof mem.messages, 'function')
    assert.equal(typeof mem.history, 'function')
    assert.equal(typeof mem.info, 'function')
    assert.equal(typeof mem.clear, 'function')
  })

  it('2. add() — adds messages', async () => {
    const mem = createMemory()
    await mem.add('user', 'Hello')
    await mem.add('assistant', 'Hi there!')
    const msgs = mem.history()
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].role, 'user')
    assert.equal(msgs[0].content, 'Hello')
    assert.equal(msgs[1].role, 'assistant')
    assert.equal(msgs[1].content, 'Hi there!')
  })

  it('3. messages() — returns message array', async () => {
    const mem = createMemory()
    await mem.add('user', 'Test')
    const msgs = mem.messages()
    assert.ok(Array.isArray(msgs))
    assert.ok(msgs.length >= 1)
    // Without system prompt, messages just contain the user message
    const userMsg = msgs.find(m => m.role === 'user')
    assert.ok(userMsg)
    assert.equal(userMsg.content, 'Test')
  })

  it('4. history() — returns messages without system prompt; messages() includes system', async () => {
    const mem = createMemory({ systemPrompt: 'You are a helpful bot.' })
    await mem.add('user', 'Hello')
    
    const history = mem.history()
    assert.ok(!history.some(m => m.role === 'system'), 'history should not have system message')
    assert.equal(history.length, 1)
    
    const messages = mem.messages()
    assert.ok(messages.some(m => m.role === 'system'), 'messages() should include system prompt')
    assert.equal(messages[0].content, 'You are a helpful bot.')
  })

  it('5. info() — returns turns/tokens/messageCount', async () => {
    const mem = createMemory()
    await mem.add('user', 'Hello')
    await mem.add('assistant', 'World')
    
    const info = mem.info()
    assert.equal(typeof info.turns, 'number')
    assert.equal(info.turns, 1, 'only user messages count as turns')
    assert.equal(typeof info.tokens, 'number')
    assert.ok(info.tokens > 0)
    assert.equal(info.messageCount, 2)
  })

  it('6. trim — auto-trims when exceeding maxTokens', async () => {
    const mem = createMemory({ maxTokens: 50 })
    // Add many messages to exceed the token budget
    for (let i = 0; i < 30; i++) {
      await mem.add('user', `This is a longer message number ${i} with some extra content to fill tokens`)
      await mem.add('assistant', `Response to message ${i} with some additional details and information`)
    }
    const info = mem.info()
    assert.ok(info.tokens <= 50 || info.messageCount <= 2,
      'should have trimmed messages to fit within maxTokens (or kept minimum 2)')
  })

  it('7. clear() — clears all messages', async () => {
    const mem = createMemory()
    await mem.add('user', 'Hello')
    await mem.add('assistant', 'World')
    mem.clear()
    const info = mem.info()
    assert.equal(info.messageCount, 0)
    assert.equal(info.turns, 0)
  })

  // ── createKnowledgeStore ──

  it('8. createKnowledgeStore — creates an instance', () => {
    const ks = createKnowledgeStore()
    assert.ok(ks)
    assert.equal(typeof ks.add, 'function')
    assert.equal(typeof ks.search, 'function')
    assert.equal(typeof ks.remove, 'function')
  })

  it('9. learn(id, text) — stores a document', async () => {
    const mem = createMemory({ knowledge: true })
    await mem.learn('doc-1', 'Quantum computing uses qubits for parallel computation')
    const ki = mem.knowledgeInfo()
    assert.equal(ki.size, 1)
    assert.ok(ki.ids.includes('doc-1'))
  })

  it('10. recall(query) — retrieves relevant documents', async () => {
    const mem = createMemory({ knowledge: true })
    await mem.learn('doc-1', 'Quantum computing uses qubits for parallel computation')
    await mem.learn('doc-2', 'Classical music evolved through the Baroque and Romantic periods')
    
    const results = await mem.recall('How do qubits work?')
    assert.ok(Array.isArray(results))
    assert.ok(results.length > 0)
    // The quantum doc should rank higher
    assert.equal(results[0].id, 'doc-1')
    assert.ok(results[0].score > 0)
  })

  it('11. forget(id) — deletes a document', async () => {
    const mem = createMemory({ knowledge: true })
    await mem.learn('doc-1', 'First document')
    await mem.learn('doc-2', 'Second document')
    
    await mem.forget('doc-1')
    const ki = mem.knowledgeInfo()
    assert.equal(ki.size, 1)
    assert.ok(!ki.ids.includes('doc-1'))
    assert.ok(ki.ids.includes('doc-2'))
  })

  // ── Utility functions ──

  it('12. estimateTokens — estimates token count', () => {
    const tokens = estimateTokens('Hello world')
    assert.equal(typeof tokens, 'number')
    assert.ok(tokens > 0)
    
    // Chinese text should estimate differently
    const cnTokens = estimateTokens('你好世界')
    assert.ok(cnTokens > 0)
    
    // Empty string
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(null), 0)
  })

  it('13. chunkText — splits text into chunks', () => {
    const longText = Array(20).fill('This is a sentence that should be chunked.').join('\n\n')
    const chunks = chunkText(longText, { maxChunkSize: 100 })
    assert.ok(Array.isArray(chunks))
    assert.ok(chunks.length > 1, 'should produce multiple chunks')
    // Each chunk should be within the limit (approximately)
    for (const chunk of chunks) {
      assert.ok(chunk.length > 0, 'chunk should not be empty')
    }
    
    // Short text returns single chunk
    const shortChunks = chunkText('short text')
    assert.equal(shortChunks.length, 1)
    assert.equal(shortChunks[0], 'short text')
  })

  it('14. cosineSimilarity — calculates correctly', () => {
    // Identical vectors = 1
    const sim1 = cosineSimilarity([1, 0, 0], [1, 0, 0])
    assert.ok(Math.abs(sim1 - 1) < 0.001)
    
    // Orthogonal vectors = 0
    const sim2 = cosineSimilarity([1, 0, 0], [0, 1, 0])
    assert.ok(Math.abs(sim2) < 0.001)
    
    // Opposite vectors = -1
    const sim3 = cosineSimilarity([1, 0], [-1, 0])
    assert.ok(Math.abs(sim3 - (-1)) < 0.001)
    
    // Zero vector = 0
    const sim4 = cosineSimilarity([0, 0], [1, 1])
    assert.equal(sim4, 0)
  })

  it('15. localEmbed — returns vectors', () => {
    const texts = ['Hello world', 'Goodbye world', 'Quantum computing']
    const embeddings = localEmbed(texts)
    
    assert.ok(Array.isArray(embeddings))
    assert.equal(embeddings.length, 3)
    
    for (const emb of embeddings) {
      assert.ok(Array.isArray(emb) || emb instanceof Float32Array)
      assert.ok(emb.length > 0, 'embedding should have dimensions')
    }
    
    // Similar texts should have higher similarity than dissimilar
    const sim_similar = cosineSimilarity(embeddings[0], embeddings[1])
    const sim_different = cosineSimilarity(embeddings[0], embeddings[2])
    // "Hello world" and "Goodbye world" share "world" — should be more similar
    assert.ok(sim_similar > sim_different,
      `similar texts should have higher similarity: ${sim_similar} vs ${sim_different}`)
  })
})
