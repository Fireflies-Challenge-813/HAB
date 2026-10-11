// Publishes the dashboard on GitHub Pages: builds web/dist (with data/), then
// force-pushes it as the gh-pages branch of the origin repo, which Pages serves at
// https://fireflies-challenge-813.github.io/HAB/
//
//   npm run deploy      (rerun after new data or dashboard changes are on main)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(web, 'dist');
const run = (cmd, cwd = web) => execSync(cmd, { cwd, stdio: 'inherit' });

run('npm run build');
fs.writeFileSync(path.join(dist, '.nojekyll'), ''); // serve the files as they are
const origin = execSync('git remote get-url origin', { cwd: web }).toString().trim();
const source = execSync('git rev-parse --short HEAD', { cwd: web }).toString().trim();

fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });
try {
  run('git init -q -b gh-pages', dist);
  run('git add -A', dist);
  run(`git commit -q -m "Publish the dashboard (built from ${source})"`, dist);
  run(`git push -f ${origin} gh-pages`, dist);
} finally {
  fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });
}
console.log('Published: https://fireflies-challenge-813.github.io/HAB/ (Pages takes a minute or two to update)');
