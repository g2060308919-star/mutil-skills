import { E2EError } from '@mutil-skills/e2e-contracts'
import { realpathSync } from 'node:fs'
import { delimiter, isAbsolute } from 'node:path'

export interface BuildChildEnvironmentOptions {
  host: NodeJS.ProcessEnv
  runtimeBinPaths: string[]
  homeDir: string
  tempDir: string
}

export function buildChildEnvironment(
  options: BuildChildEnvironmentOptions,
): Record<string, string> {
  const runtimeBinPaths = options.runtimeBinPaths.map((path) => {
    if (!isAbsolute(path)) throw invalidRuntimeBinPath()
    try {
      return realpathSync(path)
    } catch (cause) {
      throw invalidRuntimeBinPath(cause)
    }
  })

  return {
    HOME: options.homeDir,
    LANG: 'C.UTF-8',
    PATH: runtimeBinPaths.join(delimiter),
    TMPDIR: options.tempDir,
  }
}

function invalidRuntimeBinPath(cause?: unknown): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CHILD_PATH_INVALID',
    category: 'safety',
    message: '子进程 PATH 只能包含存在的绝对 Runtime 路径',
    retryable: false,
    cause,
  })
}
