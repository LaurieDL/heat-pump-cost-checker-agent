// Builds dist/prototype.html: the same page, styles and agent code inlined
// into one file for a claude.ai artifact. The only difference from production
// is the transport: the agent runs in the page via the artifact `sample`
// capability instead of calling /api/chat.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const between = (s, start, end) => {
  const a = s.indexOf(start);
  const b = s.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`markers ${start} / ${end} not found`);
  return s.slice(a + start.length, b).trim();
};

// Module files in dependency order. Imports are dropped and `export` removed;
// names are unique across these files, so they can share one module scope.
const MODULES = [
  'shared/place.js',
  'shared/agent-tools.js',
  'shared/prompt.js',
  'public/render.js',
  'prototype/transport-sample.js',
  'public/app.js',
];
const bundle = MODULES.map((p) => `// ── ${p}\n` + read(p)
  .replace(/^import\s[^;]+;\s*$/gm, '')
  .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '')).join('\n');
if (/^\s*(import|export)\s/m.test(bundle)) throw new Error('A module still has an import/export the bundler cannot handle');

const html = read('public/index.html');
let body = between(html, '<!-- page:body:start -->', '<!-- page:body:end -->');
body = body.replace(
  /Your messages are sent to Claude, Anthropic's AI, to work out answers,/,
  'This prototype runs on your own Claude account: your messages go to Claude to work out answers,',
);
const head = between(html, '<!-- page:head:start -->', '<!-- page:head:end -->');
const core = read('core/heat-pump-core.js');
for (const [name, src] of [['core', core], ['bundle', bundle]]) {
  if (/<\/script/i.test(src)) throw new Error(`${name} contains </script>`);
}

// The standalone page serves its own fonts. The embedded copy has nowhere to host them, so it keeps
// loading them from Google Fonts, exactly as before.
const GOOGLE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&amp;family=Geist+Mono:wght@400;500&amp;family=Instrument+Sans:wght@500;600;700&amp;family=Instrument+Serif:ital@0;1&amp;display=swap">`;

const out = `${head}
${GOOGLE_FONTS}
<style>
${read('public/styles.css')}
</style>
${body}
<script>
${core}
</script>
<script type="module">
${bundle}
</script>
`;

mkdirSync(new URL('dist/', root), { recursive: true });
const dest = new URL('dist/prototype.html', root);
writeFileSync(dest, out);
console.log(`Wrote ${fileURLToPath(dest)} (${(out.length / 1024).toFixed(1)} KB)`);
