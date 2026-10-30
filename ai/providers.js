"use strict";
// AI 模型接口: 只做一件事 —— 把 system + 对话发给模型, 流式把文字回传(onText)。
//   anthropic: 官方 @anthropic-ai/sdk(Claude)
//   openai:    OpenAI 兼容的 /chat/completions(OpenAI、DeepSeek、通义千问、Kimi、本地 Ollama 等, 填 AI_BASE_URL)
//   mock:      仅测试用(NODE_ENV=test), 回放 AI_MOCK_REPLY

const DEFAULT_MODELS = { anthropic: "claude-opus-5-5", openai: "gpt-4o-mini" };

function aiConfigFromEnv(env = process.env) {
  const provider = String(env.AI_PROVIDER || "").trim().toLowerCase();
  const ok = provider === "anthropic" || provider === "openai" || (provider === "mock" && env.NODE_ENV === "test");
  const model = String(env.AI_MODEL || DEFAULT_MODELS[provider] || "mock").trim();
  return {
    enabled: ok && (provider === "mock" || !!env.AI_API_KEY || (provider === "openai" && !!env.AI_BASE_URL)),
    provider, model,
    apiKey: env.AI_API_KEY || "",
    baseUrl: String(env.AI_BASE_URL || "").replace(/\/+$/, ""),
    // Claude 的思考深度; 默认模型用 medium(分析持仓够用、更省), 其它 Claude 模型不填就用模型自己的默认
    effort: env.AI_EFFORT || (provider === "anthropic" && model === DEFAULT_MODELS.anthropic ? "medium" : ""),
    maxTokens: Math.min(Math.max(Number(env.AI_MAX_TOKENS) || 16000, 1000), 64000),
    mockReply: env.AI_MOCK_REPLY || "",
  };
}

async function streamAnthropic(cfg, { system, messages, onText, signal }) {
  const Anthropic = require("@anthropic-ai/sdk").default;
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  const params = {
    model: cfg.model, max_tokens: cfg.maxTokens, system, messages,
    ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
  };
  // 直连 Anthropic 时开启服务端兜底: 模型因安全策略拒答时由服务端换推荐模型重试(不支持的模型会忽略)
  const stream = cfg.baseUrl
    ? client.messages.stream(params, { signal })
    : client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") onText("\n\n（模型拒绝回答这个问题，换个问法试试。）");
  else if (final.stop_reason === "max_tokens") onText("\n\n（回答太长被截断了，可以让它继续或问得更具体些。）");
  return { stopReason: final.stop_reason, model: final.model };
}

async function streamOpenAI(cfg, { system, messages, onText, signal }) {
  const base = cfg.baseUrl || "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, stream: true, max_tokens: cfg.maxTokens, messages: [{ role: "system", content: system }, ...messages] }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型接口 HTTP ${res.status}${t ? ": " + t.slice(0, 200) : ""}`);
  }
  let buf = "", stopReason = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { stopReason: stopReason || "stop" };
      try {
        const j = JSON.parse(data);
        const c = j.choices && j.choices[0];
        if (c && c.delta && c.delta.content) onText(c.delta.content);
        if (c && c.finish_reason) stopReason = c.finish_reason;
      } catch { /* 忽略不完整/非 JSON 的行 */ }
    }
  }
  if (stopReason === "length") onText("\n\n（回答太长被截断了。）");
  return { stopReason: stopReason || "stop" };
}

async function streamMock(cfg, { onText }) {
  const text = cfg.mockReply || "（测试回复）";
  for (let i = 0; i < text.length; i += 20) onText(text.slice(i, i + 20));
  return { stopReason: "end_turn" };
}

function streamChat(cfg, args) {
  if (cfg.provider === "anthropic") return streamAnthropic(cfg, args);
  if (cfg.provider === "openai") return streamOpenAI(cfg, args);
  if (cfg.provider === "mock") return streamMock(cfg, args);
  return Promise.reject(new Error("未配置 AI_PROVIDER"));
}

module.exports = { aiConfigFromEnv, streamChat, DEFAULT_MODELS };
