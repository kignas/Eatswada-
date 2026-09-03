#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const roots = [
  path.resolve(__dirname, '..'),
];
const skip = new Set(['node_modules', '.git']);

function walk(dir, out=[]) {
  for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
    if (skip.has(ent.name)) continue;
    const p=path.join(dir,ent.name);
    if (ent.isDirectory()) walk(p,out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = roots.flatMap(r=>walk(r));
let failed=0;
for (const file of files) {
  const r=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if (r.status!==0) {
    failed++;
    console.error(`FAIL ${path.relative(process.cwd(),file)}\n${r.stderr}`);
  }
}
console.log(`Syntax: ${files.length-failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
