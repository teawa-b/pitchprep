import { fetchJson } from './http.js';

export const qlooHosts = ['https://hackathon.api.qloo.com', 'https://api.qloo.com', 'https://staging.api.qloo.com'];

// Place tag namespaces (checked against live hackathon data) describing how a venue looks, feels and who it serves.
export const placeTagTypes = {
  ambience: 'urn:tag:ambience:qloo',
  customer_identity: 'urn:tag:customer_identity:qloo',
  decor: 'urn:tag:decor:qloo',
  age_range: 'urn:tag:age_range:qloo',
  interests: 'urn:tag:interests:qloo',
  cuisine: 'urn:tag:cuisine:qloo',
  culinary_style: 'urn:tag:culinary_style:qloo',
  beverage_offering: 'urn:tag:beverage_offering:qloo',
  menu_highlight: 'urn:tag:menu_highlight:qloo',
  dietary_option: 'urn:tag:dietary_option:qloo',
  time_of_day_fit: 'urn:tag:time_of_day_fit:qloo',
  neighborhood_characteristic: 'urn:tag:neighborhood_characteristic:qloo',
  setting: 'urn:tag:setting:qloo'
};
export const entityTypes = ['artist', 'brand', 'movie', 'tv_show', 'book', 'podcast', 'destination', 'person'];

export const point = ({ lat, lng }) => `POINT(${Number(lng).toFixed(6)} ${Number(lat).toFixed(6)})`;

export function tagList(data) {
  const r = data?.results;
  return (Array.isArray(r) ? r : r?.tags ?? data?.tags ?? []).map(t => ({
    id: t.tag_id || t.id, name: t.name, type: t.subtype || t.types?.[0] || t.type,
    affinity: t.query?.affinity ?? t.affinity, popularity: t.query?.popularity ?? t.popularity
  })).filter(t => t.id && t.name);
}

export function entityList(data) {
  const r = data?.results;
  return Array.isArray(r) ? r : r?.entities ?? data?.entities ?? [];
}

const round = n => typeof n === 'number' ? Math.round(n * 1000) / 1000 : undefined;

export function compactPlace(e) {
  const p = e.properties || {};
  return {
    name: e.name, id: e.entity_id, address: p.address, neighborhood: p.neighborhood,
    price_level: p.price_level, rating: p.business_rating, popularity: round(e.popularity),
    affinity: round(e.query?.affinity), distance_m: e.query?.distance ? Math.round(e.query.distance) : undefined,
    tags: (e.tags || []).map(t => t.name).filter(Boolean).slice(0, 10), image: p.image?.url
  };
}

// Qloo ranks only some tag types (e.g. ambience, customer identity) directly for a location.
// For the rest, rank the tags carried by the venues Qloo scores highest for local taste,
// weighting each venue by its rank so the most locally loved places count most.
export function rankVenueTags(entities, tagType) {
  const scores = new Map();
  entities.forEach((e, i) => {
    const weight = 1 / (1 + i * 0.15);
    for (const t of e.tags || []) {
      if ((t.type || t.subtype) !== tagType || !t.name) continue;
      const s = scores.get(t.name) || { name: t.name.trim(), id: t.id || t.tag_id, venues: 0, score: 0 };
      s.venues += 1; s.score += weight; scores.set(t.name, s);
    }
  });
  return [...scores.values()].sort((a, b) => b.score - a.score).map(s => ({ ...s, score: Math.round(s.score * 100) / 100 }));
}

export function compactEntity(e) {
  const p = e.properties || {};
  return {
    name: e.name, id: e.entity_id, type: (e.subtype || e.types?.[0] || '').split(':').pop(),
    popularity: round(e.popularity), affinity: round(e.query?.affinity),
    tags: (e.tags || []).map(t => t.name).filter(Boolean).slice(0, 6), image: p.image?.url,
    detail: e.disambiguation || p.short_description || ''
  };
}

export function createQloo({ key, host = qlooHosts[0], fetcher = fetch }) {
  if (!qlooHosts.includes(host)) throw new Error('Unsupported Qloo host.');
  const calls = [];
  async function get(route, params) {
    const url = new URL(route, host);
    url.search = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
    const started = Date.now();
    try {
      const data = await fetchJson(fetcher, url, { headers: { 'X-Api-Key': key, accept: 'application/json' } }, { label: 'Qloo', secrets: [key], timeout: 25000 });
      calls.push({ url: url.toString(), ms: Date.now() - started, ok: true });
      return data;
    } catch (error) {
      calls.push({ url: url.toString(), ms: Date.now() - started, ok: false, status: error.status });
      throw error;
    }
  }
  return {
    calls,
    get,
    async tags(query, tagType) {
      return tagList(await get('/v2/tags', { 'filter.query': query, 'filter.tag.types': tagType, take: '8' }));
    },
    async areaTags(where, tagType, take = 15) {
      const params = { 'filter.type': 'urn:tag', 'filter.parents.types': 'urn:entity:place', 'filter.tag.types': tagType, take: String(take), ...locationSignal(where) };
      return tagList(await get('/v2/insights', params)).map(t => ({ ...t, name: t.name.trim() }));
    },
    // The venues around a point that Qloo ranks highest for local taste, with their full tag sets.
    async localVenuePool(where, radius = 1500, take = 40) {
      const params = { 'filter.type': 'urn:entity:place', 'filter.location.radius': String(radius), take: String(take), ...locationSignal(where) };
      if (where.lat != null) params['filter.location'] = point(where); else params['filter.location.query'] = where.query;
      return entityList(await get('/v2/insights', params));
    },
    // Qloo's audience skew (age bands and gender, roughly -1..1) for entities and/or tags.
    async demographics({ entities = [], tags = [] }) {
      const params = { 'filter.type': 'urn:demographics', 'signal.interests.entities': entities.join(',') || undefined, 'signal.interests.tags': tags.join(',') || undefined };
      const data = await get('/v2/insights', params);
      return Object.fromEntries((data.results?.demographics || []).map(d => [d.entity_id, { age: d.query?.age || {}, gender: d.query?.gender || {} }]));
    },
    async places(where, { tagId, radius = 1200, priceMax, take = 10 } = {}) {
      const params = { 'filter.type': 'urn:entity:place', 'filter.tags': tagId, 'filter.location.radius': String(radius), take: String(take), 'filter.price_level.max': priceMax, ...locationSignal(where) };
      if (where.lat != null) params['filter.location'] = point(where);
      else params['filter.location.query'] = where.query;
      return entityList(await get('/v2/insights', params)).map(compactPlace);
    },
    async entities(where, type, { tagId, take = 10, seeds, popularityMax } = {}) {
      if (!entityTypes.includes(type)) throw new Error(`Unsupported entity type ${type}.`);
      const params = { 'filter.type': `urn:entity:${type}`, 'filter.tags': tagId, take: String(take), 'signal.interests.entities': seeds?.length ? seeds.join(',') : undefined, 'filter.popularity.max': popularityMax != null ? String(popularityMax) : undefined, ...locationSignal(where) };
      return entityList(await get('/v2/insights', params)).map(compactEntity);
    },
    // Resolve a name (a headliner, a team, a brand) to Qloo entities. Teams are brands in Qloo's graph.
    async search(query, type, take = 5) {
      const data = await get('/search', { query, types: type ? `urn:entity:${type}` : undefined, take: String(take) });
      return (data.results || []).map(e => ({ ...compactEntity(e), types: e.types }));
    },
    // Taste for an audience defined by interests (fans of an artist, a team, a brand) rather than a place.
    // Place tags (ambience, decor, cuisine…) describe the rooms that audience rates highest.
    async fanTags(signals, tagType, take = 12) {
      const params = { 'filter.type': 'urn:tag', 'filter.parents.types': 'urn:entity:place', 'filter.tag.types': tagType, 'signal.interests.entities': signals.join(','), take: String(take) };
      return tagList(await get('/v2/insights', params)).map(t => ({ ...t, name: t.name.trim() }));
    },
    // Cross-domain favourites of that audience. With explainability, each result says how much each
    // signal contributed, so a brand × fanbase run can tell shared loves from one-sided ones.
    async fanEntities(signals, type, { tagId, take = 10, explain = false, where, radius, popularityMax } = {}) {
      if (!entityTypes.includes(type) && type !== 'place') throw new Error(`Unsupported entity type ${type}.`);
      const params = { 'filter.type': `urn:entity:${type}`, 'filter.tags': tagId, take: String(take), 'signal.interests.entities': signals.join(','), 'feature.explainability': explain ? 'true' : undefined, 'filter.popularity.max': popularityMax != null ? String(popularityMax) : undefined };
      if (where?.lat != null) { params['filter.location'] = point(where); params['filter.location.radius'] = String(radius || 2000); }
      return entityList(await get('/v2/insights', params)).map(e => {
        const out = type === 'place' ? compactPlace(e) : compactEntity(e);
        const ex = e.query?.explainability?.['signal.interests.entities'];
        if (ex) out.share = Object.fromEntries(ex.map(x => [x.entity_id, Math.round(x.score * 100) / 100]));
        return out;
      });
    },
    // Where an audience over-indexes around a venue: a grid of points with affinity and popularity.
    // (Heatmap requests reject `take`; the grid size comes from the radius.)
    async heatmap(signals, where, radius = 12000) {
      const params = { 'filter.type': 'urn:heatmap', 'filter.location': point(where), 'filter.location.radius': String(radius), 'signal.interests.entities': signals.join(',') };
      const data = await get('/v2/insights', params);
      return (data.results?.heatmap || []).map(h => ({ lat: h.location.latitude, lng: h.location.longitude, affinity: round(h.query?.affinity), rank: round(h.query?.affinity_rank), popularity: round(h.query?.popularity) }));
    },
    // Score a fixed list of candidates for an audience: how much the people behind `signals` like each one.
    async rank(signals, type, candidates) {
      if (!candidates.length) return [];
      const params = { 'filter.type': `urn:entity:${type}`, 'signal.interests.entities': signals.join(','), 'filter.results.entities': candidates.join(','), take: String(Math.min(50, candidates.length)) };
      return entityList(await get('/v2/insights', params)).map(compactEntity);
    },
    // Qloo's own description of two audiences side by side (the tags that characterise each).
    async compare(a, b, take = 25) {
      const data = await get('/v2/analysis/compare', { 'a.signal.interests.entities': a.join(','), 'b.signal.interests.entities': b.join(','), take: String(take) });
      const side = list => (list || []).map(t => ({ id: t.tag_id, name: t.name, type: t.subtype })).filter(t => t.name);
      return { shared: side(data.results?.tags), a: side(data.results?.a), b: side(data.results?.b) };
    }
  };
}

function locationSignal(where) {
  if (where.lat != null && where.lng != null) return { 'signal.location': point(where) };
  if (where.query) return { 'signal.location.query': where.query };
  throw new Error('A location is required.');
}
