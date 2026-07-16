import { E2EError } from '@mutil-skills/e2e-contracts'
import { realpathSync } from 'node:fs'
import { delimiter, isAbsolute } from 'node:path'

declare const supervisedChildEnvironmentBrand: unique symbol

export interface SupervisedChildEnvironment extends Record<string, string> {
  readonly HOME: string
  readonly LANG: 'C.UTF-8'
  readonly PATH: string
  readonly TMPDIR: string
  readonly [supervisedChildEnvironmentBrand]: true
}

const issuedEnvironments = new WeakSet<object>()
const SUPERVISED_ENVIRONMENT_KEYS = ['HOME', 'LANG', 'PATH', 'TMPDIR'] as const

export interface BuildChildEnvironmentOptions {
  host: NodeJS.ProcessEnv
  runtimeBinPaths: string[]
  homeDir: string
  tempDir: string
}

export function buildChildEnvironment(
  options: BuildChildEnvironmentOptions,
): SupervisedChildEnvironment {
  const runtimeBinPaths = new Set(options.runtimeBinPaths.map((path) => {
    if (!isAbsolute(path)) throw invalidRuntimeBinPath()
    try {
      return realpathSync(path)
    } catch (cause) {
      throw invalidRuntimeBinPath(cause)
    }
  }))

  const environment = {
    HOME: options.homeDir,
    LANG: 'C.UTF-8' as const,
    PATH: [...runtimeBinPaths].join(delimiter),
    TMPDIR: options.tempDir,
  } as SupervisedChildEnvironment
  issuedEnvironments.add(environment)
  return Object.freeze(environment)
}

export function validateSupervisedChildEnvironment(
  environment: Record<string, string>,
): SupervisedChildEnvironment {
  const actualKeys = Object.keys(environment).sort()
  if (!issuedEnvironments.has(environment)
    || actualKeys.length !== SUPERVISED_ENVIRONMENT_KEYS.length
    || SUPERVISED_ENVIRONMENT_KEYS.some((key, index) => actualKeys[index] !== key)
    || SUPERVISED_ENVIRONMENT_KEYS.some((key) => typeof environment[key] !== 'string')
    || environment.LANG !== 'C.UTF-8'
    || !hasCanonicalUniquePath(environment.PATH)) {
    throw invalidChildEnvironment()
  }
  return environment as SupervisedChildEnvironment
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

function hasCanonicalUniquePath(value: string): boolean {
  const paths = value.split(delimiter)
  if (paths.length === 0 || paths.some((path) => path.length === 0)) return false
  const seen = new Set<string>()
  try {
    for (const path of paths) {
      if (!isAbsolute(path) || realpathSync(path) !== path || seen.has(path)) return false
      seen.add(path)
    }
    return true
  } catch {
    return false
  }
}

function invalidChildEnvironment(): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_CHILD_ENV_INVALID',
    category: 'safety',
    message: 'Runtime 子进程环境必须由固定 policy 构造',
    retryable: false,
  })
}
