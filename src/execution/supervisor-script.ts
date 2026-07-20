/**
 * Trusted code uploaded by ReproForge before every experiment. Repository
 * inputs are parsed from JSON and passed to spawn with shell disabled.
 */
export const RUNNER_SUPERVISOR_SOURCE = String.raw`import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';

const [, , configPath, resultPath] = process.argv;
if (!configPath || !resultPath) process.exit(64);

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const startedAt = Date.now();
const perStreamLimit = Math.floor(config.limits.maxOutputBytes / 2);

function outputCapture() {
  const hash = createHash('sha256');
  const chunks = [];
  let originalBytes = 0;
  let retainedBytes = 0;
  return {
    add(chunk) {
      const bytes = Buffer.from(chunk);
      originalBytes += bytes.byteLength;
      hash.update(bytes);
      if (retainedBytes < perStreamLimit) {
        const retained = bytes.subarray(0, perStreamLimit - retainedBytes);
        chunks.push(retained);
        retainedBytes += retained.byteLength;
      }
    },
    result() {
      return {
        originalBytes,
        sha256: hash.digest('hex'),
        text: Buffer.concat(chunks).toString('utf8'),
        truncated: originalBytes > retainedBytes,
      };
    },
  };
}

function processTree(rootPid) {
  const parents = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const stat = readFileSync('/proc/' + entry + '/stat', 'utf8');
      const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const parent = Number(afterName[1]);
      parents.set(Number(entry), parent);
    } catch {}
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (descendants.has(parent) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function residentBytes(pids) {
  let total = 0;
  for (const pid of pids) {
    try {
      const status = readFileSync('/proc/' + pid + '/status', 'utf8');
      const match = /^VmRSS:\s+([0-9]+)\s+kB$/m.exec(status);
      if (match) total += Number(match[1]) * 1024;
    } catch {}
  }
  return total;
}

function workspaceBytes(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      total += stat.size;
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(current + '/' + entry);
      continue;
    }
    if (stat.isFile()) total += stat.size;
  }
  return total;
}

const stdout = outputCapture();
const stderr = outputCapture();
let termination = null;
let spawnFailure = false;
const child = spawn(config.executable, config.args, {
  cwd: config.cwd,
  detached: true,
  env: {
    CI: '1',
    HOME: '/vercel/sandbox',
    NO_COLOR: '1',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_offline: 'true',
  },
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => stdout.add(chunk));
child.stderr.on('data', (chunk) => stderr.add(chunk));

function terminate(reason) {
  if (termination !== null) return;
  termination = reason;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

const timeout = setTimeout(
  () => terminate('timeout'),
  config.limits.commandTimeoutMs,
);
const monitor = setInterval(() => {
  const processes = processTree(child.pid);
  if (processes.size > config.limits.maxProcesses) {
    terminate('process-limit');
    return;
  }
  if (residentBytes(processes) > config.limits.maxMemoryBytes) {
    terminate('memory-limit');
    return;
  }
  if (workspaceBytes(config.workspaceRoot) > config.limits.maxWorkspaceBytes) {
    terminate('workspace-limit');
  }
}, 100);

const exitCode = await new Promise((resolve) => {
  child.once('error', () => {
    spawnFailure = true;
    resolve(127);
  });
  child.once('close', (code, signal) => {
    if (signal && termination === null) termination = 'provider-interrupted';
    resolve(Number.isInteger(code) ? code : 137);
  });
});
clearTimeout(timeout);
clearInterval(monitor);
try {
  process.kill(-child.pid, 'SIGKILL');
} catch {}
if (spawnFailure && termination === null) termination = 'provider-interrupted';

writeFileSync(
  resultPath,
  JSON.stringify({
    durationMs: Math.max(0, Date.now() - startedAt),
    exitCode,
    stderr: stderr.result(),
    stdout: stdout.result(),
    termination,
  }),
  { encoding: 'utf8', flag: 'w', mode: 0o600 },
);
`;
