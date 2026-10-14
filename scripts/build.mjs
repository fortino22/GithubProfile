// Builds the profile with Readme Atelier, then widens the data to private and
// org repositories (needs ATELIER_TOKEN: a classic PAT with `repo` + `read:org`)
// and renders the featured repo cards without links.
//
//   ATELIER_TOKEN=<pat> node scripts/build.mjs [--preview]

import fs from 'node:fs';
import path from 'node:path';
import {
  parseConfigYaml, fetchProfile, buildAssets, readmeBlock, mergeReadme, ASSET_DIR,
} from 'readme-atelier';

const token = process.env.ATELIER_TOKEN || process.env.GITHUB_TOKEN;
const cfg = parseConfigYaml(fs.readFileSync('atelier.yml', 'utf8'));
const featured = cfg.repos ?? [];
delete cfg.repos; // picked below, from every repo the token can see

const REPOS = `query($cursor:String){
  viewer{
    login
    repositories(first:100, after:$cursor, isFork:false,
                 ownerAffiliations:[OWNER, ORGANIZATION_MEMBER, COLLABORATOR]){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{name description stargazerCount forkCount isArchived owner{login}
        primaryLanguage{name color}
        languages(first:8, orderBy:{field:SIZE, direction:DESC}){edges{size node{name color}}}}
    }
  }
}`;

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'readme-atelier' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) throw new Error(json.errors?.[0]?.message || `GitHub API ${res.status}`);
  return json.data;
}

async function allRepos() {
  const out = [];
  let cursor = null;
  let login = '';
  let total = 0;
  do {
    const { viewer } = await graphql(REPOS, { cursor });
    login = viewer.login;
    total = viewer.repositories.totalCount;
    out.push(...viewer.repositories.nodes);
    cursor = viewer.repositories.pageInfo.hasNextPage ? viewer.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return { login, total, nodes: out };
}

function topLanguages(nodes) {
  const map = new Map();
  for (const r of nodes)
    for (const e of r.languages?.edges ?? []) {
      const cur = map.get(e.node.name) ?? { color: e.node.color || '#8b8b8b', size: 0 };
      cur.size += e.size;
      map.set(e.node.name, cur);
    }
  const sum = [...map.values()].reduce((s, v) => s + v.size, 0) || 1;
  return [...map.entries()]
    .map(([name, v]) => ({ name, color: v.color, pct: (v.size / sum) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
}

const toRepo = (n) => ({
  name: n.name,
  owner: n.owner?.login ?? '',
  description: n.description ?? '',
  stars: n.stargazerCount ?? 0,
  forks: n.forkCount ?? 0,
  language: n.primaryLanguage ? { name: n.primaryLanguage.name, color: n.primaryLanguage.color || '#8b8b8b' } : undefined,
  url: '', // no link on the card
});

if (!token) console.warn('! ATELIER_TOKEN not set: public data only');
const profile = await fetchProfile(cfg.username, { token });

let pool = profile.repos.map((r) => ({ ...r, url: '' }));
if (token) {
  const all = await allRepos();
  if (all.login.toLowerCase() !== cfg.username.toLowerCase())
    throw new Error(`ATELIER_TOKEN belongs to ${all.login}, not ${cfg.username}`);
  const live = all.nodes.filter((r) => !r.isArchived);
  profile.publicRepos = all.total;
  profile.languages = topLanguages(live);
  profile.stats.stars = live.reduce((s, r) => s + r.stargazerCount, 0);
  profile.stats.forks = live.reduce((s, r) => s + r.forkCount, 0);
  // own repos first, so a same-named org repo never shadows yours
  const me = cfg.username.toLowerCase();
  pool = live.sort((a, b) => (a.owner.login.toLowerCase() === me ? 0 : 1) - (b.owner.login.toLowerCase() === me ? 0 : 1)).map(toRepo);
}
// the GraphQL listing can miss repos reached through org teams; REST /user/repos sees them
async function restLookup(name) {
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`, {
      headers: { authorization: `bearer ${token}`, 'user-agent': 'readme-atelier' },
    });
    if (!res.ok) return;
    const list = await res.json();
    if (!list.length) return;
    const hit = list.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      const { repository } = await graphql(`query($o:String!,$n:String!){repository(owner:$o,name:$n){
        name description stargazerCount forkCount owner{login} primaryLanguage{name color}}}`, { o: hit.owner.login, n: hit.name });
      return toRepo(repository);
    }
  }
}

if (featured.length) {
  const picked = [];
  for (const n of featured) {
    const hit = pool.find((r) => r.name.toLowerCase() === n.toLowerCase()) ?? (token ? await restLookup(n) : undefined);
    if (!hit) console.warn(`! featured repo not found: ${n}`);
    picked.push(hit);
  }
  picked.splice(0, picked.length, ...picked.filter(Boolean));
  if (picked.length) profile.repos = picked;
}

const assets = await buildAssets(profile, cfg, ASSET_DIR);
if (fs.existsSync(ASSET_DIR))
  for (const f of fs.readdirSync(ASSET_DIR)) if (f.endsWith('.svg')) fs.rmSync(path.join(ASSET_DIR, f));
fs.mkdirSync(ASSET_DIR, { recursive: true });
for (const [file, svg] of Object.entries(assets)) fs.writeFileSync(file, svg);

// repo cards have an empty url: drop their <a> wrapper so they are not links
const block = readmeBlock(profile, cfg, { kind: 'files' }).replace(/<a href="">(<picture>[\s\S]*?<\/picture>)<\/a>/g, '$1');
const existing = fs.existsSync('README.md') ? fs.readFileSync('README.md', 'utf8') : null;
const readme = mergeReadme(existing, block);
fs.writeFileSync('README.md', readme);

if (process.argv.includes('--preview')) {
  const body = readme.replace(/<!--[\s\S]*?-->/g, '');
  fs.writeFileSync('preview.html', `<!doctype html><html><head><meta charset="utf-8"><title>${cfg.username} · preview</title><style>
body{margin:0;background:#0d1117;color:#e6edf3;font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme: light){body{background:#fff;color:#1f2328}}
main{max-width:880px;margin:32px auto;padding:24px;border:1px solid #30363d;border-radius:8px}
p{margin:0 0 16px} img{max-width:100%}
</style></head><body><main>${body}</main></body></html>`);
}

console.log(`✓ profile for @${profile.login}: ${Object.keys(assets).length} cards, featured: ${profile.repos.map((r) => r.name).join(', ')}`);
