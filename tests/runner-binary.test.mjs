import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  const first = spawn(executable, { stdio: 'ignore' });
  let second;
  let timeout;
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(first.exitCode, null, 'first runner should stay open');
    second = spawn(executable, { stdio: 'ignore' });
    await Promise.race([
      once(first, 'exit'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('previous runner did not exit')), 10000); })
    ]);
    assert.equal(second.exitCode, null, 'replacement runner should stay open');
  } finally {
    clearTimeout(timeout);
    first.kill();
    second?.kill();
  }
});

test('runner heartbeat is live and a stop request exits it', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const executable = fileURLToPath(new URL('../dist/SteamStatusRunner.exe', import.meta.url));
  const heartbeat = join(dirname(executable), 'SteamStatusRunner.heartbeat');
  const nextHeartbeat = heartbeat + '.next';
  const stop = join(dirname(executable), 'SteamStatusRunner.stop');
  const child = spawn(executable, { stdio: 'ignore' });
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
    child.kill();
    rmSync(stop, { force: true });
    rmSync(heartbeat, { force: true });
    rmSync(nextHeartbeat, { force: true });
  }
});
