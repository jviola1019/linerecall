import { spawn } from 'node:child_process';

export async function runProcess(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} timed out after ${options.timeoutMs ?? 30_000}ms`));
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `${executable} exited with ${String(code)}${signal === null ? '' : ` (${signal})`}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
