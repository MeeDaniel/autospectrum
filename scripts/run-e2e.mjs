import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const url = 'http://127.0.0.1:4173';
const vite = resolve('node_modules/vite/bin/vite.js');
const playwright = resolve('node_modules/@playwright/test/cli.js');
const server = spawn(process.execPath, [vite, '--configLoader', 'runner', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  stdio: 'ignore', windowsHide: true,
});

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error('Не удалось запустить Vite');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* Server is still starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Vite не ответил за 10 секунд');
}

try {
  await waitForServer();
  const tests = spawn(process.execPath, [playwright, 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolveExit, reject) => {
    tests.on('error', reject);
    tests.on('exit', (code) => resolveExit(code ?? 1));
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server.kill();
}
