import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const PAGE = new URL('../public/legal.html', import.meta.url);

test('legal.html : chaque lien de la liste ouvre un document de la page, et chaque document est listé', () => {
  assert.ok(existsSync(PAGE), 'la page public/legal.html doit exister');
  const html = readFileSync(PAGE, 'utf8');
  const index = html.match(/<div class="index"[\s\S]*?<!-- \/index -->/);
  assert.ok(index, 'legal.html doit contenir la liste des contrats (div.index … <!-- /index -->)');
  const listed = [...index[0].matchAll(/href="#([a-z0-9-]+)"/g)].map((m) => m[1]);
  const docs = [...html.matchAll(/<article class="doc" id="doc-([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(listed.length >= 10, 'legal.html : la liste doit proposer au moins 10 documents');
  assert.deepEqual(listed.filter((s) => !docs.includes(s)), [], 'legal.html : lien de la liste sans document correspondant');
  assert.deepEqual(docs.filter((s) => !listed.includes(s)), [], 'legal.html : document absent de la liste');
});

test('legal : l’accueil, le centre d’aide et l’inscription mènent aux contrats', () => {
  const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  assert.match(read('index.html'), /href="\/legal"/, 'le pied de page de l’accueil doit mener à /legal');
  assert.match(read('aide.html'), /href="\/legal"/, 'le pied de page du centre d’aide doit mener à /legal');
  assert.match(read('signup.html'), /href="\/legal#cgu"/, 'la case « J’accepte les conditions » de l’inscription doit mener aux conditions d’utilisation');
});
