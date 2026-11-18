import { build } from 'esbuild';
import { mkdir, writeFile, readFile, stat, lstat, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';

// Local-only bundle in memory. Does not load .env/.dev.vars or the production worker.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'output/semantic-eval');
let lockPath;
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
try {
  const built = await build({ entryPoints: [resolve(root, 'eval/run-semantic-lab.ts')], bundle: true, platform: 'node', format: 'esm',
    target: 'es2023', write: false, logLevel: 'silent' });
  const { runLab, parseLabArgs, EVAL_OUTPUT_LIMITS } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const boundedOutput = value => {
    const encoded = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(encoded, 'utf8') > EVAL_OUTPUT_LIMITS.fileBytes) throw Error('Evaluation output size limit');
    return encoded;
  };
  const args = parseLabArgs(process.argv.slice(2));
  const wantsLive = process.argv.slice(2).includes('--live') && process.env.DAABOUL_EVAL_LIVE === '1';
  const checkpointPath = args.resumePath || args.checkPath ? resolve(root, args.resumePath ?? args.checkPath)
    : resolve(outputDir, `checkpoint-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  if (!checkpointPath.startsWith(outputDir + sep) || !checkpointPath.endsWith('.json')) throw Error('Checkpoint location invalid');
  await mkdir(outputDir, { recursive: true });
  if (wantsLive) {
    const candidate = checkpointPath + '.lock';
    await mkdir(candidate); lockPath = candidate; // Existing lock fails closed; never auto-clear a stale lock.
  }
  let checkpointData;
  if (args.resumePath || args.checkPath) {
    if ((await lstat(checkpointPath)).isSymbolicLink() || (await stat(checkpointPath)).size > EVAL_OUTPUT_LIMITS.fileBytes) throw Error('Checkpoint file invalid');
    checkpointData = JSON.parse(await readFile(checkpointPath, 'utf8'));
  }
  const persist = async checkpoint => {
    const encoded = boundedOutput(checkpoint);
    const temporary = checkpointPath + '.' + randomUUID() + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, checkpointPath);
      const directory = await open(outputDir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  };
  const result = await runLab(process.argv.slice(2), process.env, wantsLive ? globalThis.fetch : undefined,
    { ...(checkpointData ? { checkpointData } : {}), ...(wantsLive ? { persist } : {}), signal: controller.signal });
  if (result.mode === 'offline_checkpoint_check') {
    console.log(JSON.stringify(result)); if (!result.resumable) process.exitCode = 2;
  } else {
  const output = resolve(outputDir, result.mode === 'live' ? `paced-smoke-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`
    : result.evaluationProfile === 'contract-v5' ? 'contract-v5-readiness.json' : result.evaluationProfile === 'understanding-v4' ? 'understanding-readiness.json' : result.evaluationProfile === 'quality-v3' ? 'quality-readiness.json' : result.caseSelectionExplicit ? 'contrast-readiness.json' : 'offline-readiness.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, boundedOutput(result), { mode: 0o600 });
  console.log(JSON.stringify({ mode: result.mode, output, datasetCases: result.datasetCases ?? null,
    liveRequests: result.liveRequests ?? result.requestsThisInvocation ?? result.guard?.requests ?? 0, stop: result.stop ?? null,
    ...(result.caseSelectionExplicit ? { cases: result.smokeSelection.selected.map(c => c.id), totalReservedTokens: result.smokeSelection.totalReserved } : {}),
    ...(result.mode === 'live' ? { checkpoint: checkpointPath } : {}),
    warning: 'Offline mocks are not Groq accuracy; live mode requires separate human authorization.' }));
  }
} catch {
  // Never print a thrown exception, request body, environment value or API credential.
  console.error('Evaluation stopped. Verify flags/environment and inspect the lab instructions. No automatic retry.');
  process.exitCode = 1;
} finally {
  if (lockPath) await rm(lockPath, { recursive: true, force: true });
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
