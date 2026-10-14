// Builds the profile with Readme Atelier, then widens the data to private and
// org repositories (needs ATELIER_TOKEN: a classic PAT with `repo` + `read:org`)
// and renders the featured repo cards without links.
//
//   ATELIER_TOKEN=<pat> node scripts/build.mjs [--preview]

import fs from 'node:fs';
import path from 'node:path';
import {
  parseConfigYaml, fetchProfile, mergeReadme, makeCtx, resolveSocials,
  renderCard, renderCombined, THEMES, ASSET_DIR, START, END,
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

// --- one seamless panel -----------------------------------------------------
// Every card is stitched into a single SVG: one outer frame, hairline dividers,
// no gaps. GitHub cannot make parts of an image clickable, so the contact links
// sit right under the panel as separate buttons.

const W = 840;
const CELL = W / 2;
const theme = THEMES[cfg.theme];
const PAL = {
  light: { bg: '#f2f2f0', ink: '#262626', mid: '#6a6a6a' },
  dark: { bg: '#0f0f0f', ink: '#ececea', mid: '#9a9a96' },
};
// each card's own rounded border; the panel draws a shared frame instead
const CARD_BORDER = /<rect x="\.5" y="\.5" width="[\d.]+" height="[\d.]+" rx="5\.5"[^>]*\/>/g;
// the pair of hairlines the theme draws through big headlines (name, repo names)
const HEADLINE_RULES = /(?:<line [^>]*stroke-opacity="0\.16"\/>){2}(?=<g class="__rise">)/g;

function flat(card, w, scheme) {
  const pad = (w - card.w) / 2;
  const body = card.body.replace(CARD_BORDER, '').replace(HEADLINE_RULES, '');
  return {
    ...card, w, radius: 0,
    body: `<rect width="${w}" height="${card.h}" fill="${PAL[scheme].bg}"/>` +
      (pad ? `<g transform="translate(${pad} 0)">${body}</g>` : body),
  };
}

const blank = (h, scheme) => ({ w: CELL, h, title: '', fonts: [], body: `<rect width="${CELL}" height="${h}" fill="${PAL[scheme].bg}"/>` });

function panelRows(ctx, scheme) {
  const full = (c) => [flat(c, W, scheme)];
  const half = (a, b) => [flat(a, CELL, scheme), b ? flat(b, CELL, scheme) : blank(a.h, scheme)];
  const rows = [];
  for (const s of cfg.sections ?? []) {
    if (s === 'header') rows.push(full(theme.header(ctx)));
    if (s === 'stats') rows.push(half(theme.stats(ctx), theme.languages(ctx)));
    if (s === 'activity') rows.push(full(theme.activity(ctx)));
    if (s === 'repos') {
      const repos = ctx.p.repos.slice(0, 4).map((r) => theme.repo(ctx, r));
      for (let i = 0; i < repos.length; i += 2) rows.push(half(repos[i], repos[i + 1]));
    }
    if (s === 'stack' && cfg.stack?.length) rows.push(full(theme.stack(ctx)));
    if (s === 'footer') rows.push(full(theme.footer(ctx)));
  }
  return rows;
}
// --- contact strip -----------------------------------------------------------
// A row of the panel right under the header. Each button is its own image so it
// can be a link, which splits the panel into: header, strip, everything else.

const CONTACT = {
  linkedin: {
    label: 'Connect on LinkedIn',
    kind: 'LinkedIn', title: 'LinkedIn', blurb: 'Connect with me, say hi or follow along.',
    detail: (s) => `(/in/${s.label})`,
    color: { light: '#0A66C2', dark: '#3b8fe0' },
    path: 'M3 3h18v18H3zm3.3 7.2V18h2.5v-7.8zm1.2-3.9a1.4 1.4 0 1 0 0 2.9 1.4 1.4 0 0 0 0-2.9zM10.6 10.2V18h2.5v-4.1c0-1.1.2-2.1 1.6-2.1s1.4 1.3 1.4 2.2v4h2.5v-4.5c0-2.2-.5-3.9-3-3.9a2.6 2.6 0 0 0-2.4 1.3v-1.1z',
  },
  email: {
    label: null, // the address itself
    kind: 'Email', title: 'Email', blurb: 'For work, collaboration or just a question.',
    detail: (s) => `(${s.label})`,
    color: { light: theme.accent, dark: theme.accent },
    path: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h17A1.5 1.5 0 0 1 22 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5zm2.2.5L12 11.6 19.8 6zM20 8.1l-8 5.7-8-5.7V18h16z',
  },
};
const contacts = resolveSocials(cfg).filter((s) => CONTACT[s.kind]);
const R = 10; // outer corner radius
// strip goes under the header when the header leads, otherwise on top
const stripAfterHeader = contacts.length > 0 && cfg.sections?.[0] === 'header';

/** Closed outline of a w×h box (inset half a pixel) with only the chosen corners rounded. */
function outline(w, h, { tl = 0, tr = 0, br = 0, bl = 0 }) {
  const x0 = 0.5, y0 = 0.5, x1 = w - 0.5, y1 = h - 0.5;
  return `M${x0} ${y0 + tl}` + (tl ? `A${tl} ${tl} 0 0 1 ${x0 + tl} ${y0}` : '') +
    `H${x1 - tr}` + (tr ? `A${tr} ${tr} 0 0 1 ${x1} ${y0 + tr}` : '') +
    `V${y1 - br}` + (br ? `A${br} ${br} 0 0 1 ${x1 - br} ${y1}` : '') +
    `H${x0 + bl}` + (bl ? `A${bl} ${bl} 0 0 1 ${x0} ${y1 - bl}` : '') + 'Z';
}

/**
 * Border of one stacked piece. A piece with a neighbour above or below leaves that
 * edge out (the neighbour draws it) and keeps square corners on that side.
 */
function edges(w, h, { top, bottom }) {
  const rt = top ? R : 0, rb = bottom ? R : 0;
  if (top && bottom) return outline(w, h, { tl: rt, tr: rt, br: rb, bl: rb });
  const x0 = 0.5, x1 = w - 0.5, y0 = 0.5, y1 = h - 0.5;
  if (top) return `M${x0} ${h}V${y0 + rt}A${rt} ${rt} 0 0 1 ${x0 + rt} ${y0}H${x1 - rt}A${rt} ${rt} 0 0 1 ${x1} ${y0 + rt}V${h}`;
  if (bottom) return `M${x0} 0V${y1 - rb}A${rb} ${rb} 0 0 0 ${x0 + rb} ${y1}H${x1 - rb}A${rb} ${rb} 0 0 0 ${x1} ${y1 - rb}V0`;
  return `M${x0} 0V${h}M${x1} 0V${h}`;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// mirrors the theme's repo cards: label + arrow, headline, detail, meta row
function contactCard(s, i, scheme) {
  const k = PAL[scheme];
  const meta = CONTACT[s.kind];
  const n = contacts.length;
  const w = W / n;
  const h = 164;
  const r = stripAfterHeader ? 0 : R;
  const corners = { tl: i === 0 ? r : 0, tr: i === n - 1 ? r : 0 };
  const x = 29; // same inset as the half-width cards
  const big = 30;
  const base = 72;
  return {
    w, h, title: meta.label ?? s.label, fonts: ['sans400', 'sans600'],
    css: `.lab{font-family:'RA Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:10.5px;fill:${k.mid}}` +
      `.big{font-family:'RA Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;font-size:${big}px;letter-spacing:-.045em;fill:${k.ink}}` +
      `.s{font-family:'RA Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;fill:${k.ink}}`,
    body:
      `<path d="${outline(w, h, corners)}" fill="${k.bg}"/>` +
      // every card after the first leaves its left edge to the one before, so dividers stay single
      `<path d="${i > 0 ? outline(w, h, corners).replace(/Z$/, '') : outline(w, h, corners)}" stroke="${k.ink}" stroke-opacity=".16"/>` +
      `<text x="${x}" y="30" class="lab">(${meta.kind})</text>` +
      `<path d="M${w - 39} 30L${w - 30} 21M${w - 37} 21H${w - 30}V28" stroke="${k.ink}" stroke-width="1.4" fill="none" stroke-linecap="round"/>` +
      `<path transform="translate(${x} ${base - 22}) scale(.9167)" d="${meta.path}" fill="${meta.color[scheme]}"/>` +
      `<text x="${x + 32}" y="${base}" class="big">${esc(meta.title)}</text>` +
      `<text x="${x}" y="102" class="s">${esc(meta.blurb)}</text>` +
      `<text x="${x}" y="146" class="s" style="font-size:11.5px">${esc(meta.detail(s))}</text>`,
  };
}

// --- panel -------------------------------------------------------------------

/** One stacked piece of the panel; `top`/`bottom` say whether it is the outer edge there. */
async function renderPiece(rows, title, scheme, { top, bottom }) {
  const svg = await renderCombined(rows, title, W, 0);
  const H = rows.reduce((s, r) => s + Math.max(...r.map((c) => c.h)), 0);
  const { ink } = PAL[scheme];

  let lines = '';
  let y = 0;
  rows.forEach((row, i) => {
    const h = Math.max(...row.map((c) => c.h));
    if (row.length === 2)
      lines += `<line x1="${CELL}" x2="${CELL}" y1="${y}" y2="${y + h}" stroke="${ink}" stroke-opacity=".12"/>`;
    y += h;
    if (i < rows.length - 1)
      lines += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${ink}" stroke-opacity=".12"/>`;
  });
  const rt = top ? R : 0, rb = bottom ? R : 0;
  const frame = `<path d="${edges(W, H, { top, bottom })}" stroke="${ink}" stroke-opacity=".16"/>`;

  // clip everything to the frame, then draw the dividers on top
  const start = svg.indexOf('<svg x=');
  const end = svg.lastIndexOf('</svg>');
  return svg.slice(0, start) +
    `<clipPath id="panel-clip"><path d="${outline(W, H, { tl: rt, tr: rt, br: rb, bl: rb })}"/></clipPath>` +
    `<g clip-path="url(#panel-clip)">${svg.slice(start, end)}${lines}</g>${frame}</svg>`;
}

const assets = {};
const [primary, ...others] = theme.schemes;
const suffix = (scheme) => (scheme === primary ? '' : '-' + scheme);
for (const scheme of theme.schemes) {
  const ctx = makeCtx(profile, cfg, theme.accent, scheme);
  const rows = panelRows(ctx, scheme);
  const title = `${ctx.name} · GitHub profile`;
  if (stripAfterHeader) {
    assets[`${ASSET_DIR}/profile-header${suffix(scheme)}.svg`] = await renderPiece(rows.slice(0, 1), title, scheme, { top: true, bottom: false });
    assets[`${ASSET_DIR}/profile${suffix(scheme)}.svg`] = await renderPiece(rows.slice(1), title, scheme, { top: false, bottom: true });
  } else {
    assets[`${ASSET_DIR}/profile${suffix(scheme)}.svg`] = await renderPiece(rows, title, scheme, { top: !contacts.length, bottom: true });
  }
  for (const [i, s] of contacts.entries())
    assets[`${ASSET_DIR}/contact-${s.kind}${suffix(scheme)}.svg`] = await renderCard(contactCard(s, i, scheme), 'ct');
}

if (fs.existsSync(ASSET_DIR))
  for (const f of fs.readdirSync(ASSET_DIR)) if (f.endsWith('.svg')) fs.rmSync(path.join(ASSET_DIR, f));
fs.mkdirSync(ASSET_DIR, { recursive: true });
for (const [file, svg] of Object.entries(assets)) fs.writeFileSync(file, svg);

const pic = (name, attrs, alt) =>
  '<picture>' +
  others.map((s) => `<source media="(prefers-color-scheme: ${s})" srcset="./${ASSET_DIR}/${name}-${s}.svg"/>`).join('') +
  `<img src="./${ASSET_DIR}/${name}.svg" ${attrs} alt="${alt}"/></picture>`;

// every piece shares one paragraph with no whitespace between images;
// align="top" drops the inline baseline gap so they stack flush
const name = cfg.name || profile.name || profile.login;
const pct = +(100 / (contacts.length || 1)).toFixed(4);
const strip = contacts
  .map((s) => `<a href="${s.url}">${pic(`contact-${s.kind}`, `width="${pct}%" align="top"`, CONTACT[s.kind].label ?? s.label)}</a>`)
  .join('');
const pieces = [
  stripAfterHeader && pic('profile-header', 'width="100%" align="top"', name),
  strip,
  pic('profile', 'width="100%" align="top"', `${name} · GitHub profile`),
].filter(Boolean);
const block = [
  START,
  '<!-- Generated by scripts/build.mjs with Readme Atelier. Edit atelier.yml instead of this block. -->',
  '',
  `<p align="center">${pieces.join('<br>')}</p>`,
  '',
  END,
].join('\n');
const existing = fs.existsSync('README.md') ? fs.readFileSync('README.md', 'utf8') : null;
const readme = mergeReadme(existing, block);
fs.writeFileSync('README.md', readme);

if (process.argv.includes('--preview')) {
  const body = readme.replace(/<!--[\s\S]*?-->/g, '');
  // GitHub's own markdown stylesheet, so spacing between images matches the real page
  fs.writeFileSync('preview.html', `<!doctype html><html><head><meta charset="utf-8"><title>${cfg.username} · preview</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown.css"><style>
body{margin:0;background:#0d1117}
@media (prefers-color-scheme: light){body{background:#fff}}
main{max-width:880px;margin:32px auto;padding:24px;border:1px solid #30363d;border-radius:8px}
</style></head><body><main class="markdown-body">${body}</main></body></html>`);
}

console.log(`✓ profile for @${profile.login}: ${Object.keys(assets).length} cards, featured: ${profile.repos.map((r) => r.name).join(', ')}`);
