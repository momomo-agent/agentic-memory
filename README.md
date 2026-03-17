# agentic-memory

AI memory — conversation context + knowledge retrieval. Zero dependencies.

Part of the [agentic](https://momomo-agent.github.io/agentic/) family.

## Install

```html
<script src="https://unpkg.com/agentic-memory/memory.js"></script>
```

```bash
npm install agentic-memory
```

## Short-term: Conversation Context

```js
const { createMemory } = AgenticMemory

const mem = createMemory({ maxTokens: 8000 })

await mem.user('What is quantum computing?')
await mem.assistant('Quantum computing uses qubits...')

// Ready for LLM API
const messages = mem.messages()

// Just the conversation (no system prompt)
const history = mem.history()
```

Auto-trims when context exceeds `maxTokens`. Supports sliding window and summarize strategies.

## Long-term: Knowledge Retrieval

```js
const mem = createMemory({ knowledge: true })

// Learn — add documents to knowledge base
await mem.learn('physics', 'Quantum computing uses qubits to perform calculations...')
await mem.learn('ml', 'Neural networks are inspired by the human brain...')

// Recall — semantic search
const results = await mem.recall('How do quantum computers work?')
// → [{ id: 'physics', chunk: '...', score: 0.87 }]

// Forget — remove from knowledge base
await mem.forget('physics')
```

Uses local TF-IDF by default (zero config). Supports OpenAI embeddings for production:

```js
const mem = createMemory({
  knowledge: true,
  embedProvider: 'openai',
  embedApiKey: 'sk-...',
})
```

## Both Together

```js
const mem = createMemory({
  maxTokens: 8000,
  knowledge: true,
  systemPrompt: 'You are a helpful assistant.',
})

// Build knowledge base
await mem.learn('docs', longDocument)

// Conversation with context
await mem.user('What does the doc say about X?')
const context = await mem.recall('X')

// Feed to LLM with both history and relevant knowledge
```

## Persistence

```js
// Browser — localStorage
const mem = createMemory({ storage: 'localStorage:my-chat' })

// Node.js — file
const mem = createMemory({ storage: 'file:./memory.json' })

// Custom adapter
const mem = createMemory({
  storage: { save(data) { ... }, load() { ... }, clear() { ... } }
})
```

## Multi-conversation

```js
const { createManager } = AgenticMemory

const mgr = createManager()
const chat1 = mgr.get('user-alice')
const chat2 = mgr.get('user-bob')
// Each has independent history and storage
```

## API

### createMemory(options)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| maxTokens | number | 8000 | Max tokens for context window |
| maxMessages | number | 100 | Hard cap on message count |
| systemPrompt | string | null | System prompt (always kept) |
| trimStrategy | string | 'sliding' | 'sliding' or 'summarize' |
| storage | string/object | null | Persistence adapter |
| knowledge | boolean | false | Enable knowledge layer |
| embedProvider | string | 'local' | 'local' or 'openai' |
| embedApiKey | string | null | API key for embeddings |

### Memory Instance

| Method | Description |
|--------|-------------|
| `user(text)` | Add user message |
| `assistant(text)` | Add assistant message |
| `messages()` | Get messages array for LLM API |
| `history()` | Get messages without system prompt |
| `learn(id, text)` | Add knowledge (requires `knowledge: true`) |
| `recall(query)` | Search knowledge semantically |
| `forget(id)` | Remove knowledge by ID |
| `tokens()` | Current token estimate |
| `info()` | Conversation metadata |
| `clear()` | Clear messages |
| `export()` / `import()` | Serialize/deserialize state |

## Size

~4KB gzip (conversation + knowledge combined)

## License

MIT
