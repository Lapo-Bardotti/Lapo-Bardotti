#!/usr/bin/env node
/**
 * Builds the activity cards rendered on the profile README.
 * Data comes from the GitHub GraphQL API, output is static SVG in assets/.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const USER = process.env.GH_USER ?? 'Lapo-Bardotti';
const TOKEN = process.env.GH_TOKEN ?? '';
const START_YEAR = Number(process.env.GH_START_YEAR ?? 2019);
const OUT_DIR = fileURLToPath(new URL('../assets/', import.meta.url));
const DAY = 86_400_000;

if (!TOKEN) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

const isoDay = (value) => new Date(value).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ data -- */

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

  const query = `query ($login: String!) {
    user(login: $login) {
      name
      createdAt
      rolling: contributionsCollection {
        restrictedContributionsCount
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalRepositoryContributions
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount weekday } }
        }
      }
      ${perYear}
    }
  }`;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const payload = await res.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors, null, 2));
  return { user: payload.data.user, years };
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

  const sum = (key) => years.reduce((acc, y) => acc + (user[`y${y}`]?.[key] ?? 0), 0);
  const lifetimeTotal = years.reduce(
    (acc, y) => acc + (user[`y${y}`]?.contributionCalendar.totalContributions ?? 0),
    0,
  );

  // streaks over the full known history
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

  const today = isoDay(Date.now());
  let cursor = Date.parse(today);
  if ((byDate.get(today) ?? 0) === 0) cursor -= DAY; // today is still in progress
  let currentStreak = 0;
  while ((byDate.get(isoDay(cursor)) ?? 0) > 0) {
    currentStreak += 1;
    cursor -= DAY;
  }

  // weekday distribution across the rolling year
  const weekday = Array.from({ length: 7 }, () => 0);
  for (const d of rollingDays) weekday[d.weekday] += d.contributionCount;

  // the 12 most recent *complete* calendar months, so the running month
  // cannot show up as a cliff at the right edge of the chart
  const now = new Date();
  const months = [];
  for (let back = 12; back >= 1; back -= 1) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push([`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`, 0]);
  }
  const monthIndex = new Map(months.map(([key], i) => [key, i]));
  for (const [date, count] of byDate) {
    const slot = monthIndex.get(date.slice(0, 7));
    if (slot !== undefined) months[slot][1] += count;
  }

  return {
    name: user.name,
    weeks,
    rollingTotal: rolling.contributionCalendar.totalContributions,
    rollingPrivate: rolling.restrictedContributionsCount,
    activeDays: rollingDays.filter((d) => d.contributionCount > 0).length,
    trackedDays: rollingDays.length,
    busiestDay: rollingDays.reduce((best, d) => (d.contributionCount > best.contributionCount ? d : best)),
    currentStreak,
    longestStreak,
    lifetimeTotal,
    lifetimePrivate: sum('restrictedContributionsCount'),
    pullRequests: rolling.totalPullRequestContributions,
    repositories: rolling.totalRepositoryContributions,
    weekday,
    months,
    since: START_YEAR,
  };
}

/* ---------------------------------------------------------------- design -- */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const R = 16;
const PAD = 22;

const STYLE = `<style>
    :root{
      --bg:#ffffff; --fg:#0f172a; --muted:#6b7688;
      --glass-a:rgba(15,23,42,.055); --glass-b:rgba(15,23,42,.012);
      --line:rgba(15,23,42,.10); --spec:rgba(255,255,255,.95);
      --empty:rgba(15,23,42,.065); --grid:rgba(15,23,42,.07);
      --a1:#4f7cf7; --a2:#8b5cf6; --blob:.16; --shadow:.07;
    }
    @media (prefers-color-scheme:dark){
      :root{
        --bg:#0b0e13; --fg:#e7eaf0; --muted:#8a94a6;
        --glass-a:rgba(255,255,255,.072); --glass-b:rgba(255,255,255,.018);
        --line:rgba(255,255,255,.10); --spec:rgba(255,255,255,.55);
        --empty:rgba(255,255,255,.062); --grid:rgba(255,255,255,.06);
        --a1:#7aa2f7; --a2:#a78bfa; --blob:.30; --shadow:.5;
      }
    }
    text{font-family:${FONT};text-rendering:geometricPrecision}
    .bg{fill:var(--bg)}
    .hair{fill:none;stroke:var(--line);stroke-width:1}
    .grid{fill:none;stroke:var(--grid);stroke-width:1}
    .spec{fill:none;stroke:url(#specG);stroke-width:1}
    .ga{stop-color:var(--glass-a)} .gb{stop-color:var(--glass-b)}
    .c1{stop-color:var(--a1)} .c2{stop-color:var(--a2)}
    .blob1{fill:var(--a1)} .blob2{fill:var(--a2)}
    .key{font-size:10px;font-weight:600;letter-spacing:.1em;fill:var(--muted)}
    .val{font-size:26px;font-weight:600;letter-spacing:-.02em;fill:var(--fg)}
    .sub{font-size:11px;font-weight:400;fill:var(--muted)}
    .ttl{font-size:12.5px;font-weight:600;letter-spacing:-.01em;fill:var(--fg)}
    .tick{font-size:9.5px;font-weight:500;fill:var(--muted)}
    .l0{fill:var(--empty)}
    .l1{fill:var(--a1);opacity:.30}
    .l2{fill:var(--a1);opacity:.55}
    .l3{fill:var(--a1);opacity:.80}
    .l4{fill:var(--a2);opacity:.95}
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
    <linearGradient id="areaG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="c1" stop-opacity=".45"/>
      <stop offset="1" class="c1" stop-opacity="0"/>
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

/** A single sheet of liquid glass: shadow, refracted light, surface, hairline, specular edge. */
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

/* ----------------------------------------------------------------- cards -- */

// sized for the profile README column, which is narrower than a repo README;
// the two half cards plus one inline space must stay under it or they wrap
const W = 856;
const HALF = 425;
const GAP = 14;

function summaryCard(d) {
  const h = 116;
  const tw = (W - GAP * 3) / 4;
  const tiles = [
    { k: 'CONTRIBUTIONS', v: n(d.rollingTotal), s: 'last 12 months' },
    { k: 'ACTIVE DAYS', v: n(d.activeDays), s: `of ${d.trackedDays} tracked` },
    { k: 'LONGEST STREAK', v: n(d.longestStreak), s: 'consecutive days' },
    { k: 'SINCE ' + d.since, v: n(d.lifetimeTotal), s: 'contributions total' },
  ];
  const body = tiles
    .map((t, i) => {
      const x = i * (tw + GAP);
      const blobs = [
        { x: 0.18, y: 0.1, r: 60, c: 'blob1' },
        { x: 0.86, y: 1.0, r: 52, c: 'blob2' },
      ];
      return `${glass(x, 0, tw, h, blobs, `s${i}`)}
  <text x="${x + PAD}" y="${30}" class="key">${esc(t.k)}</text>
  <text x="${x + PAD}" y="${68}" class="val">${esc(t.v)}</text>
  <text x="${x + PAD}" y="${89}" class="sub">${esc(t.s)}</text>`;
    })
    .join('\n');
  return svg(W, h, body, `${n(d.rollingTotal)} contributions in the last 12 months`);
}

function calendarCard(d) {
  const h = 222;
  const cell = 12;
  const gap = 3;
  const step = cell + gap;
  const left = PAD + 22;
  const top = 78;

  const counts = d.weeks.flatMap((w) => w.contributionDays).map((x) => x.contributionCount).filter((c) => c > 0);
  const sorted = [...counts].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 1;
  const t1 = q(0.25);
  const t2 = q(0.55);
  const t3 = q(0.82);
  const level = (c) => (c === 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4);

  const cells = [];
  const monthMarks = [];
  let lastMonth = '';
  d.weeks.forEach((week, wi) => {
    const first = week.contributionDays[0];
    if (first) {
      const month = first.date.slice(0, 7);
      const mm = Number(first.date.slice(5, 7));
      const isFirst = wi === 0 && lastMonth === '';
      if (month !== lastMonth && (isFirst || Number(first.date.slice(8, 10)) <= 7) && wi < d.weeks.length - 1) {
        monthMarks.push({ x: left + wi * step, label: MONTHS[mm - 1] });
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

  // floor, so 2,651 of 2,653 never reads as a flat 100%
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
  ${monthMarks.map((m) => `<text x="${m.x}" y="${top - 8}" class="tick">${m.label}</text>`).join('')}
  ${cells.join('\n  ')}
  <text x="${legendX - 9}" y="${legendY + 9.5}" class="tick" text-anchor="end">Less</text>
  ${legend}
  <text x="${legendX + 85}" y="${legendY + 9.5}" class="tick">More</text>`;
  return svg(W, h, body, 'Contribution calendar');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function smooth(pts) {
  let d = `M ${round(pts[0][0])} ${round(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C ${round(p1[0] + (p2[0] - p0[0]) / 6)} ${round(p1[1] + (p2[1] - p0[1]) / 6)}, ${round(p2[0] - (p3[0] - p1[0]) / 6)} ${round(p2[1] - (p3[1] - p1[1]) / 6)}, ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

function activityCard(d) {
  const h = 206;
  const x0 = PAD;
  const x1 = HALF - PAD;
  const yTop = 74;
  const yBot = h - 34;
  const values = d.months.map(([, v]) => v);
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [
    x0 + (i * (x1 - x0)) / Math.max(1, values.length - 1),
    yBot - (v / max) * (yBot - yTop),
  ]);
  const line = smooth(pts);
  const area = `${line} L ${round(pts.at(-1)[0])} ${yBot} L ${round(pts[0][0])} ${yBot} Z`;
  const peak = values.indexOf(max);

  const ticks = d.months
    .map(([key], i) =>
      i % 3 === 0
        ? `<text x="${round(pts[i][0])}" y="${h - 16}" class="tick" text-anchor="middle">${MONTHS[Number(key.slice(5, 7)) - 1]}</text>`
        : '',
    )
    .join('');

  const blobs = [
    { x: 0.15, y: 0.12, r: 78, c: 'blob1' },
    { x: 0.9, y: 1.0, r: 66, c: 'blob2' },
  ];

  const body = `${glass(0, 0, HALF, h, blobs, 'act')}
  <text x="${PAD}" y="30" class="ttl">Monthly rhythm</text>
  <text x="${PAD}" y="48" class="sub">peak of ${n(max)} in ${MONTHS[Number(d.months[peak][0].slice(5, 7)) - 1]}</text>
  <clipPath id="clipArea"><rect x="0" y="${yTop - 10}" width="${HALF}" height="${yBot - yTop + 10}"/></clipPath>
  <path d="M ${x0} ${yBot} H ${x1}" class="grid"/>
  <g clip-path="url(#clipArea)">
    <path d="${area}" fill="url(#areaG)"/>
    <path d="${line}" fill="none" stroke="url(#accG)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <circle cx="${round(pts[peak][0])}" cy="${round(pts[peak][1])}" r="3" fill="var(--a2)"/>
  <circle cx="${round(pts[peak][0])}" cy="${round(pts[peak][1])}" r="6" fill="none" stroke="var(--a2)" stroke-width="1" opacity=".45"/>
  ${ticks}`;
  return svg(HALF, h, body, 'Monthly contribution rhythm');
}

function weekdayCard(d) {
  const h = 206;
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const max = Math.max(...d.weekday, 1);
  const best = d.weekday.indexOf(max);
  const yBot = h - 34;
  const yTop = 78;
  const slot = (HALF - PAD * 2) / 7;
  const bw = 16;

  const bars = d.weekday
    .map((v, i) => {
      const bh = Math.max(3, (v / max) * (yBot - yTop));
      const x = PAD + i * slot + (slot - bw) / 2;
      return `<rect x="${round(x)}" y="${round(yBot - bh)}" width="${bw}" height="${round(bh)}" rx="5" fill="${i === best ? 'url(#accG)' : 'var(--a1)'}" opacity="${i === best ? 1 : 0.34}"><title>${full[i]}: ${n(v)}</title></rect>
  <text x="${round(x + bw / 2)}" y="${h - 16}" class="tick" text-anchor="middle">${labels[i]}</text>`;
    })
    .join('\n  ');

  const blobs = [
    { x: 0.12, y: 0.1, r: 72, c: 'blob2' },
    { x: 0.88, y: 1.02, r: 70, c: 'blob1' },
  ];

  const body = `${glass(0, 0, HALF, h, blobs, 'wd')}
  <text x="${PAD}" y="30" class="ttl">Weekly shape</text>
  <text x="${PAD}" y="48" class="sub">${full[best]} carries the most work</text>
  <path d="M ${PAD} ${yBot} H ${HALF - PAD}" class="grid"/>
  ${bars}`;
  return svg(HALF, h, body, 'Contributions by weekday');
}

/* ------------------------------------------------------------------ main -- */

const raw = await fetchContributions();
const data = shape(raw);

await mkdir(OUT_DIR, { recursive: true });
const files = {
  'summary.svg': summaryCard(data),
  'calendar.svg': calendarCard(data),
  'activity.svg': activityCard(data),
  'weekday.svg': weekdayCard(data),
};
for (const [name, content] of Object.entries(files)) {
  await writeFile(new URL(name, `file://${OUT_DIR}`), content, 'utf8');
}

console.log(
  [
    `user            ${USER}`,
    `rolling total   ${n(data.rollingTotal)} (${n(data.rollingPrivate)} private)`,
    `active days     ${data.activeDays}/${data.trackedDays}`,
    `current streak  ${data.currentStreak}`,
    `longest streak  ${data.longestStreak}`,
    `lifetime        ${n(data.lifetimeTotal)} since ${data.since}`,
    `busiest day     ${data.busiestDay.date} (${data.busiestDay.contributionCount})`,
    `wrote           ${Object.keys(files).join(', ')}`,
  ].join('\n'),
);
