import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';

const QKEY = 'qloo-secret-key', OKEY = 'openrouter-secret-key', FKEY = 'fal-secret-key';

async function serve(t, env, fetcher) {
  const server = http.createServer(createApp({ env, fetcher }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}
const events = async res => (await res.text()).split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const reply = content => Response.json({ choices: [{ message: { content } }] });

// A fake Qloo with a few brands, a podcast and a book; every search hits by exact name.
const catalog = { 'Superhero Movie': 'm-superhero-movie', Calm: 'b-calm', Strava: 'b-strava', Uber: 'b-uber', Robinhood: 'b-robin', 'This Week in Startups': 'p-twist', 'Sally Rooney': 'pe-rooney', 'Phoebe Bridgers': 'a-pb', 'Past Lives': 'm-pl', Marvel: 'br-marvel' };
function qloo(url, log) {
  const p = url.searchParams;
  log.push(Object.fromEntries(p));
  if (url.pathname === '/v2/tags') return Response.json({ results: { tags: /superhero/i.test(p.get('filter.query')) ? [{ tag_id: 't-super', name: 'Superhero' }] : [] } });
  if (url.pathname === '/search') {
    const name = Object.keys(catalog).find(k => k.toLowerCase() === p.get('query').toLowerCase());
    return Response.json({ results: name ? [{ name, entity_id: catalog[name], popularity: 0.9, types: [p.get('types') || 'urn:entity:brand'] }] : [] });
  }
  const type = p.get('filter.type');
  if (type === 'urn:demographics') return Response.json({ results: { demographics: (p.get('signal.interests.entities') || '').split(',').map(id => ({ entity_id: id, query: { age: { '25_to_29': 0.4, '45_to_54': -0.3 }, gender: {} } })) } });
  if (p.get('filter.results.entities')) return Response.json({ results: { entities: p.get('filter.results.entities').split(',').map((id, i) => ({ name: Object.keys(catalog).find(k => catalog[k] === id), entity_id: id, query: { affinity: 0.8 - i * 0.05 } })) } });
  const explain = p.get('feature.explainability') === 'true';
  const ids = (p.get('signal.interests.entities') || '').split(',');
  return Response.json({ results: { entities: [
    { name: 'Lucy Dacus', entity_id: 'a-dacus', query: { affinity: 0.92, ...(explain ? { explainability: { 'signal.interests.entities': ids.map(id => ({ entity_id: id, score: 1 / ids.length })) } } : {}) } },
    { name: 'The Power Law', entity_id: 'bk-power', query: { affinity: 0.88 } }
  ] } });
}

test('pitch: cited web research, Qloo portfolio scoring with filter.results.entities, grounded brief', async t => {
  const log = [], llmCalls = [];
  const fetcher = async (url, options = {}) => {
    url = new URL(url);
    if (url.host === 'hackathon.api.qloo.com') return qloo(url, log);
    if (url.host === 'openrouter.ai') {
      const body = JSON.parse(options.body);
      llmCalls.push(body);
      if (body.plugins) {
        assert.match(body.messages[0].content, /Never include family/);
        return Response.json({ choices: [{ message: { content: JSON.stringify({ name: 'Jane Investor', firm: 'Acme Ventures', thesis: 'Consumer habits.', portfolio: ['Uber', 'Robinhood', 'Calm', 'Nowhere Inc'], public_interests: [{ name: 'This Week in Startups', kind: 'podcast', why: 'hosts it' }] }), annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/jane', title: 'Jane profile' } }] } }] });
      }
      return reply(JSON.stringify({ headline: 'h', angle: 'a', name_drop: [{ company: 'Uber', line: 'x' }, { company: 'Made Up Co', line: 'y' }], deck: ['d'], openers: [{ line: 'o', based_on: 'The Power Law' }], avoid: [], questions: ['q'] }));
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  const base = await serve(t, { QLOO_API_KEY: QKEY, OPENROUTER_API_KEY: OKEY }, fetcher);
  assert.equal((await post(base, '/api/pitch', { investor: 'Jane' })).status, 400, 'startup and comps are required');
  const ev = await events(await post(base, '/api/pitch', { investor: 'Jane Investor', startup: 'A habit app', comps: 'Calm, Strava' }));
  const final = ev.find(e => e.type === 'final');
  assert.deepEqual(final.dossier.sources, [{ url: 'https://example.com/jane', title: 'Jane profile' }]);
  assert.deepEqual(final.resolved.comps.map(c => c.name), ['Calm', 'Strava']);
  // Calm is a comp, so it is not scored as a portfolio company; the unknown one is skipped.
  const rank = log.find(l => l['filter.results.entities']);
  assert.equal(rank['signal.interests.entities'], 'b-calm,b-strava');
  assert.equal(rank['filter.results.entities'], 'b-uber,b-robin');
  assert.deepEqual(final.fit.ranked.map(r => r.name), ['Uber', 'Robinhood']);
  assert.ok(final.fit.score > 0 && final.fit.score <= 100);
  assert.deepEqual(final.brief.name_drop.map(n => [n.company, n.grounded]), [['Uber', true], ['Made Up Co', false]], 'invented portfolio companies are flagged');
  assert.equal(final.brief.openers[0].grounded, true);
  // Without Qloo: the LLM's own picks, each placed in Qloo's ranking (or marked as not found).
  assert.deepEqual(final.baseline.picks.map(p => [p.company, p.rank]), [['Uber', 1], ['Made Up Co', null]]);
  // The investor is never sent to Qloo: only their portfolio, public interests and your comparables.
  assert.equal(log.some(l => JSON.stringify(l).includes('Jane')), false, 'no Qloo call names the investor');
  assert.ok(ev.find(e => e.type === 'done').qlooCalls.length > 0, 'every Qloo call is listed for the UI');
  assert.equal(JSON.stringify(ev).includes(OKEY) || JSON.stringify(ev).includes(QKEY), false);
});

