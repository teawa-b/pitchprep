import { tick, chime } from '/sound.js';
import { keepFresh } from '/fresh.js';
const $ = id => document.getElementById(id);
// Model-written text never shows an em or en dash used as punctuation (house style); a comma reads the same.
const tidy = v => typeof v === 'string' ? v.replace(/(\d)\s*–\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ') : v;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = tidy(text); return n; };
const safeUrl = v => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const host = v => { try { return new URL(v).hostname.replace(/^www\./, ''); } catch { return ''; } };
let running = false, last = null;

function toast(text, ms = 4000) { $('toast').textContent = text; $('toast').hidden = !text; clearTimeout(toast.t); if (text) toast.t = setTimeout(() => { $('toast').hidden = true; }, ms); }
keepFresh(() => running || !$('out').hidden, toast);

// A judge card opens that judge's recorded brief instantly (for the sample startup); the form runs live.
const sample = { startup: 'A live-events app that turns a concert ticket into a night out: pre-show bars, merch and rides, picked for each fanbase', comps: 'Ticketmaster, Spotify, Uber' };
document.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
  $('investor').value = b.dataset.i; $('firm').value = b.dataset.f;
  $('startup').value = sample.startup; $('comps').value = sample.comps;
  run(b.dataset.i.toLowerCase().split(' ').pop());
}));
$('ask').addEventListener('submit', e => { e.preventDefault(); run(); });
$('again').addEventListener('click', () => { $('out').hidden = true; $('intro').hidden = false; history.replaceState(null, '', '/'); scrollTo({ top: 0 }); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(asText(last)); toast('Brief copied.'); } catch { toast('Copy did not work in this browser.'); }
});

async function run(demo = null) {
  tick();
  if (running) return;
  running = true;
  const body = { investor: $('investor').value.trim(), firm: $('firm').value.trim(), startup: $('startup').value.trim(), comps: $('comps').value, ...(demo ? { demo, pace: new URLSearchParams(location.search).get('pace') } : {}) };
  $('demo-note').hidden = !demo;
  $('intro').hidden = true; $('out').hidden = false; $('o-body').hidden = true; $('o-fit').hidden = true; $('copy').hidden = true; $('steps').replaceChildren();
  $('o-kicker').textContent = 'Researching'; $('o-name').textContent = body.investor; $('o-role').textContent = body.firm;
  scrollTo({ top: 0 });
  const pending = new Map();
  try {
    const stall = new AbortController(); let watchdog = setTimeout(() => stall.abort(), 90000);
    const res = await fetch('/api/pitch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: stall.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The brief could not start.');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      clearTimeout(watchdog); watchdog = setTimeout(() => stall.abort(), 90000);
      buffer += value; let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buffer = buffer.slice(i + 2);
        if (line) handle(JSON.parse(line.slice(6)), pending);
      }
    }
    clearTimeout(watchdog);
  } catch (error) { const m = error.name === 'AbortError' ? 'The server stopped responding. Try again.' : error.message; toast(m); $('o-kicker').textContent = 'That did not work'; $('o-role').textContent = m; }
  finally { running = false; }
}

function handle(ev, pending) {
  if (ev.type === 'step') { const li = el('li', 'busy'); li.append(el('span', '', ev.label)); $('steps').append(li); pending.set(ev.id, li); }
  else if (ev.type === 'step_done') { const li = pending.get(ev.id); if (li) { li.className = 'done'; if (ev.summary) li.append(el('small', '', ev.summary)); } }
  else if (ev.type === 'step_error') { const li = pending.get(ev.id); if (li) { li.className = 'err'; li.append(el('small', '', ev.message)); } }
  else if (ev.type === 'error') { $('o-kicker').textContent = 'That did not work'; $('o-role').textContent = ev.message; }
  else if (ev.type === 'final') show(ev);
  else if (ev.type === 'done') calls(ev.qlooCalls || []);
}

function show(data) {
  chime();
  const { dossier, resolved, fit, brief, baseline } = data;
  last = data;
  $('o-made').replaceChildren(...$('steps').children);
  $('o-kicker').textContent = `Brief prepared ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('o-name').textContent = dossier.name || $('investor').value;
  // Research often names the firm inside the role already; don't repeat it, and don't leave ".," behind.
  const role = String(dossier.role || '').replace(/[.\s]+$/, ''), firmName = String(dossier.firm || '');
  $('o-role').textContent = tidy([role, role.toLowerCase().includes(firmName.split(' ')[0].toLowerCase()) ? '' : firmName].filter(Boolean).join(', '));
  if (fit?.score != null) { $('o-fit').hidden = false; $('o-fit').querySelector('b').textContent = fit.score; }
  $('o-headline').textContent = tidy(brief?.headline || '');

  // Their portfolio, ranked by how much your customers like each company (Qloo affinity).
  const ranked = fit?.ranked || [], drops = brief?.name_drop || [];
  $('o-portfolio').replaceChildren(...(ranked.length ? ranked.slice(0, 8).map((r, i) => {
    const li = el('li'), co = el('span', 'co', r.name), drop = drops.find(d => d.company?.toLowerCase() === r.name.toLowerCase());
    if (drop?.line) co.append(el('small', '', drop.line));
    li.append(el('span', 'n', String(i + 1)), co, el('span', 'aff', (r.affinity ?? 0).toFixed(2)));
    return li;
  }) : [el('li', 'small empty', 'None of their portfolio companies are in Qloo yet, so there is no ranking for this investor.')]));
  const extra = drops.filter(d => !d.grounded);
  if (extra.length) extra.forEach(d => { const li = el('li'), co = el('span', 'co', d.company); co.append(el('span', 'unverified', 'not from Qloo')); li.append(el('span', 'n', ''), co, el('span', 'aff', '')); $('o-portfolio').append(li); });
  const unresolved = (dossier.portfolio || []).filter(n => !(resolved?.portfolio || []).some(p => p.name.toLowerCase().includes(n.toLowerCase().split(' ')[0])));
  $('o-fit-note').textContent = fit?.score == null ? '' : tidy(`Affinity is how much people who use ${resolved.comps.map(c => c.name).join(', ')} like each company, from Qloo. Fit ${fit.score} = half the mean affinity (${fit.mean}) and half how alike the two crowds' ages are (${fit.ageMatch}). Your crowd skews ${fit.yourCrowd}; their portfolio's skews ${fit.theirCrowd}.${unresolved.length ? ` Not in Qloo: ${unresolved.slice(0, 5).join(', ')}.` : ''}`);

  // With and without Qloo: Qloo's top three against the LLM's own picks, each placed in Qloo's ranking.
  $('cmp-qloo').replaceChildren(...ranked.slice(0, 3).map((r, i) => { const li = el('li'); li.append(el('b', '', r.name), el('span', '', `Qloo #${i + 1} of ${ranked.length}, affinity ${(r.affinity ?? 0).toFixed(2)}`)); return li; }));
  const picks = baseline?.picks || [];
  const isComp = name => (resolved?.comps || []).some(c => c.name.toLowerCase() === String(name).toLowerCase());
  $('cmp-llm').replaceChildren(...picks.map(p => { const li = el('li'); li.append(el('b', '', p.company), el('span', '', p.rank ? `Qloo #${p.rank} of ${p.of}, affinity ${(p.affinity ?? 0).toFixed(2)}` : isComp(p.company) ? 'one of your own comparables, so not a portfolio pick' : 'not in Qloo\'s ranking for your customers')); return li; }));
  const missed = picks.filter(p => !p.rank || p.rank > 3).length;
  $('cmp-note').textContent = !picks.length ? 'The comparison did not run for this brief.'
    : missed ? `Without Qloo, ${missed === picks.length ? `none of the ${picks.length} companies the LLM would name are` : `${missed} of the ${picks.length} companies the LLM would name are not`} among the three your customers rate highest. The LLM sees the same web research; only Qloo knows your customers.`
    : 'Here the LLM alone picked the same top companies; Qloo confirms them with numbers.';
  $('o-body').querySelector('.compare').hidden = !ranked.length;

  // Openers: Qloo says what fans of the investor's public interests also love; that is about crowds, not the investor.
  const interests = resolved?.interests || [];
  $('o-openers').replaceChildren(...(brief?.openers || []).map(o => {
    const c = el('div', 'opener');
    c.append(el('p', '', `“${o.line}”`));
    const why = o.grounded ? (interests.some(i => i.name === o.based_on) ? `Their public interest: ${o.based_on}` : `Fans of ${interests.slice(0, 2).map(i => i.name).join(' and ') || 'their public interests'} also love ${o.based_on}`) : `${o.based_on} (not from Qloo)`;
    c.append(el('span', '', why));
    return c;
  }));
  if (!(brief?.openers || []).length) $('o-openers').append(el('p', 'small', 'No public interests of theirs are in Qloo, so there are no Qloo openers for this investor.'));

  $('o-thesis').textContent = tidy(dossier.thesis || 'No public thesis found.');
  const facts = [['Stages', dossier.stages], ['Cheque', dossier.cheque], ['Looks for', (dossier.looks_for || []).join('; ')], ['Recent', (dossier.recent || []).join('; ')]].filter(([, v]) => v);
  $('o-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
  $('o-angle').textContent = tidy(brief?.angle || '');
  $('o-deck').replaceChildren(...(brief?.deck || []).map(t => el('li', '', t)));
  $('o-questions').replaceChildren(...(brief?.questions || []).map(t => el('li', '', t)));
  $('o-avoid').replaceChildren(...(brief?.avoid || []).map(t => el('li', '', t)));
  $('o-sources').replaceChildren(...(dossier.sources || []).map(s => { const li = el('li'), a = el('a', '', s.title); a.href = safeUrl(s.url); a.target = '_blank'; a.rel = 'noreferrer'; li.append(a, el('small', '', host(s.url))); return li; }));
  if (!(dossier.sources || []).length) $('o-sources').append(el('li', '', 'The research step returned no citations; treat the dossier as unverified.'));
  $('o-body').hidden = false; $('copy').hidden = false;
}

// Every Qloo call behind the brief, so anyone can check where a number came from.
function calls(list) {
  $('calls-count').textContent = list.length ? `(${list.length} Qloo calls)` : '';
  $('o-calls').replaceChildren(...list.map(c => { let u; try { u = new URL(c.url); } catch { return el('li', '', c.url); } return el('li', '', `${u.pathname}?${decodeURIComponent(u.search.slice(1))}`); }));
}

function asText({ dossier, fit, brief }) {
  const lines = [`Pitchprep brief: ${dossier.name}${dossier.firm ? `, ${dossier.firm}` : ''}`, ''];
  if (brief?.headline) lines.push(brief.headline, '');
  if (fit?.ranked?.length) lines.push(`Fit ${fit.score}/100. Name these companies (Qloo affinity for your customers):`, ...fit.ranked.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} (${(r.affinity ?? 0).toFixed(2)})`), '');
  if (brief?.openers?.length) lines.push('Open with:', ...brief.openers.map(o => `- "${o.line}"`), '');
  if (brief?.deck?.length) lines.push('Fix the deck:', ...brief.deck.map(t => `- ${t}`), '');
  if (brief?.questions?.length) lines.push('They will ask:', ...brief.questions.map(t => `- ${t}`), '');
  if (dossier.sources?.length) lines.push('Sources:', ...dossier.sources.map(s => `- ${s.url}`));
  return tidy(lines.join('\n'));
}

const preset = new URLSearchParams(location.search);
if (preset.get('investor')) { $('investor').value = preset.get('investor'); $('firm').value = preset.get('firm') || ''; $('startup').value = preset.get('startup') || ''; $('comps').value = preset.get('comps') || ''; if ($('startup').value && $('comps').value) run(); }
// Deep link to a judge's recorded brief, e.g. /?demo=calacanis
const linked = preset.get('demo');
if (linked) [...document.querySelectorAll('[data-i]')].find(b => b.dataset.i.toLowerCase().endsWith(linked))?.click();
