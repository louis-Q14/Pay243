// Reporter node:test -> tdd-guard : écrit le résultat de la dernière exécution au format attendu par tdd-guard
// (.claude/tdd-guard/data/test.json, via --test-reporter-destination). Outil de développement, sans effet sur l'application.
import path from 'node:path';

const errorOf = (err) => {
  const e = err?.cause ?? err;
  return { message: String(e?.message ?? e ?? 'Échec'), stack: e?.stack ? String(e.stack) : undefined };
};

export default async function* tddGuardReporter(source) {
  const modules = new Map(); // fichier -> tests
  const moduleOf = (file) => {
    const id = path.resolve(file || 'inconnu');
    if (!modules.has(id)) modules.set(id, []);
    return modules.get(id);
  };
  let failed = false;
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const isFile = d.details?.type === undefined && d.nesting === 0 && d.file && path.resolve(d.name) === path.resolve(d.file);
    const tests = moduleOf(d.file);
    if (event.type === 'test:fail') failed = true;
    // Un fichier qui ne se charge pas (import manquant…) remonte comme un test portant le nom du fichier
    if (isFile && event.type === 'test:pass') continue;
    if (d.details?.type === 'suite') continue;
    const state = event.type === 'test:pass' ? (d.skip || d.todo ? 'skipped' : 'passed') : 'failed';
    tests.push({ name: d.name, fullName: d.name, state, ...(state === 'failed' ? { errors: [errorOf(d.details?.error)] } : {}) });
  }
  const report = {
    testModules: [...modules].map(([moduleId, tests]) => ({ moduleId, tests })),
    unhandledErrors: [],
    reason: failed ? 'failed' : 'passed',
  };
  yield JSON.stringify(report, null, 2) + '\n';
}