#!/usr/bin/env node --experimental-strip-types
/**
 * Free Model Aggregator - OpenAI/Anthropic compatible API server
 * Routes requests to OpenRouter free models with intelligent failover
 * 
 * Endpoints:
 * - POST /v1/chat/completions (OpenAI format, JSON + streaming)
 * - POST /v1/messages (Anthropic format, JSON + streaming)
 * - GET /v1/models (lists available free models)
 * - GET /work (health check, exits 0 when done)
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { FREE_MODELS, getModelsByRating, getAllModelIds, type FreeModel } from "./MODELS.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

if (!OPENROUTER_API_KEY) {
  console.error("FATAL: OPENROUTER_API_KEY environment variable required");
  process.exit(1);
}

// ============================================================
// Types
// ============================================================

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  [key: string]: any;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  [key: string]: any;
}

interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window: number;
}

interface RouteDecision {
  model: FreeModel;
  attempt: number;
  reason: string;
}

// ============================================================
// Model Router with Failover Logic
// ============================================================

class ModelRouter {
  private models = getModelsByRating();
  private failureCount = new Map<string, number>();
  private lastFailure = new Map<string, number>();
  private readonly MAX_FAILURES = 2;
  private readonly COOLDOWN_MS = 30_000;

  selectModel(preferredModel?: string): RouteDecision {
    // If specific model requested and it's free, try it first
    if (preferredModel) {
      const requested = FREE_MODELS.find(m => m.id === preferredModel);
      if (requested && this.isAvailable(requested.id)) {
        return { model: requested, attempt: 1, reason: "requested" };
      }
    }

    // Otherwise pick highest-rated available model
    for (const model of this.models) {
      if (this.isAvailable(model.id)) {
        return { model, attempt: 1, reason: "best_available" };
      }
    }

    // Fallback: least recently failed
    const fallback = this.models.reduce((best, m) => {
      const lastFail = this.lastFailure.get(m.id) || 0;
      const bestFail = this.lastFailure.get(best.id) || 0;
      return lastFail < bestFail ? m : best;
    });
    return { model: fallback, attempt: 1, reason: "fallback" };
  }

  private isAvailable(modelId: string): boolean {
    const failures = this.failureCount.get(modelId) || 0;
    if (failures >= this.MAX_FAILURES) {
      const lastFail = this.lastFailure.get(modelId) || 0;
      if (Date.now() - lastFail < this.COOLDOWN_MS) return false;
      // Reset after cooldown
      this.failureCount.set(modelId, 0);
    }
    return true;
  }

  recordSuccess(modelId: string): void {
    this.failureCount.set(modelId, 0);
  }

  recordFailure(modelId: string): void {
    const count = (this.failureCount.get(modelId) || 0) + 1;
    this.failureCount.set(modelId, count);
    this.lastFailure.set(modelId, Date.now());
  }

  getNextModel(exclude: string[]): RouteDecision | null {
    for (const model of this.models) {
      if (!exclude.includes(model.id) && this.isAvailable(model.id)) {
        return { model, attempt: exclude.length + 1, reason: "failover" };
      }
    }
    return null;
  }
}

// ============================================================
// OpenRouter Client
// ============================================================

async function callOpenRouter(
  model: string,
  body: any,
  signal: AbortSignal
): Promise<Response> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://make.fun",
      "X-Title": "make.fun free-model-aggregator",
    },
    body: JSON.stringify({ ...body, model }),
    signal,
  });
  return res;
}

// ============================================================
// Format Conversions
// ============================================================

function openAIToOpenRouter(req: OpenAIRequest): any {
  return {
    messages: req.messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : 
        m.content.map(c => c.type === "text" ? { type: "text", text: c.text } : c).filter(Boolean),
      ...(m.name && { name: m.name }),
      ...(m.tool_calls && { tool_calls: m.tool_calls }),
      ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
    })),
    temperature: req.temperature ?? 0.7,
    max_tokens: req.max_tokens,
    stream: req.stream,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

function anthropicToOpenRouter(req: AnthropicRequest): any {
  const messages = req.messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content :
      m.content.map(c => c.type === "text" ? { type: "text", text: c.text } : c).filter(Boolean),
  }));

  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system :
      req.system.map(s => s.text).join("\n");
    messages.unshift({ role: "system", content: sysContent });
  }

  return {
    messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.max_tokens,
    stream: req.stream,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

function openRouterToOpenAIStream(chunk: any, model: string): string {
  const choice = chunk.choices?.[0];
  if (!choice) return "";
  
  const delta: any = {};
  if (choice.delta?.content) delta.content = choice.delta.content;
  if (choice.delta?.role) delta.role = choice.delta.role;
  if (choice.delta?.tool_calls) delta.tool_calls = choice.delta.tool_calls;
  
  return `data: ${JSON.stringify({
    id: chunk.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: choice.finish_reason }],
  })}\n\n`;
}

function openRouterToAnthropicStream(chunk: any, model: string): string {
  const choice = chunk.choices?.[0];
  if (!choice) return "";
  
  let type: string;
  let delta: any = {};
  
  if (choice.delta?.role === "assistant" && !choice.delta.content) {
    type = "message_start";
    delta = { message: { id: chunk.id || `msg_${Date.now()}`, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
  } else if (choice.delta?.content) {
    type = "content_block_delta";
    delta = { index: 0, delta: { type: "text", text: choice.delta.content } };
  } else if (choice.finish_reason) {
    type = "message_delta";
    delta = { delta: { stop_reason: choice.finish_reason === "length" ? "max_tokens" : "end_turn" }, usage: { output_tokens: chunk.usage?.completion_tokens || 0 } };
  } else {
    return "";
  }
  
  return `event: ${type}\ndata: ${JSON.stringify(delta)}\n\n`;
}

function openRouterToOpenAIResponse(res: any, model: string): any {
  const choice = res.choices?.[0];
  return {
    id: res.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: choice?.message?.role || "assistant",
        content: choice?.message?.content || "",
        tool_calls: choice?.message?.tool_calls,
      },
      finish_reason: choice?.finish_reason || "stop",
    }],
    usage: res.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function openRouterToAnthropicResponse(res: any, model: string): any {
  const choice = res.choices?.[0];
  return {
    id: res.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: choice?.message?.content || "" }],
    model,
    stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 },
  };
}

// ============================================================
// Request Handlers
// ============================================================

const router = new ModelRouter();
let workDone = false;

async function handleOpenAIChat(req: IncomingMessage, res: ServerResponse, body: OpenAIRequest): Promise<void> {
  const stream = body.stream === true;
  const modelId = body.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  
  let tried: string[] = [];
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    const decision = attempt === 1 
      ? router.selectModel(modelId)
      : router.getNextModel(tried);
    
    if (!decision) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "All free models unavailable", type: "service_unavailable" } }));
      return;
    }
    
    const { model } = decision;
    tried.push(model.id);
    
    try {
      const orBody = openAIToOpenRouter(body);
      const orRes = await callOpenRouter(model.id, orBody, controller.signal);
      
      if (!orRes.ok) {
        const errText = await orRes.text();
        let err: any;
        try { err = JSON.parse(errText); } catch { err = { message: errText }; }
        
        // Retry on rate limit / server error
        if (orRes.status === 429 || orRes.status >= 500) {
          router.recordFailure(model.id);
          lastError = new Error(`${orRes.status}: ${err.error?.message || err.message || "Provider error"}`);
          continue;
        }
        
        // Model not allowed / bad request - don't retry same model
        if (orRes.status === 400 || orRes.status === 404) {
          router.recordFailure(model.id);
          lastError = new Error(`${orRes.status}: ${err.error?.message || "Model not available"}`);
          continue;
        }
        
        // Other client errors - return to user
        res.writeHead(orRes.status, { "Content-Type": "application/json" });
        res.end(errText);
        return;
      }
      
      router.recordSuccess(model.id);
      
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        
        const reader = orRes.body?.getReader();
        if (!reader) throw new Error("No response body");
        
        const decoder = new TextDecoder();
        let buffer = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                  res.write("data: [DONE]\n\n");
                  break;
                }
                try {
                  const parsed = JSON.parse(data);
                  res.write(openRouterToOpenAIStream(parsed, model.id));
                } catch {
                  // Ignore parse errors
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        res.end();
        return;
      } else {
        const data = await orRes.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(openRouterToOpenAIResponse(data, model.id)));
        return;
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        lastError = new Error("Request timeout");
        break;
      }
      router.recordFailure(model.id);
      lastError = err;
    }
  }
  
  clearTimeout(timeout);
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: lastError?.message || "All models failed", type: "service_unavailable" } }));
}

async function handleAnthropicMessages(req: IncomingMessage, res: ServerResponse, body: AnthropicRequest): Promise<void> {
  const stream = body.stream === true;
  const modelId = body.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  
  let tried: string[] = [];
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    const decision = attempt === 1 
      ? router.selectModel(modelId)
      : router.getNextModel(tried);
    
    if (!decision) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "service_unavailable", message: "All free models unavailable" } }));
      return;
    }
    
    const { model } = decision;
    tried.push(model.id);
    
    try {
      const orBody = anthropicToOpenRouter(body);
      const orRes = await callOpenRouter(model.id, orBody, controller.signal);
      
      if (!orRes.ok) {
        const errText = await orRes.text();
        let err: any;
        try { err = JSON.parse(errText); } catch { err = { message: errText }; }
        
        if (orRes.status === 429 || orRes.status >= 500) {
          router.recordFailure(model.id);
          lastError = new Error(`${orRes.status}: ${err.error?.message || err.message || "Provider error"}`);
          continue;
        }
        
        if (orRes.status === 400 || orRes.status === 404) {
          router.recordFailure(model.id);
          lastError = new Error(`${orRes.status}: ${err.error?.message || "Model not available"}`);
          continue;
        }
        
        res.writeHead(orRes.status, { "Content-Type": "application/json" });
        res.end(errText);
        return;
      }
      
      router.recordSuccess(model.id);
      
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        
        const reader = orRes.body?.getReader();
        if (!reader) throw new Error("No response body");
        
        const decoder = new TextDecoder();
        let buffer = "";
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                  res.write("event: message_stop\ndata: {}\n\n");
                  break;
                }
                try {
                  const parsed = JSON.parse(data);
                  res.write(openRouterToAnthropicStream(parsed, model.id));
                } catch {}
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        res.end();
        return;
      } else {
        const data = await orRes.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(openRouterToAnthropicResponse(data, model.id)));
        return;
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        lastError = new Error("Request timeout");
        break;
      }
      router.recordFailure(model.id);
      lastError = err;
    }
  }
  
  clearTimeout(timeout);
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "service_unavailable", message: lastError?.message || "All models failed" } }));
}

function handleModels(req: IncomingMessage, res: ServerResponse): void {
  const models: ModelInfo[] = FREE_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: m.provider,
    context_window: m.context,
  }));
  
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: models }));
}

function handleWork(req: IncomingMessage, res: ServerResponse): void {
  if (workDone) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "done" }));
    // Exit after responding
    setTimeout(() => process.exit(0), 100);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running" }));
  }
}

// ============================================================
// HTTP Server
// ============================================================

const server = createServer(async (req, res) => {
  const { pathname } = parse(req.url || "", true);
  
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  try {
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await handleOpenAIChat(req, res, JSON.parse(body));
      return;
    }
    
    if (pathname === "/v1/messages" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await handleAnthropicMessages(req, res, JSON.parse(body));
      return;
    }
    
    if (pathname === "/v1/models" && req.method === "GET") {
      handleModels(req, res);
      return;
    }
    
    if (pathname === "/work" && req.method === "GET") {
      handleWork(req, res);
      return;
    }
    
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, models: getAllModelIds().length }));
      return;
    }
    
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
  } catch (err: any) {
    console.error("Request error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message, type: "internal_error" } }));
  }
});

server.listen(PORT, () => {
  console.log(`Free Model Aggregator running on port ${PORT}`);
  console.log(`Models: ${getAllModelIds().length} free models available`);
});

// Signal handler for graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  workDone = true;
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  workDone = true;
  server.close(() => process.exit(0));
});

// Export for testing
export { server, router, FREE_MODELS };
