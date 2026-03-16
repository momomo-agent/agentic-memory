# ⚡ agentic-memory

Conversation memory for AI. Multi-turn context management with auto-trimming and persistence.

Zero dependencies. Works with [agentic-lite](https://github.com/momomo-agent/agentic-lite) or any LLM API.

## Why

Every AI chat app needs to:
1. Track conversation history
2. Stay within token limits
3. Not lose context when the window overflows

LangChain gives you 5 Memory classes, 3 buffer strategies, and a PhD in abstractions. agentic-memory gives you `createMemory()`.

## Install

```bash
npm install agentic-memory
```

Or:

```html
<script src="https://unpkg.com/agentic-memory/memory.js"></script>
```

## Quick Start

```js
import { createMemory } from 'agentic-memory'

const mem = createMemory({
  maxTokens: 8000,
  systemPrompt: 'You are a helpful assistant.',
})

// Add messages
await mem.user('What is quantum computing?')
await mem.assistant('Quantum computing uses qubits...')
await mem.user('How does entanglement work?')

// Get messages array — ready for any LLM API
mem.messages()
// → [
//   { role: 'system', content: 'You are a helpful assistant.' },
//   { role: 'user', content: 'What is quantum computing?' },
//   { role: 'assistant', content: 'Quantum computing uses qubits...' },
//   { role: 'user', content: 'How does entanglement work?' },
// ]
```

## With agentic-lite

```js
import { ask } from 'agentic-lite'
import { createMemory } from 'agentic-memory'

const mem = createMemory({ maxTokens: 8000 })

async function chat(prompt) {
  await mem.user(prompt)

  const result = await ask(prompt, {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    history: mem.history(),
  })

  await mem.assistant(result.answer)
  return result.answer
}

await chat('What is quantum computing?')
await chat('How does it relate to cryptography?')  // has context!
```

## Auto-Trimming

When the conversation exceeds `maxTokens`, agentic-memory trims automatically.

### Sliding Window (default)

Drops oldest message pairs to stay within budget:

```js
const mem = createMemory({
  maxTokens: 4000,
  trimStrategy: 'sliding',  // default
})
```

### Summarize

Summarizes older messages instead of dropping them:

```js
const mem = createMemory({
  maxTokens: 4000,
  trimStrategy: 'summarize',
})
```

With a custom summarizer (e.g., use an LLM):

```js
const mem = createMemory({
  maxTokens: 4000,
  trimStrategy: 'summarize',
  summarize: async (messages) => {
    const result = await ask(
      `Summarize this conversation concisely:\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}`,
      { apiKey: '...' }
    )
    return result.answer
  },
})
```

## Persistence

```js
// Browser — localStorage
const mem = createMemory({
  storage: 'localStorage:my-chat',
})

// Node.js — file
const mem = createMemory({
  storage: 'file:./conversations/chat-1.json',
})

// Custom adapter
const mem = createMemory({
  storage: {
    save(data) { db.put('chat', data) },
    load() { return db.get('chat') },
    clear() { db.delete('chat') },
  },
})
```

## API

### `createMemory(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxTokens` | `number` | `8000` | Token budget for context window |
| `maxMessages` | `number` | `100` | Hard cap on message count |
| `systemPrompt` | `string` | `null` | System prompt (always retained) |
| `trimStrategy` | `string` | `'sliding'` | `'sliding'` or `'summarize'` |
| `summarize` | `function` | built-in | Custom `(messages) => string` |
| `storage` | `string\|object` | `null` | Persistence adapter |
| `id` | `string` | auto | Conversation ID |

### Instance Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `mem.user(text)` | `Promise` | Add user message |
| `mem.assistant(text)` | `Promise` | Add assistant message |
| `mem.add(role, text)` | `Promise` | Add any role |
| `mem.messages()` | `Message[]` | Full messages array (with system prompt) |
| `mem.history()` | `Message[]` | Messages without system prompt |
| `mem.last(n)` | `Message[]` | Last N messages |
| `mem.lastAnswer()` | `string` | Last assistant response |
| `mem.tokens()` | `number` | Current token estimate |
| `mem.info()` | `object` | Conversation metadata |
| `mem.fork()` | `Memory` | Branch the conversation |
| `mem.clear()` | `this` | Reset messages |
| `mem.export()` | `object` | Serialize state |
| `mem.import(data)` | `this` | Restore state |
| `mem.destroy()` | `void` | Clear everything + storage |

### `createManager(options?)`

Manage multiple conversations:

```js
import { createManager } from 'agentic-memory'

const mgr = createManager()
const chat1 = mgr.get('user-123')
const chat2 = mgr.get('user-456')

mgr.list()          // ['user-123', 'user-456']
mgr.delete('user-123')
```

### `estimateTokens(text)`

Quick token count estimate (~90% accurate, no external deps):

```js
import { estimateTokens } from 'agentic-memory'

estimateTokens('Hello world')     // → 3
estimateTokens('你好世界')         // → 3 (CJK-aware)
```

## Size

~13KB raw, ~4KB gzip. Zero dependencies.

## License

MIT
