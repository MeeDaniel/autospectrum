import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'compose.smoke.yaml');
const project = `autospectrum-smoke-${randomBytes(4).toString('hex')}`;
const images = { api: `${project}-api`, web: `${project}-web` };
const certImage = 'alpine/openssl:latest';
const runtimeImage = 'node:24-alpine';
const checkOnly = process.argv.includes('--check');
const extraArgs = process.argv.slice(2).filter(arg => arg !== '--check');
let certDir;
let composeStarted = false;
let oldIpHolder;
let echoContainer;

function execute(file, args, { env = process.env, input, inherit = false, allowFailure = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      cwd: root, env, windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', error => reject(new Error(`Cannot run ${file}: ${error.message}`)));
    child.on('close', code => {
      if (code !== 0 && !allowFailure) reject(new Error(`${file} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`));
      else done({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function docker(args, options) { return execute('docker', args, options); }
function compose(args, options = {}) {
  return docker(['compose', '-f', composeFile, '-p', project, ...args], { ...options, env: smokeEnv });
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

const httpPort = await freePort();
const httpsPort = await freePort();
const smokeEnv = {
  ...process.env,
  SMOKE_DB_PASSWORD: randomBytes(24).toString('hex'),
  SMOKE_API_IMAGE: images.api,
  SMOKE_WEB_IMAGE: images.web,
  SMOKE_HTTP_PORT: String(httpPort),
  SMOKE_HTTPS_PORT: String(httpsPort),
  SMOKE_CERT_DIR: join(tmpdir(), `${project}-certificate`),
  SMOKE_OPERATOR_LOGIN: 'smoke-operator',
  SMOKE_OPERATOR_PASSWORD: randomBytes(24).toString('hex'),
  SMOKE_STAFF_LOGIN: 'smoke-staff',
  SMOKE_STAFF_PASSWORD: randomBytes(24).toString('hex'),
};
const baseURL = `https://127.0.0.1:${httpsPort}`;

function get(path, headers = {}) {
  return new Promise((done, reject) => {
    const req = httpsRequest(`${baseURL}${path}`, { rejectUnauthorized: false, headers, timeout: 2500 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode, body, headers: response.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(label, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s${lastError ? `: ${lastError.message}` : ''}`);
}

async function containerId(service) {
  const result = await compose(['ps', '-q', service]);
  if (!result.stdout) throw new Error(`Missing ${service} container in dedicated project ${project}`);
  return result.stdout;
}

async function networkAddress(container) {
  const result = await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]);
  const entries = Object.entries(JSON.parse(result.stdout));
  const internal = entries.find(([name]) => name.endsWith('_internal'));
  if (!internal?.[1]?.IPAddress) throw new Error(`Cannot locate isolated internal network for ${container}`);
  return { name: internal[0], ip: internal[1].IPAddress };
}

async function checkPrerequisites() {
  try { await docker(['info', '--format', '{{.ServerVersion}}']); }
  catch (error) { throw new Error(`Docker Desktop/daemon is required for production smoke: ${error.message}`); }
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch (error) { throw new Error(`Installed Google Chrome is required (Playwright channel chrome): ${error.message}`); }
  finally { await browser?.close(); }
  await compose(['config', '--quiet']);
}

async function createCertificate() {
  certDir = await mkdtemp(join(tmpdir(), 'autospectrum-smoke-cert-'));
  smokeEnv.SMOKE_CERT_DIR = certDir;
  await docker([
    'run', '--rm', '--mount', `type=bind,source=${certDir},target=/certs`, '--entrypoint', 'openssl', certImage,
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', '/certs/privkey.pem', '-out', '/certs/fullchain.pem',
  ]);
  for (const name of ['fullchain.pem', 'privkey.pem']) {
    if ((await stat(join(certDir, name))).size === 0) throw new Error(`Temporary TLS ${name} is empty`);
  }
}

async function runBrowserTests() {
  console.log(`Production browser tests: ${baseURL}`);
  const testEnv = { ...smokeEnv, SMOKE_BASE_URL: baseURL };
  delete testEnv.NO_COLOR;
  await execute(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config', join(root, 'playwright.production.config.ts'), ...extraArgs], {
    env: testEnv, inherit: true,
  });
}

async function createTestAccounts() {
  await compose(['exec', '-T', 'api', 'npm', 'run', 'server:staff', '--', 'create', smokeEnv.SMOKE_OPERATOR_LOGIN], { input: `${smokeEnv.SMOKE_OPERATOR_PASSWORD}\n` });
  await compose(['exec', '-T', 'api', 'npm', 'run', 'server:staff', '--', 'role', smokeEnv.SMOKE_OPERATOR_LOGIN, 'operator']);
  await compose(['exec', '-T', 'api', 'npm', 'run', 'server:staff', '--', 'create', smokeEnv.SMOKE_STAFF_LOGIN], { input: `${smokeEnv.SMOKE_STAFF_PASSWORD}\n` });
  console.log('Created isolated staff and operator fixtures through the production CLI.');
}

async function verifyProxyReResolution() {
  const originalApi = await containerId('api');
  const originalWeb = await containerId('web');
  const oldAddress = await networkAddress(originalApi);
  await compose(['stop', 'api']);
  await compose(['rm', '-f', 'api']);

  oldIpHolder = `${project}-old-ip`;
  await docker([
    'run', '-d', '--rm', '--name', oldIpHolder, '--network', oldAddress.name, '--ip', oldAddress.ip,
    '--entrypoint', 'node', runtimeImage, '-e', 'setInterval(() => {}, 60000)',
  ]);

  echoContainer = `${project}-echo`;
  const echoProgram = "require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({url:req.url,xff:req.headers['x-forwarded-for'],realIp:req.headers['x-real-ip'],proto:req.headers['x-forwarded-proto']}))}).listen(3000,'0.0.0.0')";
  await docker([
    'run', '-d', '--rm', '--name', echoContainer, '--network', oldAddress.name, '--network-alias', 'api',
    '--entrypoint', 'node', runtimeImage, '-e', echoProgram,
  ]);
  const echoAddress = await networkAddress(echoContainer);
  if (echoAddress.ip === oldAddress.ip) throw new Error('Dynamic DNS probe did not change API IP');

  const requestedUri = '/api/readyz?probe=a%2Bb&n=7';
  const echoed = await waitFor('nginx DNS re-resolution to echo upstream', async () => {
    const response = await get(requestedUri, { 'X-Forwarded-For': '198.51.100.42', 'X-Real-IP': '203.0.113.9' });
    if (response.status !== 200) return null;
    try {
      const parsed = JSON.parse(response.body);
      return parsed.url === requestedUri ? parsed : null;
    } catch { return null; }
  }, 20000);
  if (echoed.xff !== echoed.realIp || echoed.xff === '198.51.100.42' || echoed.realIp === '203.0.113.9' || echoed.proto !== 'https') {
    throw new Error(`nginx did not overwrite forged forwarding headers: ${JSON.stringify(echoed)}`);
  }
  if (await containerId('web') !== originalWeb) throw new Error('nginx container restarted during DNS probe');
  console.log(`nginx DNS/URI/XFF verified with echo upstream: ${oldAddress.ip} -> ${echoAddress.ip}; web container unchanged`);

  await docker(['rm', '-f', echoContainer]);
  echoContainer = undefined;
  await compose(['up', '-d', '--no-deps', 'api']);
  const restoredAddress = await networkAddress(await containerId('api'));
  if (restoredAddress.ip === oldAddress.ip) throw new Error('Restored real API reused old IP; DNS probe is inconclusive');
  await waitFor('restored real API through unchanged nginx', async () => {
    const response = await get('/api/readyz');
    return response.status === 200 && JSON.parse(response.body).status === 'ok';
  });
  if (await containerId('web') !== originalWeb) throw new Error('nginx container restarted while restoring API');
  console.log(`Real PostgreSQL-backed API restored at ${restoredAddress.ip}; web container unchanged`);
}

async function cleanup() {
  const failures = [];
  for (const container of [echoContainer, oldIpHolder]) {
    if (container) {
      const result = await docker(['rm', '-f', container], { allowFailure: true });
      if (result.code !== 0) failures.push(`container ${container}: ${result.stderr}`);
    }
  }
  if (composeStarted) {
    const result = await compose(['down', '--volumes', '--remove-orphans'], { inherit: true, allowFailure: true });
    if (result.code !== 0) failures.push(`Docker compose project ${project} could not be removed`);
  }
  for (const image of Object.values(images)) await docker(['image', 'rm', image], { allowFailure: true });
  if (certDir) {
    const directory = resolve(certDir);
    const temporaryRoot = resolve(tmpdir());
    if (!directory.startsWith(temporaryRoot + sep) || !directory.includes('autospectrum-smoke-cert-')) {
      throw new Error(`Refusing to remove certificate directory outside the smoke temp area: ${directory}`);
    }
    await rm(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(`Smoke cleanup failed: ${failures.join('; ')}`);
}

try {
  await checkPrerequisites();
  if (checkOnly) {
    await createCertificate();
    console.log('Production smoke prerequisites available: Docker daemon, installed Chrome, isolated compose config, temporary TLS.');
  } else {
    await createCertificate();
    await compose(['build', 'api', 'web'], { inherit: true });
    composeStarted = true;
    await compose(['up', '-d', 'web'], { inherit: true });
    await waitFor('real PostgreSQL-backed API through nginx', async () => {
      const response = await get('/api/readyz');
      return response.status === 200 && JSON.parse(response.body).status === 'ok';
    });
    await createTestAccounts();
    await runBrowserTests();
    await verifyProxyReResolution();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
