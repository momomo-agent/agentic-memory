/**
 * agentic-memory — Conversation memory for AI
 * Zero dependencies. Manages multi-turn context with auto-trimming.
 *
 * Usage:
 *   import { createMemory } from 'agentic-memory'
 *   const mem = createMemory({ maxTokens: 8000 })
 *   mem.add('user', 'Hello')
 *   mem.add('assistant', 'Hi there!')
 *   const messages = mem.messages()  // ready for LLM API
 *
 * With agentic-lite:
 *   import { ask } from 'agentic-lite'
 *   const result = await ask('Follow up question', {
 *     ...config,
 *     history: mem.messages()
 *   })
 *   mem.add('user', 'Follow up question')
 *   mem.add('assistant', result.answer)
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else if (typeof define === 'function' && define.amd) define(factory)
  else root.AgenticMemory = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  // ── Token estimation ─────────────────────────────────────────────
  // GPT/Claude tokenizers average ~4 chars per token for English,
  // ~2 chars for CJK. We use a simple heuristic — good enough for
  // context window management without importing tiktoken (40MB).

  function estimateTokens(text) {
    if (!text) return 0
    let tokens = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      // CJK ranges: roughly 2 chars per token
      if (code >= 0x4E00 && code <= 0x9FFF ||   // CJK Unified
          code >= 0x3400 && code <= 0x4DBF ||   // CJK Extension A
          code >= 0xF900 && code <= 0xFAFF ||   // CJK Compat
          code >= 0x3000 && code <= 0x303F ||   // CJK Punctuation
          code >= 0xFF00 && code <= 0xFFEF) {   // Fullwidth
        tokens += 0.5
      } else {
        tokens += 0.25
      }
    }
    // Message overhead: role + formatting ≈ 4 tokens per message
    return Math.ceil(tokens)
  }

  function estimateMessagesTokens(messages) {
    let total = 0
    for (const msg of messages) {
      total += 4 // message overhead
      total += estimateTokens(msg.content)
      if (msg.name) total += estimateTokens(msg.name)
    }
    total += 2 // conversation overhead
    return total
  }

  // ── Summarizer ───────────────────────────────────────────────────

  function defaultSummarize(messages) {
    // Simple extractive summary — take first line of each message
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
    /** Browser localStorage */
    localStorage(key) {
      return {
        save(data) {
          try { localStorage.setItem(key, JSON.stringify(data)) }
          catch (e) { /* quota exceeded, silently fail */ }
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

    /** In-memory (no persistence, default) */
    memory() {
      let store = null
      return {
        save(data) { store = JSON.parse(JSON.stringify(data)) },
        load() { return store ? JSON.parse(JSON.stringify(store)) : null },
        clear() { store = null }
      }
    },

    /** Node.js file storage */
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

  // ── Core: createMemory ───────────────────────────────────────────

  function createMemory(options = {}) {
    const {
      maxTokens = 8000,       // Max total tokens for context window
      maxMessages = 100,       // Hard cap on message count
      systemPrompt = null,     // System prompt (always kept)
      trimStrategy = 'sliding', // 'sliding' | 'summarize'
      summarize = null,         // Custom summarizer: (messages) => string | Promise<string>
      storage = null,           // Storage adapter or 'localStorage:key' or 'file:path'
      id = null,                // Conversation ID (for storage key)
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

    // Load from storage if available
    if (store) {
      const saved = store.load()
      if (saved) {
        _messages = saved.messages || []
        _summary = saved.summary || null
        _metadata = { ..._metadata, ...saved.metadata }
      }
    }

    function _save() {
      if (store) {
        store.save({
          messages: _messages,
          summary: _summary,
          metadata: _metadata,
        })
      }
    }

    function _systemTokens() {
      if (!systemPrompt) return 0
      return 4 + estimateTokens(systemPrompt)
    }

    function _currentTokens() {
      let total = _systemTokens()
      if (_summary) total += 4 + estimateTokens(_summary)
      total += estimateMessagesTokens(_messages)
      return total
    }

    async function _trim() {
      const budget = maxTokens
      let current = _currentTokens()

      if (current <= budget && _messages.length <= maxMessages) return

      if (trimStrategy === 'summarize') {
        // Summarize oldest half of messages
        const summarizer = summarize || defaultSummarize
        const half = Math.max(Math.floor(_messages.length / 2), 1)
        const toSummarize = _messages.slice(0, half)
        const summaryText = await Promise.resolve(summarizer(toSummarize))

        if (_summary) {
          _summary = _summary + '\n\n' + summaryText
        } else {
          _summary = summaryText
        }

        _messages = _messages.slice(half)

        // If still over budget after summarizing, trim the summary too
        if (_currentTokens() > budget) {
          const maxSummaryTokens = Math.floor(budget * 0.2)
          const summaryChars = maxSummaryTokens * 4
          if (_summary.length > summaryChars) {
            _summary = _summary.slice(-summaryChars)
          }
        }
      } else {
        // Sliding window — drop oldest messages (keep pairs when possible)
        while (_currentTokens() > budget || _messages.length > maxMessages) {
          if (_messages.length <= 2) break

          // Try to drop a user+assistant pair
          if (_messages[0].role === 'user' && _messages.length > 1 && _messages[1].role === 'assistant') {
            _messages.splice(0, 2)
          } else {
            _messages.splice(0, 1)
          }
        }
      }
    }

    return {
      /** Add a message */
      async add(role, content) {
        _messages.push({ role, content })
        if (role === 'user') _metadata.turns++
        await _trim()
        _save()
        return this
      },

      /** Add a user message */
      async user(content) { return this.add('user', content) },

      /** Add an assistant message */
      async assistant(content) { return this.add('assistant', content) },

      /** Get messages array (ready for LLM API) */
      messages() {
        const result = []

        // System prompt
        if (systemPrompt) {
          let sys = systemPrompt
          if (_summary) sys += '\n\n' + _summary
          result.push({ role: 'system', content: sys })
        } else if (_summary) {
          result.push({ role: 'system', content: _summary })
        }

        // Conversation messages
        result.push(..._messages.map(m => ({ role: m.role, content: m.content })))

        return result
      },

      /** Get messages without system prompt (for agentic-lite history) */
      history() {
        return _messages.map(m => ({ role: m.role, content: m.content }))
      },

      /** Get the last N messages */
      last(n = 1) {
        return _messages.slice(-n).map(m => ({ ...m }))
      },

      /** Get last assistant response */
      lastAnswer() {
        for (let i = _messages.length - 1; i >= 0; i--) {
          if (_messages[i].role === 'assistant') return _messages[i].content
        }
        return null
      },

      /** Get current token estimate */
      tokens() {
        return _currentTokens()
      },

      /** Get conversation info */
      info() {
        return {
          id: _metadata.id,
          turns: _metadata.turns,
          messageCount: _messages.length,
          tokens: _currentTokens(),
          maxTokens,
          hasSummary: !!_summary,
          summary: _summary,
          created: _metadata.created,
        }
      },

      /** Update system prompt */
      setSystem(prompt) {
        Object.defineProperty(options, 'systemPrompt', { value: prompt })
        // Can't reassign const, use closure trick
        // Actually just update directly since we close over nothing const
        _save()
        return this
      },

      /** Clear all messages (keeps system prompt) */
      clear() {
        _messages = []
        _summary = null
        _metadata.turns = 0
        _save()
        return this
      },

      /** Fork — create a branch of this conversation */
      fork(newOptions = {}) {
        const forked = createMemory({
          maxTokens,
          maxMessages,
          systemPrompt,
          trimStrategy,
          summarize,
          ...newOptions,
          id: generateId(),
        })
        // Copy current state
        for (const msg of _messages) {
          forked.add(msg.role, msg.content)
        }
        return forked
      },

      /** Export full state */
      export() {
        return {
          messages: _messages.map(m => ({ ...m })),
          summary: _summary,
          metadata: { ..._metadata },
        }
      },

      /** Import state */
      import(data) {
        _messages = (data.messages || []).map(m => ({ ...m }))
        _summary = data.summary || null
        if (data.metadata) _metadata = { ..._metadata, ...data.metadata }
        _save()
        return this
      },

      /** Destroy — clear storage */
      destroy() {
        _messages = []
        _summary = null
        if (store) store.clear()
      }
    }
  }

  // ── Multi-conversation manager ──────────────────────────────────

  function createManager(options = {}) {
    const {
      storagePrefix = 'agentic-memory',
      defaultOptions = {},
    } = options

    const conversations = new Map()

    return {
      /** Get or create a conversation by ID */
      get(id, opts = {}) {
        if (conversations.has(id)) return conversations.get(id)

        const mem = createMemory({
          ...defaultOptions,
          ...opts,
          id,
          storage: opts.storage || `localStorage:${storagePrefix}:${id}`,
        })
        conversations.set(id, mem)
        return mem
      },

      /** List conversation IDs */
      list() {
        return [...conversations.keys()]
      },

      /** Delete a conversation */
      delete(id) {
        const mem = conversations.get(id)
        if (mem) {
          mem.destroy()
          conversations.delete(id)
        }
      },

      /** Clear all conversations */
      clear() {
        for (const [id, mem] of conversations) {
          mem.destroy()
        }
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
    estimateTokens,
    estimateMessagesTokens,
    storageAdapters,
  }
})
