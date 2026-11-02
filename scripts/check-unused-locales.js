/*
 * Report-only locale audit.
 *
 * Run: node scripts/check-unused-locales.js
 *
 * Lists keys in locales/en.json that no page or script references literally.
 * It is intentionally NOT a test failure: several namespaces are composed at
 * runtime (app.<id>.name, journal.cause.<id>, gamerules.<id>, ...), and a wrong
 * prune shows raw keys to non-English users. See docs/agent/backlog.md (BL-23).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function walk(dir, out) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === '_deploy' || name === 'locales') continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, out);
        else if (/\.(html|js)$/.test(name)) out.push(full);
    }
}

const files = [];
walk(root, files);
const source = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
const keys = Object.keys(en);

// Literal references: quoted key-shaped strings and data-i18n attributes.
const literal = new Set();
for (const m of source.matchAll(/["']([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_-]+)+)["']/g)) literal.add(m[1]);
for (const m of source.matchAll(/data-i18n(?:-html|-placeholder|-title|-only)?=["']([^"']+)["']/g)) literal.add(m[1]);

// Namespaces built by concatenation or template literals.
const dynamicPrefixes = new Set(['app.']); // app.${app.id}.name / .desc
for (const m of source.matchAll(/["']([a-zA-Z0-9_.]+\.)["']\s*\+/g)) dynamicPrefixes.add(m[1]);
for (const m of source.matchAll(/`([a-zA-Z0-9_.]+)\.\$\{/g)) dynamicPrefixes.add(m[1] + '.');

function matchesDynamic(key) {
    for (const prefix of dynamicPrefixes) {
        if (key.startsWith(prefix)) return true;
    }
    return false;
}

const unreferenced = keys.filter(key => !literal.has(key) && !matchesDynamic(key));

const byNamespace = {};
for (const key of unreferenced) {
    const ns = key.split('.')[0];
    byNamespace[ns] = (byNamespace[ns] || 0) + 1;
}

console.log(`en.json keys: ${keys.length}`);
console.log(`literal/dynamic references: ${keys.length - unreferenced.length}`);
console.log(`unreferenced (candidates for pruning): ${unreferenced.length}`);
console.log('by namespace:', Object.entries(byNamespace).sort((a, b) => b[1] - a[1]).slice(0, 15));
if (unreferenced.length) {
    console.log('\nfirst 40 candidates:');
    for (const key of unreferenced.slice(0, 40)) console.log('  ' + key);
}
console.log('\nReport-only. Verify dynamic key construction before pruning anything.');
