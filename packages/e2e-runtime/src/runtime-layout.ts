import { join } from 'node:path'

export interface RuntimeLayout {
  root: string
  versions: string
  current: string
  installLock: string
  bin: string
  state: string
  authority: string
  quarantine: string
  logs: string
  browsers: string
  browserInstallLock: string
}

export function runtimeLayout(homeDir: string): RuntimeLayout {
  const productRoot = join(homeDir, '.mutil-skills')
  const runtimeRoot = join(productRoot, 'runtime', 'e2e')
  return {
    root: runtimeRoot,
    versions: join(runtimeRoot, 'versions'),
    current: join(runtimeRoot, 'current.json'),
    installLock: join(runtimeRoot, 'install.lock'),
    bin: join(productRoot, 'bin', 'repo-e2e'),
    state: join(productRoot, 'e2e', 'state'),
    authority: join(productRoot, 'e2e', 'authority'),
    quarantine: join(productRoot, 'e2e', 'quarantine'),
    logs: join(productRoot, 'e2e', 'logs'),
    browsers: join(runtimeRoot, 'browsers'),
    browserInstallLock: join(runtimeRoot, 'browser-install.lock'),
  }
}
