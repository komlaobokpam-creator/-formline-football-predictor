const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8765;
const API = 'https://footballdata.io/api/v1';
const ALLOWED = new Set(['PL', 'PD', 'BL1', 'SA', 'FL1']);
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

function readToken() {
  if (process.env.FOOTBALL_DATA_TOKEN) return process.env.FOOTBALL_DATA_TOKEN.trim();
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return '';
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find(x => x.startsWith('FOOTBALL_DATA_TOKEN='));
  return line ? line.slice('FOOTBALL_DATA_TOKEN='.length).trim() : '';
}

async function provider(pathname) {
  const cached = cache.get(pathname);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.body;
  const token = readToken();
  if (!token) throw Object.assign(new Error('The local football data key is not configured.'), { status: 503 });
  const response = await fetch(API + pathname, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let detail = '';
    try { const errorBody = await response.json(); detail = errorBody.error?.message || ''; } catch {}
    const status = response.status === 429 ? 429 : response.status;
    throw Object.assign(new Error(detail || (response.status === 429 ? 'The provider request limit was reached.' : `Footballdata.io returned ${response.status}. Check the key and league access.`)), { status });
  }
  const body = await response.json();
  cache.set(pathname, { time: Date.now(), body });
  return body;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function records(payload, key) {
  const candidates = [payload?.data, payload?.data?.[key], payload?.data?.data, payload?.data?.data?.[key], payload?.[key], payload?.response];
  return candidates.find(Array.isArray) || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/api/status') {
      const usage = await provider('/account/usage');
      return send(res, 200, { connected: true, provider: 'Footballdata.io', usage: usage.data || null });
    }
    if (url.pathname === '/') {
      const page = fs.readFileSync(path.join(ROOT, 'recent-form-predictor.html'), 'utf8');
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/leagues') {
      return send(res, 200, await provider('/leagues'));
    }
    if (url.pathname === '/api/seasons') {
      const league = url.searchParams.get('league_id');
      if (!/^\d+$/.test(league || '')) return send(res, 400, { error: 'Invalid league.' });
      return send(res, 200, await provider(`/seasons?league_id=${league}`));
    }
    if (url.pathname === '/api/teams') {
      const league = url.searchParams.get('league_id');
      const season = url.searchParams.get('season_id');
      if (!/^\d+$/.test(league || '') || !/^\d+$/.test(season || '')) return send(res, 400, { error: 'Invalid league or season.' });
      const payload = await provider(`/leagues/${league}/teams?season_id=${season}&limit=100`);
      const list = records(payload, 'teams');
      return send(res, 200, { teams: list.map(t => ({ id: t.team_id ?? t.id ?? t.team?.team_id ?? t.team?.id, name: t.team_name ?? t.name ?? t.team?.team_name ?? t.team?.name, shortName: t.short_name ?? t.team_name ?? t.name ?? t.team?.short_name ?? t.team?.team_name ?? t.team?.name, crest: t.team_logo ?? t.crest ?? t.team?.team_logo ?? t.team?.crest ?? '' })).filter(t => t.id != null && t.name) });
    }
    if (url.pathname === '/api/recent') {
      const team = url.searchParams.get('team_id');
      const competition = url.searchParams.get('league_id');
      const season = url.searchParams.get('season_id');
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 5));
      if (!/^\d+$/.test(team || '') || !/^\d+$/.test(competition || '') || !/^\d+$/.test(season || '')) return send(res, 400, { error: 'Invalid team, league, or season.' });
      const payload = await provider(`/fixtures/results?league_id=${competition}&season_id=${season}&team_id=${team}&limit=${limit}`);
      const list = records(payload, 'matches');
      const matches = list.filter(m => ['complete', 'finished', 'completed'].includes(String(m.status).toLowerCase()) && m.score?.home !== null && m.score?.away !== null).map(m => ({ id: m.match_id, status: 'complete', date: m.match_date, homeTeam: { id: m.home_team.team_id, name: m.home_team.team_name, shortName: m.home_team.short_name || m.home_team.team_name }, awayTeam: { id: m.away_team.team_id, name: m.away_team.team_name, shortName: m.away_team.short_name || m.away_team.team_name }, score: { fullTime: { home: Number(m.score.home), away: Number(m.score.away) } } }));
      return send(res, 200, { matches });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    return send(res, error.status || 502, { error: error.message || 'Unable to reach the football data provider.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Formline is ready on port ${PORT}`));
