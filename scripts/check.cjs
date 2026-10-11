'use strict';
// Default checks never prepare media, load Eagle or run historical PoC commands.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
function files(dir, accept, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['cache', 'verification-runs', '.git', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files(file, accept, out);
    else if (accept(file)) out.push(file);
  }
  return out;
}
function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.error || r.status !== 0) throw new Error(`${args.join(' ')}: ${r.error ? r.error.message : r.stderr || r.status}`);
}
function slug(text) { return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-'); }
function checkDocs() {
  const docs = [path.join(root, 'AGENTS.md'), path.join(root, 'README.md'), ...files(path.join(root, 'docs'), f => f.endsWith('.md'))];
  let links = 0;
  for (const file of docs) {
    const body = fs.readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].replace(/^<|>$/g, '');
      if (/^(https?:|app:|codex:|mailto:|[A-Za-z]:)/.test(raw)) continue;
      const [name, anchor] = raw.split('#');
      const target = name ? path.resolve(path.dirname(file), decodeURIComponent(name)) : file;
      if (!fs.existsSync(target)) throw new Error(`Broken local link: ${path.relative(root, file)} -> ${raw}`);
      if (anchor && target.endsWith('.md')) {
        const headings = [...fs.readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1]));
        if (!headings.includes(decodeURIComponent(anchor))) throw new Error(`Missing heading: ${path.relative(root, file)} -> ${raw}`);
      }
      links++;
    }
  }
  console.log(`documents: ${docs.length} files, ${links} local links checked`);
}
const js = ['plugin', 'tests', 'scripts'].flatMap(d => files(path.join(root, d), f => /\.(cjs|js)$/.test(f)));
for (const file of js) {
  run(['--check', file]);
  if (file.startsWith(path.join(root, 'plugin') + path.sep) && /(?:require\s*\([^)]*prototypes|from\s+['"][^'"]*prototypes)/.test(fs.readFileSync(file, 'utf8')))
    throw new Error('Formal code depends on prototypes: ' + file);
}
console.log(`syntax and prototype dependency boundary: ${js.length} files`);
for (const file of fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.cjs')).sort()) run([path.join(root, 'tests', file)]);
const manifestFile = path.join(root, 'tests/host/t0/manifest.json');
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!manifest.main || manifest.main.multiple !== false || manifest.main.url !== 'index.html') throw new Error('T0 manifest entry mismatch');
  const html = fs.readFileSync(path.join(path.dirname(manifestFile), manifest.main.url), 'utf8');
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) if (!fs.existsSync(path.resolve(path.dirname(manifestFile), match[1]))) throw new Error('Missing host script: ' + match[1]);
  console.log('T0 manifest and script wiring checked; real Eagle not executed');
}
checkDocs();
console.log('default check passed (no media generation, no historical rerun, no Eagle/library writes)');
