// Pitch: research an investor before the meeting, then use Qloo to tailor the pitch.
//
// 1. Web research (cited) for the investor's public, professional record: firm, thesis, stage, portfolio,
//    and the public things they host, own or champion (a podcast, a team, books they recommend).
// 2. Qloo resolves the portfolio and those public interests to entities, and the founder's product to its
//    comparable brands.
// 3. Qloo scores every portfolio company for the founder's audience (filter.results.entities), compares the
//    two audiences' demographics, and finds what fans of the investor's public interests also love.
// 4. An LLM writes the brief from those numbers only: which portfolio companies to name, how to frame the
//    deck, what to open with. Every name it cites is checked against the run.
//
// Scope: public professional information about people acting as investors. The research prompt rules out
// family, home, health, finances and anything private, and every fact links to its source.

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ageBands = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'];
const bandLabel = { '24_and_younger': 'under 25', '25_to_29': '25-29', '30_to_34': '30-34', '35_to_44': '35-44', '45_to_54': '45-54', '55_and_older': '55+' };
const avgAge = (ids, demo) => Object.fromEntries(ageBands.map(b => [b, ids.length ? ids.reduce((s, id) => s + (demo[id]?.age?.[b] || 0), 0) / ids.length : 0]));
const cosine = (a, b) => { const x = ageBands.map(k => a[k] || 0), y = ageBands.map(k => b[k] || 0); const n = Math.hypot(...x) * Math.hypot(...y); return n ? x.reduce((s, v, i) => s + v * y[i], 0) / n : 0; };
const topBand = a => bandLabel[ageBands.reduce((m, b) => (a[b] ?? -9) > (a[m] ?? -9) ? b : m, ageBands[0])];
// Models sometimes leave a trailing comma or a stray quote in long answers; try a light repair before giving up.
const json = text => {
  const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try { return JSON.parse(raw); } catch (error) {
    try { return JSON.parse(raw.replace(/,\s*([\]}])/g, '$1').replace(/[\u0000-\u001f]+/g, ' ')); } catch { throw error; }
  }
};

export const researchSystem = `You research investors for founders preparing a pitch meeting. Use web search. Report only public, professional information: the person's firm and role, investment thesis, stages and cheque sizes, notable portfolio companies, public statements about what they look for, and the public things they host, own or champion (podcasts they host, teams they own, books they publicly recommend, companies they founded). Never include family members, home addresses, health, personal finances, relationships or anything private. If you are unsure of a fact, leave it out. Reply with JSON only.`;

export async function buildPitch({ qloo, llm, investor, firm = '', startup, comps = [], emit }) {
  const step = async (id, label, fn) => {
    emit({ type: 'step', id, label });
    try { const out = await fn(); emit({ type: 'step_done', id, summary: out?.summary || '' }); return out?.data; }
    catch (error) { emit({ type: 'step_error', id, message: error.message }); return null; }
  };
  const signals = new Map();
  const record = (name, kind, extra = {}) => { if (name && !signals.has(norm(name))) signals.set(norm(name), { name, kind, ...extra }); };

  // 1. Web research, cited.
  const dossier = await step('research', `Researching ${investor} on the web`, async () => {
    const shape = `{"name": "...", "firm": "...", "role": "...", "thesis": "one or two sentences in plain words", "stages": "e.g. pre-seed to Series A", "cheque": "typical cheque size if public, else empty", "looks_for": ["3-5 short phrases from their public statements"], "portfolio": [up to 15 notable portfolio companies, names only], "public_interests": [up to 8 of {"name": "exact name", "kind": "podcast|team|book|artist|tv_show|movie|brand", "why": "e.g. hosts it, owns it, recommends it"}], "recent": ["up to 3 recent public investments or announcements with month and year"], "sources": ["the URLs you used, most important first"]}`;
    const ask = () => llm.research(`Research ${investor}${firm ? ` (${firm})` : ''} as an investor. Return JSON with exactly these keys and no others:
${shape}`, { system: researchSystem });
    // Research answers are long and occasionally malformed. First ask the model to repair its own JSON (cheap, no
    // new search); only if that fails, search again.
    const repair = async bad => json((await llm.create({ system: 'You fix broken JSON. Reply with the corrected JSON only, keeping every value.', tools: [], user: bad }).next()).text);
    let { text, sources } = await ask(), d;
    try { d = json(text); } catch {
      try { d = await repair(text); } catch { ({ text, sources } = await ask()); d = json(text); }
    }
    // Some models answer with their own layout (e.g. "firm_and_role", "funds"). Map it onto ours, keeping only what
    // the research said.
    if (!Array.isArray(d.portfolio)) {
      d = json((await llm.create({ system: 'You reshape research notes into a fixed JSON layout. Use only facts present in the notes; leave a field empty when the notes do not say. Reply with JSON only.', tools: [], user: `Layout:
${shape}

Notes:
${text}` }).next()).text);
    }
    // Citations come back as annotations; when a provider omits them, fall back to the URLs listed in the answer.
    const listed = (Array.isArray(d.sources) ? d.sources : []).map(String).filter(u => /^https?:\/\//.test(u)).map(url => ({ url, title: url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) }));
    // Last resort: any URLs written in the answer itself.
    const inText = [...new Set(text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])].map(url => ({ url, title: url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80) }));
    d.sources = sources.length ? sources : (listed.length ? listed : inText).slice(0, 12);
    d.portfolio = (d.portfolio || []).slice(0, 15).map(String);
    d.public_interests = (d.public_interests || []).slice(0, 8);
    return { data: d, summary: `${d.firm || 'firm unknown'} · ${d.portfolio.length} portfolio companies · ${d.sources.length} sources` };
  });
  if (!dossier) { emit({ type: 'error', message: `Couldn't research ${investor}. Check the name, or add the firm.` }); return; }

  // 2. Resolve everything in Qloo, a few searches at a time (a burst of 25 trips Qloo's rate limit).
  const search = async (name, type) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await qloo.search(name, type, 3); }
      catch (error) { if (error.status !== 429) return []; await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
    }
    return [];
  };
  const find = async (name, types) => {
    // Whole-word match on the first word, so "FEVO" can't resolve to a person named "Alex Fevola".
    for (const type of types) { const hit = (await search(name, type))[0]; if (hit && norm(hit.name).split(' ').includes(norm(name).split(' ')[0])) return { ...hit, type }; }
    return null;
  };
  const pool = async (items, fn, size = 3) => { const out = []; for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn))); return out; };
  const resolved = await step('resolve', 'Finding the portfolio, their interests and your product in Qloo', async () => {
    const compHits = (await pool(comps, name => find(name, ['brand', 'tv_show', 'podcast', 'artist']))).filter(Boolean);
    const portfolio = (await pool(dossier.portfolio, name => find(name, ['brand']))).filter(Boolean);
    const kinds = { podcast: ['podcast'], team: ['brand'], book: ['book'], artist: ['artist'], tv_show: ['tv_show'], movie: ['movie'], brand: ['brand'] };
    const interests = (await pool(dossier.public_interests, async i => { const hit = await find(i.name, kinds[i.kind] || ['brand', 'podcast', 'book']); return hit && { ...hit, why: i.why }; })).filter(Boolean);
    [...portfolio, ...interests, ...compHits].forEach(e => record(e.name, e.type, { id: e.id }));
    if (!compHits.length) throw new Error('None of your comparable products matched in Qloo. Name 2–4 well-known brands or apps your customers use.');
    return { data: { portfolio, interests, comps: compHits }, summary: `${portfolio.length}/${dossier.portfolio.length} portfolio · ${interests.length} interests · comps: ${compHits.map(c => c.name).join(', ')}` };
  });
  if (!resolved) { emit({ type: 'final', dossier, resolved: null }); return; }
  const compIds = resolved.comps.map(c => c.id), portIds = resolved.portfolio.map(p => p.id).filter(id => !compIds.includes(id));

  // 3. Qloo measurements.
  const fit = await step('fit', 'Scoring their portfolio against your customers', async () => {
    const ranked = portIds.length ? await qloo.rank(compIds, 'brand', portIds) : [];
    ranked.forEach(e => record(e.name, 'brand', { id: e.id, affinity: e.affinity }));
    const demo = await qloo.demographics({ entities: [...compIds, ...portIds] });
    const yours = avgAge(compIds, demo), theirs = avgAge(portIds, demo);
    const ageMatch = portIds.length ? (cosine(yours, theirs) + 1) / 2 : null;
    const top = ranked.slice(0, 5), mean = ranked.length ? ranked.reduce((s, e) => s + (e.affinity || 0), 0) / ranked.length : 0;
    // Plain score: half how much your customers like their portfolio (mean affinity), half how alike the crowds are.
    const score = ranked.length ? Math.round(100 * (0.5 * mean + 0.5 * (ageMatch ?? 0.5))) : null;
    return { data: { ranked, score, mean: Math.round(mean * 100) / 100, ageMatch: ageMatch == null ? null : Math.round(ageMatch * 100) / 100, yourCrowd: topBand(yours), theirCrowd: portIds.length ? topBand(theirs) : null }, summary: score == null ? 'no portfolio companies in Qloo' : `fit ${score}/100 · closest: ${top.map(e => e.name).join(', ')}` };
  });
  const rapport = await step('rapport', 'Finding common ground in what they publicly love', async () => {
    const ids = resolved.interests.map(i => i.id);
    if (!ids.length) return { data: [], summary: 'no public interests found in Qloo' };
    const own = new Set([...ids, ...compIds]);
    const [books, podcasts, brands] = await Promise.all(['book', 'podcast', 'brand'].map(type => qloo.fanEntities(ids, type, { take: 6 }).then(list => list.filter(e => !own.has(e.id))).catch(() => [])));
    const all = [...books.slice(0, 4), ...podcasts.slice(0, 4), ...brands.slice(0, 4)];
    all.forEach(e => record(e.name, e.type, { id: e.id, affinity: e.affinity }));
    return { data: { books, podcasts, brands }, summary: all.slice(0, 4).map(e => e.name).join(', ') };
  });

  // 4. The brief.
  const brief = await step('brief', 'Writing your pitch brief', async () => {
    const facts = {
      investor: { name: dossier.name, firm: dossier.firm, thesis: dossier.thesis, stages: dossier.stages, looks_for: dossier.looks_for, recent: dossier.recent },
      your_startup: startup, your_comparables: resolved.comps.map(c => c.name),
      qloo_portfolio_fit: (fit?.ranked || []).map(e => ({ company: e.name, your_customers_affinity: e.affinity })), fit_score: fit?.score, your_crowd_age: fit?.yourCrowd, their_portfolio_crowd_age: fit?.theirCrowd,
      their_public_interests: resolved.interests.map(i => ({ name: i.name, why: i.why })),
      qloo_common_ground: { books: (rapport?.books || []).slice(0, 4).map(e => e.name), podcasts: (rapport?.podcasts || []).slice(0, 4).map(e => e.name), brands: (rapport?.brands || []).slice(0, 4).map(e => e.name) }
    };
    const session = llm.create({ system: 'You coach founders before investor meetings. Use only the facts given; never invent portfolio companies, numbers or interests. Reply with JSON only. Write plainly and never use em dashes.', tools: [], user: `Facts (web research and Qloo):\n${JSON.stringify(facts)}\n\nReply as JSON: {"headline": "one sentence: why this investor, for this startup", "angle": "two sentences on how to frame the pitch for their thesis", "name_drop": [up to 3 of {"company": "exact name from qloo_portfolio_fit", "line": "one sentence you could say in the meeting linking your startup to it"}], "deck": [3-5 short instructions for the deck, e.g. "Lead with retention: their portfolio skews to habit apps"], "openers": [up to 3 of {"line": "a natural opener, phrased as a question or observation about the thing itself; Qloo describes what fans of their public interests also love, so never claim the investor personally loves it", "based_on": "exact name from qloo_common_ground (use their_public_interests only when qloo_common_ground is empty)"}], "avoid": [up to 3 short cautions grounded in their stated thesis], "questions": [3 sharp questions they are likely to ask]}` });
    const { text } = await session.next();
    const b = json(text);
    const check = name => ({ name: String(name || ''), grounded: signals.has(norm(name)) });
    b.name_drop = (b.name_drop || []).slice(0, 3).map(n => ({ ...n, ...check(n.company) }));
    b.openers = (b.openers || []).slice(0, 3).map(o => ({ ...o, ...check(o.based_on) }));
    return { data: b, summary: b.headline?.slice(0, 120) };
  });

  // 5. The same question without Qloo: the LLM gets only the web research, then each company it picks is
  //    checked against Qloo's ranking for your customers. This is what the brief would be without Qloo.
  const baseline = await step('baseline', 'Asking the same question without Qloo', async () => {
    const session = llm.create({ system: 'You coach founders before investor meetings. Reply with JSON only. Write plainly and never use em dashes.', tools: [], user: `Investor (web research): ${JSON.stringify({ name: dossier.name, firm: dossier.firm, thesis: dossier.thesis, portfolio: dossier.portfolio, public_interests: dossier.public_interests })}\nThe founder's startup: ${startup}\nTheir customers already use: ${resolved.comps.map(c => c.name).join(', ')}\n\nWhich of the investor's portfolio companies should the founder mention, and what should they open with? JSON: {"name_drop": [up to 3 of {"company": "exact name from the portfolio", "line": "one sentence"}], "openers": [up to 2 of {"line": "a natural opener"}]}` });
    const b = json((await session.next()).text);
    const ranked = fit?.ranked || [];
    const picks = (b.name_drop || []).slice(0, 3).map(n => {
      const i = ranked.findIndex(r => norm(r.name) === norm(n.company));
      return { company: String(n.company || ''), line: String(n.line || ''), rank: i < 0 ? null : i + 1, of: ranked.length, affinity: i < 0 ? null : ranked[i].affinity };
    });
    const openers = (b.openers || []).slice(0, 2).map(o => ({ line: String(o.line || '') }));
    return { data: { picks, openers }, summary: picks.map(p => `${p.company}: ${p.rank ? `Qloo #${p.rank} of ${p.of}` : 'not in Qloo'}`).join(', ') };
  });
  emit({ type: 'final', dossier, resolved, fit, rapport, brief, baseline });
}
