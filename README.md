# Free Model Aggregator

OpenAI/Anthropic-compatible API server that routes requests to OpenRouter's free models with intelligent failover.

## Features

- **OpenAI Chat Completions API** (`/v1/chat/completions`) - JSON & streaming
- **Anthropic Messages API** (`/v1/messages`) - JSON & streaming  
- **Model Catalog** (`/v1/models`) - Lists all 14 free OpenRouter models
- **Health Check** (`/work`, `/health`) - Grader compatibility
- **Smart Routing** - Picks highest-rated available model
- **Automatic Failover** - Retries on 429/5xx, skips failed models
- **Zero Dependencies** - Pure Node.js 22+ standard library

## Free Models (14)

| Model | Rating | Context |
|-------|--------|---------|
| meta-llama/llama-3.3-70b-instruct:free | 95 | 128K |
| meta-llama/llama-3.1-70b-instruct:free | 93 | 128K |
| qwen/qwen-2.5-72b-instruct:free | 92 | 128K |
| mistralai/mistral-large:free | 88 | 128K |
| qwen/qwen-2.5-32b-instruct:free | 87 | 128K |
| google/gemini-flash-1.5:free | 86 | 1M |
| meta-llama/llama-3.1-8b-instruct:free | 82 | 128K |
| qwen/qwen-2.5-14b-instruct:free | 80 | 128K |
| mistralai/mistral-nemo:free | 78 | 128K |
| google/gemma-2-9b-it:free | 75 | 8K |
| microsoft/phi-3.5-mini-instruct:free | 73 | 128K |
| qwen/qwen-2.5-7b-instruct:free | 70 | 128K |
| meta-llama/llama-3.2-3b-instruct:free | 65 | 128K |
| google/gemma-2-2b-it:free | 60 | 8K |

## Quick Start

```bash
# Set your OpenRouter API key (min 10 credits)
export OPENROUTER_API_KEY="sk-or-v1-..."

# Run server
npm start

# Or development with auto-reload
npm run dev
```

Server starts on `http://localhost:8080` (configurable via `PORT` env).

## API Examples

### OpenAI Chat Completions

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/llama-3.3-70b-instruct:free",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Anthropic Messages

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/llama-3.3-70b-instruct:free",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming (OpenAI)

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/llama-3.3-70b-instruct:free",
    "messages": [{"role": "user", "content": "Count to 10"}],
    "stream": true
  }'
```

### List Models

```bash
curl http://localhost:8080/v1/models
```

### Health Check (Grader)

```bash
curl http://localhost:8080/work
# Returns: {"status": "running"} or {"status": "done"}
```

## Architecture

- **main.ts** - HTTP server with OpenAI/Anthropic endpoints
- **MODELS.ts** - Free model catalog with ratings
- **ModelRouter** - Smart routing + failover logic
- **Zero external deps** - Uses Node.js built-in `fetch`, `http`

## Deployment

Built for make.fun's `agent/v1` harness:
- Entrypoint: `main.ts` (Node 22)
- Requires: `OPENROUTER_API_KEY` env var
- Exposes: `/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/work`
- Deterministic: No randomness, no wall-clock dependencies

## License

MIT
