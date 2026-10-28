/**
 * Safety checks before a deploy:
 *   node scripts/check-env.mjs dev|prod
 * - the environment file has a real Firebase config (no REPLACE_ME)
 * - its projectId matches the .firebaserc alias we are deploying to
 * - production needs you to type the project id to confirm
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const target = process.argv[2];
if (!['dev', 'prod'].includes(target)) {
  console.error('Usage: node scripts/check-env.mjs dev|prod');
  process.exit(1);
}

const envFile = `src/environments/environment.${target}.ts`;
const env = readFileSync(envFile, 'utf8');
const projectId = /projectId:\s*'([^']+)'/.exec(env)?.[1];
const alias = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects?.[target];

const fail = (msg) => {
  console.error(`\n✖ ${msg}\n  See docs/ENVIRONMENTS.md\n`);
  process.exit(1);
};
if (env.includes('REPLACE_ME')) fail(`${envFile} still contains REPLACE_ME – paste the Firebase web app config of the ${target} project.`);
if (!alias) fail(`.firebaserc has no "${target}" alias.`);
if (projectId !== alias) fail(`${envFile} is for "${projectId}" but .firebaserc "${target}" points to "${alias}". They must match.`);

if (target === 'prod') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n⚠  You are deploying to PRODUCTION (${alias}) – the real shop.\n   Type the project id to continue: `);
  rl.close();
  if (answer.trim() !== alias) fail('Production deploy cancelled.');
}
console.log(`✔ ${target} → ${alias}`);
