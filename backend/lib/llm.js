import { fetchJson } from './http.js';

// Provider adapters share one shape: next() returns { text, calls: [{ id, name, input }] },
// and reply(results) appends tool results so the loop can call next() again.

export function anthropicSession({ key, model = 'claude-haiku-5-5', system, tools, user, fetcher = fetch, baseUrl = 'https://api.anthropic.com' }) {
  const messages = [{ role: 'user', content: user }];
  const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  return {
    provider: 'anthropic', model,
    async next() {
      const data = await fetchJson(fetcher, `${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4096, system, tools: defs, messages })
      }, { label: 'Claude', secrets: [key], timeout: 90000 });
      messages.push({ role: 'assistant', content: data.content });
      return {
        text: data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        calls: data.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} }))
      };
    },
    reply(results) {
      messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.error ? { is_error: true } : {}) })) });
    },
    say(text) { messages.push({ role: 'user', content: text }); }
  };
}

export function openaiSession({ key, model = 'gpt-5-mini', system, tools, user, fetcher = fetch, baseUrl = 'https://api.openai.com', provider = 'openai', headers = {}, extra = {} }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const defs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return {
    provider, model,
    async next() {
      const data = await fetchJson(fetcher, `${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
        // Some providers (Gemini among them) reject an empty tools list, so leave it out when there are none.
        body: JSON.stringify({ model, ...extra, ...(defs.length ? { tools: defs } : {}), messages })
      }, { label: provider === 'openrouter' ? 'OpenRouter' : 'OpenAI', secrets: [key], timeout: 90000 });
      const message = data.choices?.[0]?.message || {};
      messages.push(message);
      return {
        text: (message.content || '').trim(),
        calls: (message.tool_calls || []).map(c => {
          let input = {};
          try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = { _unparsed: c.function.arguments }; }
          return { id: c.id, name: c.function.name, input };
        })
      };
    },
    reply(results) { for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content }); },
    say(text) { messages.push({ role: 'user', content: text }); }
  };
}

// One-shot vision question about a photo (data URI), for providers that accept images.
function openaiLook({ key, model, baseUrl, label, headers = {}, fetcher, extra = {} }) {
  return async (images, question) => {
    const parts = [].concat(images).map(url => ({ type: 'image_url', image_url: { url } }));
    const data = await fetchJson(fetcher, `${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, ...extra, max_tokens: 600, messages: [{ role: 'user', content: [{ type: 'text', text: question }, ...parts] }] })
    }, { label, secrets: [key], timeout: 45000 });
    return String(data.choices?.[0]?.message?.content || '').trim();
  };
}
function anthropicLook({ key, model, fetcher }) {
  return async (images, question) => {
    const parts = [].concat(images).map(uri => { const [, media, data] = uri.match(/^data:([^;]+);base64,(.*)$/) || []; return { type: 'image', source: { type: 'base64', media_type: media, data } }; });
    const data = await fetchJson(fetcher, 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content: [...parts, { type: 'text', text: question }] }] })
    }, { label: 'Claude', secrets: [key], timeout: 45000 });
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  };
}

// One web-grounded answer through OpenRouter's web plugin. Returns the text and the URLs it cited.
function openrouterResearch({ key, model, fetcher, extra = {} }) {
  return async (question, { system, maxResults = 8, maxTokens = 2500 } = {}) => {
    const data = await fetchJson(fetcher, 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'X-Title': 'Qloo hackathon' },
      body: JSON.stringify({ model, ...extra, plugins: [{ id: 'web', max_results: maxResults }], max_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: question }] })
    }, { label: 'Web research', secrets: [key], timeout: 120000 });
    const message = data.choices?.[0]?.message || {};
    const seen = new Set();
    const sources = (message.annotations || []).filter(a => a.type === 'url_citation' && a.url_citation?.url).map(a => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url })).filter(s => !seen.has(s.url) && seen.add(s.url));
    return { text: String(message.content || '').trim(), sources };
  };
}

// Two tiers, both cheap by default (prices per million tokens in/out on OpenRouter, October 2026):
//   main  the agent, briefs and web research          LLM_MODEL       default Claude Haiku 5.5 ($0.10/$0.50)
//   fast  short, latency-bound calls              LLM_FAST_MODEL  default Gemini 2.5 Flash Lite ($0.10/$0.40)
// Any OpenRouter model id works for either (e.g. openai/gpt-5-mini, google/gemini-3-flash-preview).
export const defaultModels = { main: 'anthropic/claude-haiku-5.5', fast: 'google/gemini-2.5-flash-lite' };

export function chooseLlm(env, fetcher = fetch) {
  // OpenRouter speaks the OpenAI chat-completions protocol, so it reuses that adapter.
  const openrouterKey = env.OPENROUTER_API_KEY || env.OPENROUTERKEY_API_KEY;
  if (openrouterKey) {
    // When a model is rate-limited or down, OpenRouter moves on to the next one in `models`.
    const via = (model, backup) => {
      const extra = backup && backup !== model ? { models: [model, backup] } : {};
      return {
        create: opts => openaiSession({ ...opts, fetcher, key: openrouterKey, model, extra, baseUrl: 'https://openrouter.ai/api', provider: 'openrouter', headers: { 'X-Title': 'Qloo hackathon' } }),
        label: `OpenRouter (${model})`,
        look: openaiLook({ key: openrouterKey, model, extra, baseUrl: 'https://openrouter.ai/api', label: 'OpenRouter', headers: { 'X-Title': 'Qloo hackathon' }, fetcher }),
        research: openrouterResearch({ key: openrouterKey, model, extra, fetcher })
      };
    };
    const main = env.LLM_MODEL || env.OPENROUTER_MODEL || defaultModels.main;
    return { ...via(main), fast: via(env.LLM_FAST_MODEL || defaultModels.fast, main) };
  }
  if (env.ANTHROPIC_API_KEY) {
    const model = env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
    return { create: opts => anthropicSession({ ...opts, fetcher, key: env.ANTHROPIC_API_KEY, model }), label: `Claude (${model})`, look: anthropicLook({ key: env.ANTHROPIC_API_KEY, model, fetcher }) };
  }
  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_MODEL || 'gpt-5-mini';
    return { create: opts => openaiSession({ ...opts, fetcher, key: env.OPENAI_API_KEY, model }), label: `OpenAI (${model})` };
  }
  return null;
}
