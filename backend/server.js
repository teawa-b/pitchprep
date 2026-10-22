import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createQloo, qlooHosts } from './lib/qloo.js';
import { chooseLlm } from './lib/llm.js';
import { createLimiter } from './lib/limits.js';
import { loadDemo, listDemos, replay } from './lib/demos.js';
import { buildPitch } from './lib/pitch.js';

// Pitchprep's backend: serves the page in ../frontend and streams an investor brief from /api/pitch.
const files = {
  '/': ['pitch.html', 'text/html'], '/pitch.js': ['pitch.js', 'text/javascript'], '/pitch.css': ['pitch.css', 'text/css']
};
const cdn = 'https://cdn.jsdelivr.net';

const csp = {
  // Pitchprep loads the Phosphor icon font from jsDelivr.
  home: `default-src 'self'; img-src 'self' https: data:; style-src 'self' ${cdn} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${cdn}; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`
};

// Bounded in-memory stores. A single instance is enough for a demo; restarts clear them.
function boundedMap(limit) {
  const map = new Map();
  return { get: k => map.get(k), set(k, v) { map.set(k, v); while (map.size > limit) map.delete(map.keys().next().value); return v; }, has: k => map.has(k), values: () => [...map.values()] };
}

export function createApp({ env = process.env, fetcher = fetch } = {}) {
  const renders = boundedMap(300);
  const llm = chooseLlm(env, fetcher);
  const qlooHost = qlooHosts.includes(env.QLOO_API_HOST) ? env.QLOO_API_HOST : qlooHosts[0];
  const limit = createLimiter({
    agent: [Number(env.AGENT_RUNS_PER_HOUR || 5), 3600e3],
    agentIpDaily: [Number(env.AGENT_RUNS_PER_IP_PER_DAY || 12), 86400e3],
    agentDaily: [Number(env.AGENT_RUNS_PER_DAY || 200), 86400e3, true]
  });

  return async function handle(req, res) {
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Who is asking, for the limits. Behind a proxy (Railway) the real address is the one the proxy adds: X-Real-IP,
    // or the last X-Forwarded-For entry. The first entry is whatever the visitor sent, so it can't be trusted.
    const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      // Static images and 3D rooms shipped with the app (logos, the examples). Names are restricted, so no path tricks.
      const image = path.match(/^\/img\/([a-z0-9-]+)\.(jpg|png|webp|glb)$/);
      if (req.method === 'GET' && image) {
        const bytes = await readFile(new URL(`../frontend/img/${image[1]}.${image[2]}`, import.meta.url)).catch(() => null);
        if (!bytes) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': image[2] === 'glb' ? 'model/gltf-binary' : `image/${image[2] === 'jpg' ? 'jpeg' : image[2]}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end(bytes);
      }
      const entry = files[path];
      if (req.method === 'GET' && entry) {
        const [name, type] = entry;
        res.setHeader('Content-Security-Policy', csp['home'] || csp.home);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(new URL(`../frontend/${name}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true });
      if (req.method === 'GET' && path === '/api/demos') return send(200, { demos: await listDemos('pitch') });
      if (req.method === 'GET' && path === '/api/config') {
        return send(200, { site: 'pitch', siteName: 'Pitchprep', qloo: Boolean(env.QLOO_API_KEY), qlooHost, llm: llm?.label || null });
      }

      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return send(403, { error: 'Requests must come from this app.' }); }

      // Every request is a small JSON body.
      const body = await readBody(req, 32_000);

      // Instant demos: replay a recorded real run (no live calls, no run limit). See lib/demos.js.
      const demoSite = { '/api/pitch': 'pitch' }[path];
      if (demoSite && body.demo) {
        const demo = await loadDemo(demoSite, body.demo);
        if (!demo) return send(404, { error: 'That example is not available.' });
        // Re-register the recorded renders so refine, relight and the live walkthrough work from a replay.
        for (const r of demo.renders || []) if (!renders.has(r.id)) renders.set(r.id, { ...r, url: r.url, remoteUrl: r.remoteUrl });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        // An optional slower pace (ms per step, capped) lets the explainer videos film the steps arriving.
        try { await replay(demo, emit, { step: Math.min(1500, Math.max(140, Number(body.pace) || 140)) }); } finally { res.end(); }
        return;
      }

      // Pitch: research an investor (web, cited) and tailor the pitch with Qloo, streamed step by step.
      if (path === '/api/pitch') {
        const clean = (v, n) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);
        const investor = clean(body.investor, 80), firm = clean(body.firm, 80), startup = clean(body.startup, 400);
        const comps = (Array.isArray(body.comps) ? body.comps : String(body.comps || '').split(',')).map(c => clean(c, 60)).filter(Boolean).slice(0, 4);
        if (!investor) return send(400, { error: 'Name the investor.' });
        if (!startup || !comps.length) return send(400, { error: 'Describe your startup and name at least one product your customers already use.' });
        if (!llm?.research) return send(503, { error: 'Investor research needs OPENROUTER_API_KEY on the server.' });
        if (!env.QLOO_API_KEY) return send(503, { error: 'This server has no Qloo API key configured.' });
        if (!limit.take('agent', ip) || !limit.take('agentIpDaily', ip) || !limit.take('agentDaily', 'all')) return send(429, { error: 'Run limit reached. Try again in a while.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
        const qloo = createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher });
        try { await buildPitch({ qloo, llm, investor, firm, startup, comps, emit }); }
        catch (error) { emit({ type: 'error', message: error.message }); }
        finally { clearInterval(heartbeat); emit({ type: 'done', qlooCalls: qloo.calls }); res.end(); }
        return;
      }

      return send(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      send(error.status && error.status < 600 ? error.status : 400, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
  };
}

async function readBody(req, max) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  try { const body = JSON.parse(raw); if (body && typeof body === 'object') return body; } catch {}
  throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3302);
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  http.createServer(createApp()).listen(port, host, () => console.log(`Pitchprep running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
