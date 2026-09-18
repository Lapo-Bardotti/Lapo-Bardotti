#!/usr/bin/env node
/**
 * Builds the cards rendered on the profile README.
 *
 * Contribution counts come from the public GraphQL API and always work.
 * Language and commit-type breakdowns need a token that can read the private
 * repositories: set a CARDS_TOKEN secret holding a classic PAT with `repo`
 * scope. Without it the stack card falls back to the curated list below and
 * the commit card is skipped, so nothing breaks.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const USER = process.env.GH_USER ?? 'Lapo-Bardotti';
const TOKEN = process.env.GH_TOKEN ?? '';
const START_YEAR = Number(process.env.GH_START_YEAR ?? 2019);
const OUT_DIR = process.env.CARDS_OUT
  ? (process.env.CARDS_OUT.endsWith('/') ? process.env.CARDS_OUT : `${process.env.CARDS_OUT}/`)
  : fileURLToPath(new URL('../assets/', import.meta.url));
const DAY = 86_400_000;

/* -------------------------------------------------------------- curated -- */
/* Numbers and labels the API cannot know. Edit by hand when they change. */

const IMPACT = {
  title: 'In production',
  note: 'LGPD compliant by design',
  rows: [
    { value: '1,000+', label: 'doctors on the platforms' },
    { value: '~200', label: 'consults per week' },
    { value: '4', label: 'countries served · BR · US · ES · IT' },
  ],
};

/* Shown only while CARDS_TOKEN is absent. Real percentages replace it once set. */
const STACK_FALLBACK = {
  title: 'Stack in production',
  rows: [
    ['Backend', 'Java · Spring Boot · Node'],
    ['Frontend', 'Next.js · React · React Native'],
    ['Data', 'PostgreSQL · MongoDB · Redis'],
    ['Infra', 'AWS · Docker · GitHub Actions'],
    ['AI', 'RAG · MCP · embedded agents'],
  ],
};

if (!TOKEN) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

const isoDay = (value) => new Date(value).toISOString().slice(0, 10);

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors, null, 2));
  return payload.data;
}

/* ----------------------------------------------------------------- data -- */

async function fetchContributions() {
  const now = new Date();
  const years = [];
  for (let y = START_YEAR; y <= now.getUTCFullYear(); y += 1) years.push(y);

  const perYear = years
    .map((y) => {
      const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
      const to = (end > now ? now : end).toISOString();
      return `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") {
        restrictedContributionsCount
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
      }`;
    })
    .join('\n');

  const data = await graphql(
    `query ($login: String!) {
      user(login: $login) {
        name
        rolling: contributionsCollection {
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount weekday } }
          }
        }
        ${perYear}
      }
    }`,
    { login: USER },
  );
  return { user: data.user, years };
}

/**
 * Languages and commit types across every repository the token can reach.
 * Returns null when the token is not the profile owner's, which is the case
 * for the default GITHUB_TOKEN.
 */
async function fetchInsights() {
  const { viewer } = await graphql('query { viewer { login id } }');
  if (viewer.login.toLowerCase() !== USER.toLowerCase()) {
    return { available: false, reason: `token belongs to ${viewer.login}, not ${USER}` };
  }

  const data = await graphql(
    `query ($id: ID!) {
      viewer {
        repositories(
          first: 60
          ownerAffiliations: [OWNER, COLLABORATOR]
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            nameWithOwner
            isPrivate
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name } }
            }
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 100, author: { id: $id }) { nodes { messageHeadline } }
                }
              }
            }
          }
        }
      }
    }`,
    { id: viewer.id },
  );

  const repos = data.viewer.repositories.nodes;
  const bytes = new Map();
  const kinds = new Map();
  let commitsRead = 0;

  for (const repo of repos) {
    for (const edge of repo.languages?.edges ?? []) {
      bytes.set(edge.node.name, (bytes.get(edge.node.name) ?? 0) + edge.size);
    }
    for (const commit of repo.defaultBranchRef?.target?.history?.nodes ?? []) {
      const headline = commit.messageHeadline;
      if (/^merge\b/i.test(headline)) continue; // merge commits say nothing about the work
      commitsRead += 1;
      const match = headline.match(/^(feat|fix|chore|docs|refactor|test|style|perf|build|ci)\b/i);
      const kind = match ? match[1].toLowerCase() : 'other';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }

  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0);
  return {
    available: true,
    privateRepos: repos.filter((r) => r.isPrivate).length,
    totalRepos: repos.length,
    commitsRead,
    languages: [...bytes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, size]) => ({ name, share: size / Math.max(1, totalBytes) })),
    commitKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function shape({ user, years }) {
  const rolling = user.rolling;
  const weeks = rolling.contributionCalendar.weeks;
  const rollingDays = weeks.flatMap((w) => w.contributionDays);

  const byDate = new Map();
  for (const y of years) {
    for (const w of user[`y${y}`]?.contributionCalendar.weeks ?? []) {
      for (const d of w.contributionDays) byDate.set(d.date, d.contributionCount);
    }
  }
  for (const d of rollingDays) byDate.set(d.date, d.contributionCount);

  const lifetimeTotal = years.reduce(
    (acc, y) => acc + (user[`y${y}`]?.contributionCalendar.totalContributions ?? 0),
    0,
  );

  const dates = [...byDate.keys()].sort();
  let longestStreak = 0;
  let run = 0;
  for (let t = Date.parse(dates[0]); t <= Date.parse(dates.at(-1)); t += DAY) {
    if ((byDate.get(isoDay(t)) ?? 0) > 0) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 0;
    }
  }

  return {
    weeks,
    rollingTotal: rolling.contributionCalendar.totalContributions,
    rollingPrivate: rolling.restrictedContributionsCount,
    activeDays: rollingDays.filter((d) => d.contributionCount > 0).length,
    trackedDays: rollingDays.length,
    longestStreak,
    lifetimeTotal,
    since: START_YEAR,
  };
}

/* --------------------------------------------------------------- design -- */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const R = 16;
const PAD = 22;

// The profile README renders in an 846px column, narrower than a repo README.
// Two half cards plus the inline space between them must fit inside it or the
// browser wraps them onto separate lines; the slack absorbs zoom differences.
const W = 840;
const HALF = 415;
const GAP = 14;

const STYLE = `<style>
    :root{
      --bg:#ffffff; --fg:#0f172a; --muted:#6b7688;
      --glass-a:rgba(15,23,42,.055); --glass-b:rgba(15,23,42,.012);
      --line:rgba(15,23,42,.10); --spec:rgba(255,255,255,.95);
      --empty:rgba(15,23,42,.065); --grid:rgba(15,23,42,.07);
      --track:rgba(15,23,42,.06);
      --a1:#4f7cf7; --a2:#8b5cf6; --blob:.16; --shadow:.07;
    }
    @media (prefers-color-scheme:dark){
      :root{
        --bg:#0b0e13; --fg:#e7eaf0; --muted:#8a94a6;
        --glass-a:rgba(255,255,255,.072); --glass-b:rgba(255,255,255,.018);
        --line:rgba(255,255,255,.10); --spec:rgba(255,255,255,.55);
        --empty:rgba(255,255,255,.062); --grid:rgba(255,255,255,.06);
        --track:rgba(255,255,255,.06);
        --a1:#7aa2f7; --a2:#a78bfa; --blob:.30; --shadow:.5;
      }
    }
    text{font-family:${FONT};text-rendering:geometricPrecision}
    .bg{fill:var(--bg)}
    .hair{fill:none;stroke:var(--line);stroke-width:1}
    .spec{fill:none;stroke:url(#specG);stroke-width:1}
    .track{fill:var(--track)}
    .ga{stop-color:var(--glass-a)} .gb{stop-color:var(--glass-b)}
    .c1{stop-color:var(--a1)} .c2{stop-color:var(--a2)}
    .blob1{fill:var(--a1)} .blob2{fill:var(--a2)}
    .key{font-size:10px;font-weight:600;letter-spacing:.1em;fill:var(--muted)}
    .val{font-size:26px;font-weight:600;letter-spacing:-.02em;fill:var(--fg)}
    .big{font-size:21px;font-weight:600;letter-spacing:-.02em;fill:var(--fg)}
    .sub{font-size:11px;font-weight:400;fill:var(--muted)}
    .ttl{font-size:12.5px;font-weight:600;letter-spacing:-.01em;fill:var(--fg)}
    .row{font-size:11.5px;font-weight:500;fill:var(--fg)}
    .tick{font-size:9.5px;font-weight:500;fill:var(--muted)}
    .l0{fill:var(--empty)}
    .l1{fill:var(--a1);opacity:.30}
    .l2{fill:var(--a1);opacity:.55}
    .l3{fill:var(--a1);opacity:.80}
    .l4{fill:var(--a2);opacity:.95}
    .s0{fill:var(--a1)}
    .s1{fill:var(--a1);opacity:.74}
    .s2{fill:var(--a1);opacity:.5}
    .s3{fill:var(--a2);opacity:.88}
    .s4{fill:var(--a2);opacity:.62}
    .s5{fill:var(--a2);opacity:.42}
    .s6{fill:var(--muted);opacity:.34}
  </style>`;

const DEFS = `<defs>
    <linearGradient id="glassG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="ga"/><stop offset="1" class="gb"/>
    </linearGradient>
    <linearGradient id="specG" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--spec)" stop-opacity="0"/>
      <stop offset=".5" stop-color="var(--spec)" stop-opacity=".7"/>
      <stop offset="1" stop-color="var(--spec)" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="accG" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" class="c1"/><stop offset="1" class="c2"/>
    </linearGradient>
    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
    <filter id="drop" x="-20%" y="-30%" width="140%" height="180%">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#0b1020" flood-opacity="var(--shadow)"/>
    </filter>
  </defs>`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const n = (v) => v.toLocaleString('en-US');
const round = (v) => Number(v.toFixed(2));

/** A sheet of liquid glass: shadow, refracted light, surface, hairline, specular edge. */
function glass(x, y, w, h, blobs, id) {
  const lights = blobs
    .map((b) => `<circle cx="${round(x + w * b.x)}" cy="${round(y + h * b.y)}" r="${b.r}" class="${b.c}" opacity="var(--blob)"/>`)
    .join('');
  return `<g filter="url(#drop)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${R}" class="bg"/></g>
  <clipPath id="clip${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${R}"/></clipPath>
  <g clip-path="url(#clip${id})">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" class="bg"/>
    <g filter="url(#soft)">${lights}</g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#glassG)"/>
  </g>
  <rect x="${round(x + 0.5)}" y="${round(y + 0.5)}" width="${w - 1}" height="${h - 1}" rx="${R - 0.5}" class="hair"/>
  <path d="M ${x + R} ${round(y + 0.5)} H ${x + w - R}" class="spec"/>`;
}

const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  ${STYLE}
  ${DEFS}
${body}
</svg>
`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------------------------------------------------------------- cards -- */

function summaryCard(d, insights) {
  const h = 116;
  const tw = (W - GAP * 3) / 4;
  const fourth = insights?.available
    ? { k: 'REPOSITORIES', v: n(insights.totalRepos), s: `${n(insights.privateRepos)} of them private` }
    : { k: `SINCE ${d.since}`, v: n(d.lifetimeTotal), s: 'contributions total' };
  const tiles = [
    { k: 'CONTRIBUTIONS', v: n(d.rollingTotal), s: 'last 12 months' },
    { k: 'ACTIVE DAYS', v: n(d.activeDays), s: `of ${d.trackedDays} tracked` },
    { k: 'LONGEST STREAK', v: n(d.longestStreak), s: 'consecutive days' },
    fourth,
  ];
  const body = tiles
    .map((t, i) => {
      const x = i * (tw + GAP);
      const blobs = [
        { x: 0.18, y: 0.1, r: 60, c: 'blob1' },
        { x: 0.86, y: 1.0, r: 52, c: 'blob2' },
      ];
      return `${glass(x, 0, tw, h, blobs, `s${i}`)}
  <text x="${x + PAD}" y="30" class="key">${esc(t.k)}</text>
  <text x="${x + PAD}" y="68" class="val">${esc(t.v)}</text>
  <text x="${x + PAD}" y="89" class="sub">${esc(t.s)}</text>`;
    })
    .join('\n');
  return svg(W, h, body, `${n(d.rollingTotal)} contributions in the last 12 months`);
}

function calendarCard(d) {
  const h = 222;
  const cell = 12;
  const step = cell + 3;
  const left = PAD + 22;
  const top = 78;

  const counts = d.weeks.flatMap((w) => w.contributionDays).map((x) => x.contributionCount).filter((c) => c > 0);
  const sorted = [...counts].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 1;
  const [t1, t2, t3] = [q(0.25), q(0.55), q(0.82)];
  const level = (c) => (c === 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4);

  const cells = [];
  const marks = [];
  let lastMonth = '';
  d.weeks.forEach((week, wi) => {
    const first = week.contributionDays[0];
    if (first) {
      const month = first.date.slice(0, 7);
      const isFirst = wi === 0 && lastMonth === '';
      if (month !== lastMonth && (isFirst || Number(first.date.slice(8, 10)) <= 7) && wi < d.weeks.length - 1) {
        marks.push({ x: left + wi * step, label: MONTHS[Number(first.date.slice(5, 7)) - 1] });
        lastMonth = month;
      }
    }
    for (const day of week.contributionDays) {
      cells.push(
        `<rect x="${left + wi * step}" y="${top + day.weekday * step}" width="${cell}" height="${cell}" rx="3" class="l${level(day.contributionCount)}"><title>${day.date}: ${day.contributionCount}</title></rect>`,
      );
    }
  });

  const dayLabels = [1, 3, 5]
    .map((i) => `<text x="${PAD}" y="${top + i * step + 9.5}" class="tick">${['S', 'M', 'T', 'W', 'T', 'F', 'S'][i]}</text>`)
    .join('');

  const legendX = W - PAD - 112;
  const legendY = h - 27;
  const legend = [0, 1, 2, 3, 4]
    .map((l, i) => `<rect x="${legendX + i * 16}" y="${legendY}" width="${cell}" height="${cell}" rx="3" class="l${l}"/>`)
    .join('');

  const pct = Math.floor((d.rollingPrivate / Math.max(1, d.rollingTotal)) * 100);
  const blobs = [
    { x: 0.08, y: 0.15, r: 110, c: 'blob1' },
    { x: 0.55, y: 1.05, r: 95, c: 'blob2' },
    { x: 0.95, y: 0.1, r: 85, c: 'blob1' },
  ];

  const body = `${glass(0, 0, W, h, blobs, 'cal')}
  <text x="${PAD}" y="30" class="ttl">Contribution activity</text>
  <text x="${PAD}" y="48" class="sub">${n(d.rollingPrivate)} of ${n(d.rollingTotal)} contributions (${pct}%) live in private repositories</text>
  ${dayLabels}
  ${marks.map((m) => `<text x="${m.x}" y="${top - 8}" class="tick">${m.label}</text>`).join('')}
  ${cells.join('\n  ')}
  <text x="${legendX - 9}" y="${legendY + 9.5}" class="tick" text-anchor="end">Less</text>
  ${legend}
  <text x="${legendX + 85}" y="${legendY + 9.5}" class="tick">More</text>`;
  return svg(W, h, body, 'Contribution calendar');
}

function impactCard() {
  const h = 206;
  const blobs = [
    { x: 0.15, y: 0.12, r: 78, c: 'blob2' },
    { x: 0.9, y: 1.0, r: 66, c: 'blob1' },
  ];
  const rows = IMPACT.rows
    .map((r, i) => {
      const y = 82 + i * 41;
      return `<text x="${PAD}" y="${y}" class="big">${esc(r.value)}</text>
  <text x="${PAD}" y="${y + 17}" class="sub">${esc(r.label)}</text>`;
    })
    .join('\n  ');
  const body = `${glass(0, 0, HALF, h, blobs, 'imp')}
  <text x="${PAD}" y="30" class="ttl">${esc(IMPACT.title)}</text>
  <text x="${PAD}" y="48" class="sub">${esc(IMPACT.note)}</text>
  ${rows}`;
  return svg(HALF, h, body, 'Production impact');
}

function stackCard(insights) {
  const h = 206;
  const blobs = [
    { x: 0.12, y: 0.1, r: 72, c: 'blob1' },
    { x: 0.88, y: 1.02, r: 70, c: 'blob2' },
  ];

  if (!insights?.available || insights.languages.length === 0) {
    const rows = STACK_FALLBACK.rows
      .map(([label, value], i) => {
        const y = 80 + i * 24;
        return `<text x="${PAD}" y="${y}" class="key">${esc(label.toUpperCase())}</text>
  <text x="${PAD + 74}" y="${y}" class="row">${esc(value)}</text>`;
      })
      .join('\n  ');
    const body = `${glass(0, 0, HALF, h, blobs, 'stk')}
  <text x="${PAD}" y="30" class="ttl">${esc(STACK_FALLBACK.title)}</text>
  <text x="${PAD}" y="48" class="sub">declared, not measured</text>
  ${rows}`;
    return svg(HALF, h, body, 'Stack in production');
  }

  const barX = 108;
  const barW = HALF - PAD - 44 - barX;
  const rows = insights.languages
    .map((lang, i) => {
      const y = 76 + i * 21;
      const w = Math.max(3, lang.share * barW);
      return `<text x="${PAD}" y="${y + 8}" class="row">${esc(lang.name)}</text>
  <rect x="${barX}" y="${y}" width="${barW}" height="8" rx="4" class="track"/>
  <rect x="${barX}" y="${y}" width="${round(w)}" height="8" rx="4" fill="url(#accG)"/>
  <text x="${HALF - PAD}" y="${y + 8}" class="tick" text-anchor="end">${(lang.share * 100).toFixed(1)}%</text>`;
    })
    .join('\n  ');

  const body = `${glass(0, 0, HALF, h, blobs, 'stk')}
  <text x="${PAD}" y="30" class="ttl">Languages by volume</text>
  <text x="${PAD}" y="48" class="sub">across ${n(insights.totalRepos)} repositories, ${n(insights.privateRepos)} of them private</text>
  ${rows}`;
  return svg(HALF, h, body, 'Languages by volume');
}

function commitsCard(insights) {
  const h = 140;
  // Unprefixed commits say nothing about the kind of work, so they set the
  // coverage line rather than swallowing the chart as a giant "other" slice.
  const prefixed = insights.commitKinds.filter(([kind]) => kind !== 'other').slice(0, 8);
  const gross = prefixed.reduce((a, [, c]) => a + c, 0);
  // a slice that rounds to 0% is a legend entry nobody can see in the bar
  const classified = prefixed.filter(([, c]) => c / Math.max(1, gross) >= 0.01);
  const total = classified.reduce((a, [, c]) => a + c, 0);
  if (!total) return null;
  const coverage = Math.round((total / Math.max(1, insights.commitsRead)) * 100);

  const barY = 74;
  const barW = W - PAD * 2;
  let cursor = PAD;
  const segments = [];
  const legend = [];
  let legendX = PAD;

  classified.forEach(([kind, count], i) => {
    const w = (count / total) * barW;
    segments.push(
      `<rect x="${round(cursor)}" y="${barY}" width="${round(Math.max(w, 1))}" height="14" class="s${i}"><title>${kind}: ${n(count)}</title></rect>`,
    );
    cursor += w;
    const pct = Math.round((count / total) * 100);
    legend.push(
      `<rect x="${round(legendX)}" y="${barY + 40}" width="9" height="9" rx="2.5" class="s${i}"/>
  <text x="${round(legendX + 14)}" y="${barY + 48}" class="tick">${esc(kind)} ${pct}%</text>`,
    );
    // 9px swatch + 5px gap, then the label at roughly 5.4px per character
    legendX += 14 + (kind.length + String(pct).length + 2) * 5.4 + 20;
  });

  const blobs = [
    { x: 0.1, y: 0.1, r: 90, c: 'blob1' },
    { x: 0.8, y: 1.05, r: 80, c: 'blob2' },
  ];
  const body = `${glass(0, 0, W, h, blobs, 'cmt')}
  <text x="${PAD}" y="30" class="ttl">What the commits are</text>
  <text x="${PAD}" y="48" class="sub">${n(total)} of ${n(insights.commitsRead)} commits carry a conventional prefix (${coverage}%), merges excluded</text>
  <clipPath id="clipBar"><rect x="${PAD}" y="${barY}" width="${barW}" height="14" rx="7"/></clipPath>
  <g clip-path="url(#clipBar)">${segments.join('')}</g>
  ${legend.join('\n  ')}`;
  return svg(W, h, body, 'Commit type breakdown');
}

/* ----------------------------------------------------------------- main -- */

const raw = await fetchContributions();
const data = shape(raw);

let insights = { available: false, reason: 'not attempted' };
try {
  insights = await fetchInsights();
} catch (error) {
  insights = { available: false, reason: error.message.slice(0, 120) };
}

await mkdir(OUT_DIR, { recursive: true });
const files = {
  'summary.svg': summaryCard(data, insights),
  'calendar.svg': calendarCard(data),
  'impact.svg': impactCard(),
  'stack.svg': stackCard(insights),
};
const commits = insights.available ? commitsCard(insights) : null;
if (commits) files['commits.svg'] = commits;

for (const [name, content] of Object.entries(files)) {
  await writeFile(new URL(name, `file://${OUT_DIR}`), content, 'utf8');
}
// cards that earlier versions produced and the README no longer references
for (const stale of ['activity.svg', 'weekday.svg']) {
  await rm(new URL(stale, `file://${OUT_DIR}`), { force: true });
}

console.log(
  [
    `user            ${USER}`,
    `rolling total   ${n(data.rollingTotal)} (${n(data.rollingPrivate)} private)`,
    `active days     ${data.activeDays}/${data.trackedDays}`,
    `longest streak  ${data.longestStreak}`,
    `lifetime        ${n(data.lifetimeTotal)} since ${data.since}`,
    insights.available
      ? `insights        ${insights.totalRepos} repos (${insights.privateRepos} private), ${insights.commitsRead} commits, ${insights.languages.length} languages`
      : `insights        unavailable — ${insights.reason}`,
    `wrote           ${Object.keys(files).join(', ')}`,
  ].join('\n'),
);
