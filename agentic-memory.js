/**
 * agentic-memory — AI memory: conversation context + knowledge retrieval
 * Zero dependencies. Short-term chat + long-term knowledge in one library.
 *
 * Usage:
 *   import { createMemory } from 'agentic-memory'
 *
 *   // Short-term: conversation context
 *   const mem = createMemory({ maxTokens: 8000 })
 *   mem.add('user', 'Hello')
 *   mem.add('assistant', 'Hi!')
 *   mem.messages()  // ready for LLM API
 *
 *   // Long-term: knowledge retrieval
 *   const mem = createMemory({ knowledge: true })
 *   await mem.learn('doc-1', 'Quantum computing uses qubits...')
 *   const results = await mem.recall('How do qubits work?')
 *   // → [{ id: 'doc-1', chunk: '...', score: 0.87 }]
 *
 *   // Both together
 *   const mem = createMemory({ maxTokens: 8000, knowledge: true })
 *   await mem.learn('docs', longDocument)
 *   mem.user('What does this doc say about X?')
 *   const context = await mem.recall('X')
 *   // Feed context + history to your LLM
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else if (typeof define === 'function' && define.amd) define(factory)
  else root.AgenticMemory = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  // ── Token estimation ─────────────────────────────────────────────

  function estimateTokens(text) {
    if (!text) return 0
    let tokens = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0x4E00 && code <= 0x9FFF ||
          code >= 0x3400 && code <= 0x4DBF ||
          code >= 0xF900 && code <= 0xFAFF ||
          code >= 0x3000 && code <= 0x303F ||
          code >= 0xFF00 && code <= 0xFFEF) {
        tokens += 0.5
      } else {
        tokens += 0.25
      }
    }
    return Math.ceil(tokens)
  }

  function estimateMessagesTokens(messages) {
    let total = 0
    for (const msg of messages) {
      total += 4
      total += estimateTokens(msg.content)
      if (msg.name) total += estimateTokens(msg.name)
    }
    total += 2
    return total
  }

  // ── Summarizer ───────────────────────────────────────────────────

  function defaultSummarize(messages) {
    const lines = []
    for (const msg of messages) {
      const first = msg.content.split('\n')[0].slice(0, 120)
      const role = msg.role === 'user' ? 'User' : 'Assistant'
      lines.push(`${role}: ${first}`)
    }
    return `[Previous conversation summary]\n${lines.join('\n')}`
  }

  // ── Storage adapters ─────────────────────────────────────────────

  const storageAdapters = {
    localStorage(key) {
      return {
        save(data) {
          try { localStorage.setItem(key, JSON.stringify(data)) }
          catch (e) { /* quota exceeded */ }
        },
        load() {
          try {
            const raw = localStorage.getItem(key)
            return raw ? JSON.parse(raw) : null
          } catch { return null }
        },
        clear() {
          try { localStorage.removeItem(key) } catch {}
        }
      }
    },

    memory() {
      let store = null
      return {
        save(data) { store = JSON.parse(JSON.stringify(data)) },
        load() { return store ? JSON.parse(JSON.stringify(store)) : null },
        clear() { store = null }
      }
    },

    file(filepath) {
      return {
        save(data) {
          try {
            const fs = require('fs')
            const dir = require('path').dirname(filepath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(filepath, JSON.stringify(data, null, 2))
          } catch {}
        },
        load() {
          try {
            const fs = require('fs')
            if (!fs.existsSync(filepath)) return null
            return JSON.parse(fs.readFileSync(filepath, 'utf8'))
          } catch { return null }
        },
        clear() {
          try { require('fs').unlinkSync(filepath) } catch {}
        }
      }
    }
  }

  // ── Knowledge layer (vector search) ──────────────────────────────

  function chunkText(text, options = {}) {
    const { maxChunkSize = 500, overlap = 50, separator = null } = options
    if (!text || text.length <= maxChunkSize) return [text]

    const chunks = []

    if (separator) {
      const parts = typeof separator === 'string' ? text.split(separator) : text.split(separator)
      let current = ''
      for (const part of parts) {
        if (current.length + part.length > maxChunkSize && current.length > 0) {
          chunks.push(current.trim())
          current = current.slice(-overlap) + part
        } else {
          current += (current ? (typeof separator === 'string' ? separator : '\n') : '') + part
        }
      }
      if (current.trim()) chunks.push(current.trim())
      return chunks
    }

    const paragraphs = text.split(/\n\n+/)
    let current = ''
    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxChunkSize && current.length > 0) {
        chunks.push(current.trim())
        current = current.slice(-overlap)
      }
      current += (current ? '\n\n' : '') + para
    }
    if (current.trim()) chunks.push(current.trim())

    const result = []
    for (const chunk of chunks) {
      if (chunk.length <= maxChunkSize) { result.push(chunk); continue }
      const sentences = chunk.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [chunk]
      let cur = ''
      for (const sent of sentences) {
        if (cur.length + sent.length > maxChunkSize && cur.length > 0) {
          result.push(cur.trim())
          cur = cur.slice(-overlap)
        }
        cur += sent
      }
      if (cur.trim()) result.push(cur.trim())
    }
    return result
  }

  function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      magA += a[i] * a[i]
      magB += b[i] * b[i]
    }
    magA = Math.sqrt(magA)
    magB = Math.sqrt(magB)
    if (magA === 0 || magB === 0) return 0
    return dot / (magA * magB)
  }

  function localEmbed(texts, vocabSize = 512) {
    const vocab = new Map()
    const allTokens = texts.map(t => tokenize(t))

    for (const tokens of allTokens) {
      for (const token of tokens) {
        if (!vocab.has(token)) vocab.set(token, vocab.size % vocabSize)
      }
    }

    const df = new Float32Array(vocabSize)
    for (const tokens of allTokens) {
      const seen = new Set()
      for (const token of tokens) {
        const idx = vocab.get(token) ?? (hashStr(token) % vocabSize)
        if (!seen.has(idx)) { df[idx]++; seen.add(idx) }
      }
    }

    return allTokens.map(tokens => {
      const vec = new Float32Array(vocabSize)
      const tf = new Map()
      for (const token of tokens) {
        const idx = vocab.get(token) ?? (hashStr(token) % vocabSize)
        tf.set(idx, (tf.get(idx) || 0) + 1)
      }
      for (const [idx, count] of tf) {
        const idf = Math.log((texts.length + 1) / (df[idx] + 1)) + 1
        vec[idx] = (count / tokens.length) * idf
      }
      let mag = 0
      for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i]
      mag = Math.sqrt(mag)
      if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag
      return Array.from(vec)
    })
  }

  function tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  }

  function hashStr(s) {
    let h = 0
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0
    }
    return Math.abs(h)
  }

  async function fetchWithRetry(url, options, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, options)
        if (res.status === 429) {
          const wait = parseInt(res.headers.get('retry-after') || '2') * 1000
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`Embedding API error ${res.status}: ${body.slice(0, 200)}`)
        }
        return res
      } catch (err) {
        if (i === retries) throw err
        await new Promise(r => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }

  const embedProviders = {
    async openai(texts, config) {
      const baseUrl = config.baseUrl || 'https://api.openai.com/v1'
      const model = config.model || 'text-embedding-3-small'
      const res = await fetchWithRetry(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      })
      const data = await res.json()
      return data.data.map(d => d.embedding)
    },
  }

  function createKnowledgeStore(options = {}) {
    const {
      provider = 'local',
      apiKey = null,
      baseUrl = null,
      model = null,
      chunkOptions = {},
      batchSize = 100,
    } = options

    const config = { apiKey, baseUrl, model }
    let entries = []
    let needsReembed = false

    async function embed(texts) {
      if (provider === 'local') return localEmbed(texts)
      const embedFn = embedProviders[provider] || embedProviders.openai
      const all = []
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const embeddings = await embedFn(batch, config)
        all.push(...embeddings)
      }
      return all
    }

    return {
      async add(id, text, metadata = {}) {
        const chunks = chunkText(text, chunkOptions)
        const embeddings = await embed(chunks)
        for (let i = 0; i < chunks.length; i++) {
          entries.push({
            id, text, chunk: chunks[i], chunkIndex: i,
            totalChunks: chunks.length, embedding: embeddings[i], metadata,
          })
        }
        if (provider === 'local') needsReembed = true
        return this
      },

      async search(query, searchOptions = {}) {
        const { topK = 5, threshold = 0, filter = null, dedupe = true } = searchOptions
        if (entries.length === 0) return []

        if (provider === 'local' && needsReembed) {
          const allTexts = entries.map(e => e.chunk)
          allTexts.push(query)
          const allEmbeddings = localEmbed(allTexts)
          for (let i = 0; i < entries.length; i++) {
            entries[i].embedding = allEmbeddings[i]
          }
          const queryEmbedding = allEmbeddings[allEmbeddings.length - 1]
          needsReembed = false
          return rankResults(entries, queryEmbedding, { topK, threshold, filter, dedupe })
        }

        const [queryEmbedding] = await embed([query])
        return rankResults(entries, queryEmbedding, { topK, threshold, filter, dedupe })
      },

      remove(id) {
        entries = entries.filter(e => e.id !== id)
        if (provider === 'local') needsReembed = true
        return this
      },

      ids() { return [...new Set(entries.map(e => e.id))] },
      get size() { return new Set(entries.map(e => e.id)).size },
      get chunkCount() { return entries.length },
      clear() { entries = []; return this },

      export() { return { entries: entries.map(e => ({ ...e })), provider, model: config.model } },
      import(data) { entries = (data.entries || []).map(e => ({ ...e })); return this },
    }
  }

  function rankResults(entries, queryEmbedding, { topK, threshold, filter, dedupe }) {
    let scored = entries.map(entry => ({
      ...entry, score: cosineSimilarity(queryEmbedding, entry.embedding),
    }))
    if (filter) scored = scored.filter(filter)
    if (threshold > 0) scored = scored.filter(s => s.score >= threshold)
    scored.sort((a, b) => b.score - a.score)
    if (dedupe) {
      const seen = new Set()
      scored = scored.filter(s => {
        if (seen.has(s.id)) return false
        seen.add(s.id); return true
      })
    }
    return scored.slice(0, topK).map(s => ({
      id: s.id, chunk: s.chunk, score: Math.round(s.score * 1000) / 1000,
      chunkIndex: s.chunkIndex, totalChunks: s.totalChunks, metadata: s.metadata,
    }))
  }

  // ── Core: createMemory ───────────────────────────────────────────

  function createMemory(options = {}) {
    const {
      maxTokens = 8000,
      maxMessages = 100,
      systemPrompt = null,
      trimStrategy = 'sliding',
      summarize = null,
      storage = null,
      id = null,
      // Knowledge layer options
      knowledge = false,
      embedProvider = 'local',
      embedApiKey = null,
      embedBaseUrl = null,
      embedModel = null,
      chunkOptions = {},
    } = options

    // Resolve storage adapter
    let store = null
    if (storage) {
      if (typeof storage === 'string') {
        if (storage.startsWith('localStorage:')) {
          store = storageAdapters.localStorage(storage.slice(13))
        } else if (storage.startsWith('file:')) {
          store = storageAdapters.file(storage.slice(5))
        }
      } else if (typeof storage === 'object' && storage.save && storage.load) {
        store = storage
      }
    }

    let _messages = []
    let _summary = null
    let _metadata = { id: id || generateId(), created: Date.now(), turns: 0 }
    let _systemPrompt = systemPrompt

    // Initialize knowledge store if enabled
    const _knowledge = knowledge
      ? createKnowledgeStore({
          provider: embedProvider,
          apiKey: embedApiKey,
          baseUrl: embedBaseUrl,
          model: embedModel,
          chunkOptions,
        })
      : null

    // Load from storage
    if (store) {
      const saved = store.load()
      if (saved) {
        _messages = saved.messages || []
        _summary = saved.summary || null
        _metadata = { ..._metadata, ...saved.metadata }
        if (saved.knowledge && _knowledge) _knowledge.import(saved.knowledge)
      }
    }

    function _save() {
      if (store) {
        const data = { messages: _messages, summary: _summary, metadata: _metadata }
        if (_knowledge) data.knowledge = _knowledge.export()
        store.save(data)
      }
    }

    function _systemTokens() {
      if (!_systemPrompt) return 0
      return 4 + estimateTokens(_systemPrompt)
    }

    function _currentTokens() {
      let total = _systemTokens()
      if (_summary) total += 4 + estimateTokens(_summary)
      total += estimateMessagesTokens(_messages)
      return total
    }

    async function _trim() {
      const budget = maxTokens
      if (_currentTokens() <= budget && _messages.length <= maxMessages) return

      if (trimStrategy === 'summarize') {
        const summarizer = summarize || defaultSummarize
        const half = Math.max(Math.floor(_messages.length / 2), 1)
        const toSummarize = _messages.slice(0, half)
        const summaryText = await Promise.resolve(summarizer(toSummarize))
        _summary = _summary ? _summary + '\n\n' + summaryText : summaryText
        _messages = _messages.slice(half)

        if (_currentTokens() > budget) {
          const maxSummaryTokens = Math.floor(budget * 0.2)
          const summaryChars = maxSummaryTokens * 4
          if (_summary.length > summaryChars) _summary = _summary.slice(-summaryChars)
        }
      } else {
        while (_currentTokens() > budget || _messages.length > maxMessages) {
          if (_messages.length <= 2) break
          if (_messages[0].role === 'user' && _messages.length > 1 && _messages[1].role === 'assistant') {
            _messages.splice(0, 2)
          } else {
            _messages.splice(0, 1)
          }
        }
      }
    }

    const instance = {
      /** Add a message */
      async add(role, content) {
        _messages.push({ role, content })
        if (role === 'user') _metadata.turns++
        await _trim()
        _save()
        return this
      },

      async user(content) { return this.add('user', content) },
      async assistant(content) { return this.add('assistant', content) },

      /** Get messages array (ready for LLM API) */
      messages() {
        const result = []
        if (_systemPrompt) {
          let sys = _systemPrompt
          if (_summary) sys += '\n\n' + _summary
          result.push({ role: 'system', content: sys })
        } else if (_summary) {
          result.push({ role: 'system', content: _summary })
        }
        result.push(..._messages.map(m => ({ role: m.role, content: m.content })))
        return result
      },

      /** Get messages without system prompt */
      history() {
        return _messages.map(m => ({ role: m.role, content: m.content }))
      },

      last(n = 1) { return _messages.slice(-n).map(m => ({ ...m })) },

      lastAnswer() {
        for (let i = _messages.length - 1; i >= 0; i--) {
          if (_messages[i].role === 'assistant') return _messages[i].content
        }
        return null
      },

      tokens() { return _currentTokens() },

      info() {
        return {
          id: _metadata.id, turns: _metadata.turns,
          messageCount: _messages.length, tokens: _currentTokens(),
          maxTokens, hasSummary: !!_summary, summary: _summary,
          created: _metadata.created, hasKnowledge: !!_knowledge,
          knowledgeSize: _knowledge ? _knowledge.size : 0,
        }
      },

      setSystem(prompt) {
        _systemPrompt = prompt
        _save()
        return this
      },

      clear() {
        _messages = []
        _summary = null
        _metadata.turns = 0
        _save()
        return this
      },

      fork(newOptions = {}) {
        const forked = createMemory({
          maxTokens, maxMessages, systemPrompt: _systemPrompt,
          trimStrategy, summarize, ...newOptions, id: generateId(),
        })
        for (const msg of _messages) forked.add(msg.role, msg.content)
        return forked
      },

      export() {
        const data = {
          messages: _messages.map(m => ({ ...m })),
          summary: _summary, metadata: { ..._metadata },
        }
        if (_knowledge) data.knowledge = _knowledge.export()
        return data
      },

      import(data) {
        _messages = (data.messages || []).map(m => ({ ...m }))
        _summary = data.summary || null
        if (data.metadata) _metadata = { ..._metadata, ...data.metadata }
        if (data.knowledge && _knowledge) _knowledge.import(data.knowledge)
        _save()
        return this
      },

      destroy() {
        _messages = []
        _summary = null
        if (_knowledge) _knowledge.clear()
        if (store) store.clear()
      },

      // ── Knowledge API ──────────────────────────────────────────

      /** Learn — add knowledge (requires knowledge: true) */
      async learn(id, text, metadata = {}) {
        if (!_knowledge) throw new Error('Knowledge not enabled. Use createMemory({ knowledge: true })')
        await _knowledge.add(id, text, metadata)
        _save()
        return this
      },

      /** Recall — search knowledge (requires knowledge: true) */
      async recall(query, options = {}) {
        if (!_knowledge) throw new Error('Knowledge not enabled. Use createMemory({ knowledge: true })')
        return _knowledge.search(query, options)
      },

      /** Forget — remove knowledge by ID */
      async forget(id) {
        if (!_knowledge) throw new Error('Knowledge not enabled. Use createMemory({ knowledge: true })')
        _knowledge.remove(id)
        _save()
        return this
      },

      /** Get knowledge store info */
      knowledgeInfo() {
        if (!_knowledge) return null
        return { size: _knowledge.size, chunks: _knowledge.chunkCount, ids: _knowledge.ids() }
      },
    }

    return instance
  }

  // ── Multi-conversation manager ──────────────────────────────────

  function createManager(options = {}) {
    const { storagePrefix = 'agentic-memory', defaultOptions = {} } = options
    const conversations = new Map()

    return {
      get(id, opts = {}) {
        if (conversations.has(id)) return conversations.get(id)
        const mem = createMemory({
          ...defaultOptions, ...opts, id,
          storage: opts.storage || `localStorage:${storagePrefix}:${id}`,
        })
        conversations.set(id, mem)
        return mem
      },
      list() { return [...conversations.keys()] },
      delete(id) {
        const mem = conversations.get(id)
        if (mem) { mem.destroy(); conversations.delete(id) }
      },
      clear() {
        for (const [, mem] of conversations) mem.destroy()
        conversations.clear()
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  return {
    createMemory,
    createManager,
    createKnowledgeStore,
    estimateTokens,
    estimateMessagesTokens,
    storageAdapters,
    // Embed utilities
    chunkText,
    cosineSimilarity,
    localEmbed,
  }
})
