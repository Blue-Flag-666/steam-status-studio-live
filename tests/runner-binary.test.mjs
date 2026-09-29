import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

async function until(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('runner did not exit after termination')), 5000); })
    ]);
  } finally { clearTimeout(timeout); }
}

async function removeWhenFree(path) {
  await until(() => {
    try { rmSync(path, { force: true }); return true; }
    catch (error) { if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false; throw error; }
  }, `could not remove ${path}`, 3000);
}

test('runner is a Windows GUI executable, not a console application', () => {
  const binary = readFileSync(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  assert.equal(binary.toString('ascii', 0, 2), 'MZ');
  const peOffset = binary.readUInt32LE(0x3c);
  assert.equal(binary.toString('ascii', peOffset, peOffset + 4), 'PE\0\0');
  const subsystem = binary.readUInt16LE(peOffset + 24 + 68);
  assert.equal(subsystem, 2); // IMAGE_SUBSYSTEM_WINDOWS_GUI
});

test('starting a new runner closes the previous instance', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const executable = fileURLToPath(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  const first = spawn(executable, ['--no-steam-watch'], { stdio: 'ignore' });
  let second;
  let timeout;
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(first.exitCode, null, 'first runner should stay open');
    second = spawn(executable, ['--no-steam-watch'], { stdio: 'ignore' });
    await Promise.race([
      once(first, 'exit'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('previous runner did not exit')), 10000); })
    ]);
    assert.equal(second.exitCode, null, 'replacement runner should stay open');
  } finally {
    clearTimeout(timeout);
    await stopChild(first);
    await stopChild(second);
  }
});

test('runner heartbeat is live and a stop request exits it', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const executable = fileURLToPath(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  const heartbeat = join(dirname(executable), 'SteamStatusRunner.heartbeat');
  const nextHeartbeat = heartbeat + '.next';
  const stop = join(dirname(executable), 'SteamStatusRunner.stop');
  const child = spawn(executable, ['--no-steam-watch'], { stdio: 'ignore' });
  try {
    await until(() => {
      try {
        const match = readFileSync(heartbeat, 'utf8').match(/^(\d+):(\d+)$/);
        return match && Number(match[1]) === child.pid && Date.now() - Number(match[2]) < 3000;
      } catch { return false; }
    }, 'runner never published a live heartbeat');
    const initialPulse = Number(readFileSync(heartbeat, 'utf8').split(':')[1]);
    await until(() => {
      try { return Number(readFileSync(heartbeat, 'utf8').split(':')[1]) > initialPulse; }
      catch { return false; }
    }, 'runner heartbeat stopped advancing', 3000);
    const readDeadline = Date.now() + 1500;
    while (Date.now() < readDeadline) {
      assert.match(readFileSync(heartbeat, 'utf8'), new RegExp(`^${child.pid}:\\d+$`));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(stop, 'stop');
    await until(() => child.exitCode !== null, 'runner ignored the stop request');
    assert.equal(existsSync(heartbeat), false, 'runner should remove its heartbeat on exit');
    assert.equal(existsSync(nextHeartbeat), false, 'runner should remove its temporary heartbeat on exit');
    assert.equal(existsSync(stop), false, 'runner should consume its stop request');
  } finally {
    await stopChild(child);
    await removeWhenFree(stop);
    await removeWhenFree(heartbeat);
    await removeWhenFree(nextHeartbeat);
  }
});

test('runner exits when its watched Steam process exits', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const executable = fileURLToPath(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  const watched = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], { stdio: 'ignore', windowsHide: true });
  const runner = spawn(executable, ['--watch-pid', String(watched.pid)], { stdio: 'ignore' });
  const heartbeat = join(dirname(executable), 'SteamStatusRunner.heartbeat');
  try {
    await until(() => {
      try { return readFileSync(heartbeat, 'utf8').startsWith(`${runner.pid}:`); }
      catch { return false; }
    }, 'watched runner did not start');
    await until(() => watched.exitCode !== null, 'watched test process did not exit');
    await until(() => runner.exitCode !== null, 'runner remained after watched process exited');
    assert.equal(existsSync(heartbeat), false);
  } finally {
    await stopChild(watched);
    await stopChild(runner);
    await removeWhenFree(heartbeat);
  }
});

const steamAvailable = process.platform === 'win32' && /"steam\.exe"/i.test(
  spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? ''
);

test('default runner attaches to an already-running Steam process', { skip: !steamAvailable, timeout: 10000 }, async () => {
  const executable = fileURLToPath(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  const heartbeat = join(dirname(executable), 'SteamStatusRunner.heartbeat');
  const stop = join(dirname(executable), 'SteamStatusRunner.stop');
  const child = spawn(executable, { stdio: 'ignore' });
  try {
    await until(() => {
      try { return readFileSync(heartbeat, 'utf8').startsWith(`${child.pid}:`); }
      catch { return false; }
    }, 'runner did not attach to the existing Steam process');
    assert.equal(child.exitCode, null);
    writeFileSync(stop, 'stop');
    await until(() => child.exitCode !== null, 'runner ignored the stop request');
  } finally {
    await stopChild(child);
    await removeWhenFree(stop);
    await removeWhenFree(heartbeat);
  }
});
