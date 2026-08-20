#!/usr/bin/env node
'use strict';

/**
 * Would the Docker image actually contain everything the code asks for?
 *
 * This exists because it didn't, twice over: the Dockerfile listed the source
 * files by name, two new modules were added without touching that list, and the
 * image built perfectly and then died on first run with
 * `Cannot find module './forwarder'`. A build that succeeds is not evidence
 * that the thing inside it can start.
 *
 * So: read every relative `require()` in the project, work out which files the
 * Dockerfile's COPY lines would place in the image, and complain about anything
 * required but not copied.
 *
 *   node tools/check-image.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const fail = [];

const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

/** The file patterns the Dockerfile copies into the image. */
const copied = dockerfile
  .split('\n')
  .filter((l) => /^\s*COPY\s/i.test(l))
  .flatMap((l) =>
    l.replace(/^\s*COPY\s+/i, '')
      .split(/\s+/)
      .slice(0, -1)          // the last token is the destination
      .filter(Boolean));

/** Turn `*.js` and `package-lock.json*` into something testable. */
const matchesCopy = (file) =>
  copied.some((pattern) => {
    const rx = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return rx.test(file);
  });

const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));

for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]);

  for (const rel of requires) {
    const base = rel.replace(/^\.\//, '');
    const target = base.endsWith('.js') ? base : base + '.js';

    if (!fs.existsSync(path.join(ROOT, target))) {
      fail.push(`${file} requires '${rel}' but ${target} does not exist`);
      continue;
    }
    if (!matchesCopy(target)) {
      fail.push(`${file} requires '${rel}', but the Dockerfile never COPYs ${target} — the image will start and die`);
    }
  }
}

// The entrypoint itself has to be in there.
const entry = (dockerfile.match(/CMD\s+\[\s*"node"\s*,\s*"([^"]+)"/) || [])[1];
if (entry && !matchesCopy(entry)) {
  fail.push(`CMD runs ${entry}, which no COPY line puts in the image`);
}

if (fail.length) {
  console.error('Image would be incomplete:\n' + fail.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}

console.log(`OK — every relative require across ${jsFiles.length} files is copied into the image.`);
console.log('    COPY patterns: ' + copied.join(' '));
