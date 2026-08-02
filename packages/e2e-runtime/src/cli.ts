import {
  ApprovalGrantSubjectSchema,
  E2EError,
  canonicalizeJson,
  canonicalGrantApprovalType,
  digestText,
  type ApprovalGrantSubject,
} from '@mutil-skills/e2e-contracts'
import {
  EncryptedQuarantine,
  InMemoryQuarantineAuditLog,
  PatternPrivacyScanner,
  createTrustedCompilerReadiness,
} from '@mutil-skills/e2e-engine'
import {
  createTrustedCompilerProjectorTrust,
  projectCompilerInputFromArtifacts,
  TRUSTED_TYPESCRIPT_VERSION,
} from '@mutil-skills/e2e-playwright-runtime'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Readable, type Writable } from 'node:stream'
import {
  installRuntime as installRuntimeDefault,
  type InstallRuntimeOptions,
  type RuntimeInstallResult,
} from './runtime-installer.js'
import {
  uninstallRuntime as uninstallRuntimeDefault,
  type RuntimeUninstallResult,
  type UninstallRuntimeOptions,
} from './runtime-uninstaller.js'
import {
  inspectRuntimeInstallation as inspectRuntimeInstallationDefault,
  type InspectRuntimeInstallationOptions,
  type RuntimeInstallation,
} from './runtime-discovery.js'
import {
  runRuntimeDoctor as runRuntimeDoctorDefault,
  runtimeDoctorFailureReport,
  type RunRuntimeDoctorOptions,
  type RuntimeDoctorReport,
} from './runtime-doctor.js'
import { isExactRuntimeVersion } from './runtime-manifest.js'
import { E2ERuntimeHost } from './runtime-host.js'
import { ProjectPublisher } from './project-publisher.js'
import { StandaloneEvidencePublisher } from './standalone-evidence-publisher.js'
import { RuntimeRunStore, type RuntimeRunSnapshot } from './run-store.js'
import { persistFinalizedApprovalOutcome } from './finalized-approval-outcome.js'
import { assertSameProjectIdentity, resolveProjectIdentity } from './project-identity.js'
import { SecureProjectFileReader } from './secure-project-files.js'
import { RuntimeSecretBroker } from './secret-broker.js'
import { installChromium as installChromiumDefault, type InstallChromiumOptions } from './browser-installer.js'
import {
  bootstrapInstalledBrowserRuntime,
  createProductionBrowserCapabilities,
  createProductionTargetProbeCapability,
  createProductionFullPlaywrightBrowserCapability,
  createProductionInjectionBrowserCapability,
  createProductionWriteBrowserCapability,
} from './runtime-browser-wiring.js'
import { RuntimeQuarantineSecretProvider } from './quarantine-secret-provider.js'
import { createProductionEvidenceQuarantine } from './runtime-evidence-quarantine.js'
import { RuntimeFinalizationMaterialSealer,
  authorizeRuntimeFinalizationMaterialSealer } from './runtime-finalization-material-sealer.js'
import { ProductionFinalizationMaterialProvider } from './production-finalization-material-provider.js'
import { ProductionGenerationFinalizer } from './production-generation-finalizer.js'
import { RegressionPublisher } from './regression-publisher.js'
import { GenerationAssembler } from './generation-assembler.js'
import { runtimeLayout } from './runtime-layout.js'
import {
  ApprovalModeSchema,
  readApprovalMode,
  writeApprovalMode as writeApprovalModeDefault,
  writeBrowserSelection,
  type ApprovalMode,
  type BrowserSelection,
} from './runtime-user-config.js'
import { discoverSystemChrome, inspectSystemChrome } from './system-chrome.js'
import { inspectRuntimeCapabilityProof } from './runtime-capability-proof.js'
import {
  openRuntimeWriteProduction,
  type OpenRuntimeWriteProductionResult,
} from './runtime-write-production-wiring.js'
import {
  MAX_SECRET_BYTES,
  SECRET_REF_PATTERN,
  SECRET_RUN_ID_PATTERN,
} from './secret-contract.js'
import {
  computeRuntimeApprovalSubjectDigest,
  createRuntimeLocalApprovalHost,
  openRuntimeArtifactStoreAuthority,
  startRuntimeAuthorityHost,
  type RuntimeArtifactStoreAuthority,
  type RuntimeAuthorityHost,
  type RuntimeAuthoritySession,
} from './authority-host.js'
import { approvalModeFromTrustedFacts } from './local-approval-confirmations.js'
import {
  RUNTIME_PACKAGE_VERSION,
  exitCodeForResponse,
  parseRuntimeRequest,
  runtimeErrorResponse,
  serializeRuntimeDoctorReport,
} from './protocol.js'

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SECRET_RUN_ID = SECRET_RUN_ID_PATTERN
const SECRET_REF = SECRET_REF_PATTERN

export interface SecretTerminalAdapter {
  readonly isTTY: boolean
  readonly isRaw?: boolean
  setRawMode(enabled: boolean): void
  read(): AsyncIterable<Uint8Array>
}

interface CliSecretBroker {
  provide(input: { runId: string; secretRef: string; value: Uint8Array }): Promise<void>
  close(): Promise<void>
}

export interface RuntimeCliDependencies {
  homeDir: string
  installRuntime: (options: InstallRuntimeOptions) => Promise<RuntimeInstallResult>
  uninstallRuntime: (options: UninstallRuntimeOptions) => Promise<RuntimeUninstallResult>
  inspectRuntimeInstallation?: (options: InspectRuntimeInstallationOptions) => Promise<RuntimeInstallation>
  runRuntimeDoctor?: (options: RunRuntimeDoctorOptions) => Promise<RuntimeDoctorReport>
  serializeRuntimeDoctorReport?: (report: unknown) => string
  runtimeHost?: Pick<E2ERuntimeHost, 'handle'>
  openHumanAuthoritySession?: (arguments_: string[]) => Promise<RuntimeAuthoritySession>
  startAuthorityHost?: (options: {
    homeDir: string
    installation: RuntimeInstallation
    subject: string
    approvalSessionTtlMs?: number
  }) => Promise<RuntimeAuthorityHost>
  openRunStore?: typeof RuntimeRunStore.open
  currentWorkingDirectory?: () => string
  approvalSessionTtlMs?: number
  secretTerminal?: SecretTerminalAdapter
  validateSecretRun?: (runId: string) => Promise<void>
  openSecretBroker?: (options: {
    homeDir: string
    projectRoot: string
  }) => Promise<CliSecretBroker>
  installChromium?: (options: InstallChromiumOptions) => Promise<unknown>
  configureSystemBrowser?: (input: {
    homeDir: string
    projectRoot: string
    executablePath?: string
  }) => Promise<BrowserSelection>
  writeApprovalMode?: (homeDir: string, mode: ApprovalMode) => Promise<void>
  /** 仅供替换人类 Authority session 的测试同步模拟目标 Run 冻结模式。 */
  readHumanRunApprovalMode?: (arguments_: string[]) => Promise<ApprovalMode>
  bootstrapBrowserRuntime?: typeof bootstrapInstalledBrowserRuntime
  projectPublisherFactory?: (projectRoot: string) => Pick<ProjectPublisher, 'renderActiveReport'>
  /**
   * 仅供已安装 Runtime 的隔离验收宿主注入与审批使用同一持久 Authority；
   * 普通 CLI 始终使用 openRuntimeArtifactStoreAuthority 的生产默认实现。
   */
  openArtifactStoreAuthority?: typeof openRuntimeArtifactStoreAuthority
  /** 仅用于测试替换生产恢复装配；默认始终打开持久 Run/Authority/owned-resource adapters。 */
  openWriteProduction?: typeof openRuntimeWriteProduction
}

export async function runCli(
  arguments_: string[],
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
  dependencies: RuntimeCliDependencies = defaultDependencies(),
): Promise<number> {
  const responseWriter = new SingleJsonResponseWriter(stdout)
  if (arguments_.length === 1 && arguments_[0] === '--version') {
    await writeText(stdout, `${RUNTIME_PACKAGE_VERSION}\n`)
    return 0
  }

  if (arguments_[0] === 'report') {
    if (arguments_.length !== 3 || arguments_[1] !== '--run-id' || !SAFE_ID.test(arguments_[2]!)) {
      return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
        code: 'E2E_RUNTIME_REQUEST_INVALID', category: 'input',
        message: 'report 只接受 --run-id <safe-id>', retryable: false,
      }))
    }
    const requestBytes = Buffer.from(canonicalizeJson({
      schemaVersion: '1.0.0', requestId: `REPORT-${randomUUID()}`,
      client: { name: 'repo-e2e-cli', version: RUNTIME_PACKAGE_VERSION },
      command: 'render-report',
      projectRoot: (dependencies.currentWorkingDirectory ?? process.cwd)(),
      payload: { runId: arguments_[2] },
    }))
    return await runCli(
      ['rpc'], Readable.from([requestBytes]), stdout, stderr, dependencies,
    )
  }

  if (arguments_[0] === 'install-runtime' || arguments_[0] === 'uninstall-runtime') {
    return runInstallManagementCommand(arguments_, responseWriter, dependencies)
  }

  if (arguments_[0] === 'configure-browser') {
    const explicit = arguments_.length === 4 && arguments_[1] === '--system'
      && arguments_[2] === '--executable' && isAbsolute(arguments_[3]!)
    const discovered = arguments_.length === 2 && arguments_[1] === '--system'
    if (!explicit && !discovered) return writeErrorResponse(responseWriter, 'CONFIGURE-BROWSER', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID', category: 'input',
      message: 'configure-browser 只接受 --system [--executable <absolute>]', retryable: false,
    }))
    try {
      const selection = await (dependencies.configureSystemBrowser ?? configureSystemBrowserDefault)({
        homeDir: dependencies.homeDir,
        projectRoot: (dependencies.currentWorkingDirectory ?? process.cwd)(),
        ...(explicit ? { executablePath: arguments_[3]! } : {}),
      })
      await responseWriter.write(`${canonicalizeJson({ ok: true, result: {
        configured: true, browserSource: selection.source.kind,
        browserVersion: selection.browserVersion,
        executableDigest: selection.executableDigest,
        controlledLaunchProofDigest: selection.controlledLaunchProofDigest,
      } })}\n`)
      return 0
    } catch (error) {
      return writeErrorResponse(responseWriter, 'CONFIGURE-BROWSER', error instanceof E2EError ? error : new E2EError({
        code: 'E2E_SYSTEM_CHROME_CONFIGURATION_FAILED', category: 'environment',
        message: '系统 Chrome 受控配置失败；不会自动下载托管 Chromium', retryable: false, cause: error,
      }))
    }
  }

  if (arguments_[0] === 'configure-approval') {
    const mode = arguments_.length === 3 && arguments_[1] === '--mode'
      ? ApprovalModeSchema.safeParse(arguments_[2]) : undefined
    if (mode === undefined || !mode.success) return writeErrorResponse(responseWriter, 'CONFIGURE-APPROVAL', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID', category: 'input',
      message: 'configure-approval 只接受 --mode local-confirmation|webauthn', retryable: false,
    }))
    await (dependencies.writeApprovalMode ?? writeApprovalModeDefault)(dependencies.homeDir, mode.data)
    await responseWriter.write(`${canonicalizeJson({ ok: true, result: {
      configured: true, approvalMode: mode.data,
    } })}\n`)
    return 0
  }

  if (arguments_.length === 1 && arguments_[0] === 'install-browser') {
    try {
      const installation = await (dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault)({
        homeDir: dependencies.homeDir,
      })
      const result = await (dependencies.installChromium ?? installChromiumDefault)({
        homeDir: dependencies.homeDir,
        runtimeVersion: installation.version,
        runtimeInstallationDigest: installation.installationDigest,
      })
      await (dependencies.bootstrapBrowserRuntime ?? bootstrapInstalledBrowserRuntime)({
        homeDir: dependencies.homeDir, installation,
        browserInstallation: result as Awaited<ReturnType<typeof installChromiumDefault>>,
        prepareAuthorityRoot: async () => {
          await prepareBrowserBootstrapAuthorityRoot({
            homeDir: dependencies.homeDir, installation,
            openAuthority: dependencies.openArtifactStoreAuthority ?? openRuntimeArtifactStoreAuthority,
          })
        },
      })
      if (isRecord(result) && isRecord(result.manifest)) {
        const manifest = result.manifest
        const valid = typeof manifest.chromiumVersion === 'string'
          && typeof manifest.executableDigest === 'string'
          && typeof manifest.closureDigest === 'string'
          && typeof manifest.runtimeInstallationDigest === 'string'
        if (valid) {
          const proof = await inspectRuntimeCapabilityProof({
            homeDir: dependencies.homeDir,
            runtimeInstallationDigest: installation.installationDigest,
          }).catch((error) => {
            if (dependencies.bootstrapBrowserRuntime !== undefined) return undefined
            throw error
          })
          if (proof !== undefined) await writeBrowserSelection(dependencies.homeDir, {
            schemaVersion: '1.0.0',
            source: {
              kind: 'managed-chromium',
              installationId: `${installation.version}-${process.platform}-${process.arch}`,
            },
            browserVersion: manifest.chromiumVersion as string,
            executableDigest: manifest.executableDigest as string,
            runtimeInstallationDigest: installation.installationDigest,
            controlledLaunchProofDigest: proof.proofDigest,
            configuredAt: new Date().toISOString(),
          })
        }
      }
      await responseWriter.write(`${canonicalizeJson({
        ok: true,
        result: publicBrowserInstallResult(result, installation),
      })}\n`)
      return 0
    } catch (error) {
      return writeErrorResponse(responseWriter, 'INSTALL-BROWSER', error instanceof E2EError ? error : new E2EError({
        code: 'E2E_CHROMIUM_INSTALL_FAILED', category: 'environment',
        message: '固定 Chromium 安装失败', retryable: false, cause: error,
      }))
    }
  }

  if (arguments_[0] === 'secret') {
    return await runSecretCommand(arguments_, stdin, responseWriter, dependencies)
  }

  if (isHumanAuthorityCommand(arguments_)) {
    try {
      if (arguments_[0] === 'approve' && dependencies.openHumanAuthoritySession !== undefined
        && await dependencies.readHumanRunApprovalMode?.(arguments_) === 'local-confirmation') {
        throw new E2EError({
          code: 'E2E_LOCAL_APPROVAL_RPC_REQUIRED', category: 'input',
          message: '本地确认必须由 Skill 依次调用 rpc open-approval、展示 summary，再调用 confirm-approval；不得伪装成 WebAuthn session',
          retryable: false,
        })
      }
      const session = await (dependencies.openHumanAuthoritySession?.(arguments_)
        ?? openDefaultHumanAuthoritySession(arguments_, dependencies))
      if (session.url !== '') await writeText(stderr, `${session.url}\n`)
      const outcome = await session.wait()
      await responseWriter.write(`${canonicalizeJson(
        outcome ?? { sessionId: session.sessionId, status: 'verified' },
      )}\n`)
      return 0
    } catch (error) {
      const runtimeError = error instanceof E2EError ? error : new E2EError({
        code: 'E2E_APPROVAL_USER_PRESENCE_UNAVAILABLE',
        category: 'safety',
        message: 'WebAuthn 用户在场流程失败',
        retryable: false,
        cause: error,
      })
      return writeErrorResponse(responseWriter, 'UNKNOWN', runtimeError)
    }
  }

  if ((arguments_.length === 1 && arguments_[0] === 'doctor')
    || (arguments_.length === 2 && arguments_[0] === 'doctor' && arguments_[1] === '--json')) {
    let report: RuntimeDoctorReport
    try {
      const installation = await (dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault)({
        homeDir: dependencies.homeDir,
      })
      report = await (dependencies.runRuntimeDoctor ?? runRuntimeDoctorDefault)({
        installation, homeDir: dependencies.homeDir,
      })
    } catch {
      report = runtimeDoctorFailureReport(RUNTIME_PACKAGE_VERSION)
    }
    if (arguments_.length === 2) {
      let serialized: string
      try {
        serialized = (dependencies.serializeRuntimeDoctorReport ?? serializeRuntimeDoctorReport)(report)
      } catch {
        report = runtimeDoctorFailureReport(RUNTIME_PACKAGE_VERSION)
        serialized = serializeRuntimeDoctorReport(report)
      }
      await responseWriter.write(`${serialized}\n`)
    } else {
      await writeText(stderr, formatDoctorReport(report))
    }
    return report.ready ? 0 : 3
  }

  if (arguments_.length !== 1 || arguments_[0] !== 'rpc') {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: '只支持 --version、rpc 或显式 Runtime 安装管理命令',
      retryable: false,
    }))
  }

  let json = ''
  try {
    const requestBytes = await readBytes(stdin)
    json = decodeRequestBytes(requestBytes)
    const request = parseRuntimeRequest(json)
    if (dependencies.runtimeHost !== undefined) {
      const response = await dependencies.runtimeHost.handle(request, requestBytes)
      await responseWriter.write(`${canonicalizeJson(response)}\n`)
      return exitCodeForResponse(response)
    }
    let installation: RuntimeInstallation
    try {
      installation = await (dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault)({
        homeDir: dependencies.homeDir,
      })
    } catch (cause) {
      throw new E2EError({
        code: 'E2E_RUNTIME_NOT_INSTALLED',
        category: 'environment',
        message: 'E2E Runtime Host 尚未安装或 active installation 无法验证',
        retryable: false,
        cause,
      })
    }
    const projectRoot = 'projectRoot' in request ? request.projectRoot : undefined
    const configuredApprovalMode = (await readApprovalMode(dependencies.homeDir)).mode
    const runStore = await RuntimeRunStore.open({
      homeDir: dependencies.homeDir,
      ...(projectRoot === undefined ? {} : { projectRoot }),
    })
    let authorityHost: RuntimeAuthorityHost | undefined
    let artifactAuthority: RuntimeArtifactStoreAuthority | undefined
    let executionSecretBroker: RuntimeSecretBroker | undefined
    let quarantineSecretProvider: RuntimeQuarantineSecretProvider | undefined
    let quarantine: EncryptedQuarantine | undefined
    let writeProduction: OpenRuntimeWriteProductionResult | undefined
    let response: Awaited<ReturnType<E2ERuntimeHost['handle']>> | undefined
    let processingError: unknown
    try {
      const needsBrowserExecution = request.command === 'run-preflight' || request.command === 'execute-run'
      const getAuthorityHost = async () => {
        if (authorityHost !== undefined) return authorityHost
        authorityHost = await (dependencies.startAuthorityHost ?? startRuntimeAuthorityHost)({
          homeDir: dependencies.homeDir, installation, subject: localAuthoritySubject(),
          ...(dependencies.approvalSessionTtlMs === undefined
            ? {} : { approvalSessionTtlMs: dependencies.approvalSessionTtlMs }),
        })
        return authorityHost
      }
      const getArtifactAuthority = async () => {
        if (artifactAuthority !== undefined) return artifactAuthority
        artifactAuthority = await (dependencies.openArtifactStoreAuthority
          ?? openRuntimeArtifactStoreAuthority)({
          homeDir: dependencies.homeDir, installation, subject: localAuthoritySubject(),
        })
        return artifactAuthority
      }
      const browserCapabilities = !needsBrowserExecution ? undefined : createProductionBrowserCapabilities({
        homeDir: dependencies.homeDir, projectRoot: request.projectRoot,
        installation, authorityHost: getAuthorityHost,
      })
      const targetProbe = request.command !== 'probe-target' ? undefined
        : createProductionTargetProbeCapability({
          homeDir: dependencies.homeDir,
          projectRoot: request.projectRoot,
          installation,
        })
      // 生产执行资源只能在 Host 的最外层 workflow 前置条件可能通过时装配。
      // 这里仅做只读短路；最终判定仍由持锁的 E2ERuntimeHost 完成，避免无效请求
      // 提前创建后端、密钥代理或隔离区并把输入错误污染成 cleanup/internal 错误。
      let executeRunMayReachExecutor = true
      let executeSnapshot: RuntimeRunSnapshot | undefined
      if (request.command === 'execute-run' || request.command === 'resume-run') {
        const executionIdentity = await resolveProjectIdentity(request.projectRoot)
        executeSnapshot = await runStore.getRun(executionIdentity.digest, request.payload.runId)
        if (request.command === 'execute-run') {
          executeRunMayReachExecutor = executeSnapshot?.workflow.current === 'compiled'
        }
      }
      const resumeUsesFullPlaywright = request.command === 'resume-run'
        && executeSnapshotUsesFullPlaywright(executeSnapshot)
      let writeExecutor
      let fullPlaywrightExecutor
      let injectionExecutor
      let evidenceQuarantine
      if (((request.command === 'execute-run' && executeRunMayReachExecutor)
          || request.command === 'resume-run')
        && projectRoot !== undefined) {
        writeProduction = await (dependencies.openWriteProduction ?? openRuntimeWriteProduction)({
          homeDir: dependencies.homeDir,
          projectRoot,
          installation,
          runStore,
          ...(dependencies.startAuthorityHost === undefined ? {} : {
            startAuthorityHost: dependencies.startAuthorityHost,
          }),
          ...(dependencies.openArtifactStoreAuthority === undefined ? {} : {
            openArtifactAuthority: dependencies.openArtifactStoreAuthority,
          }),
        })
      }
      if ((request.command === 'execute-run' && executeRunMayReachExecutor)
        || resumeUsesFullPlaywright
        || request.command === 'finalize-run') {
        const executionIdentity = await resolveProjectIdentity(request.projectRoot)
        const fullPlaywright = (request.command === 'execute-run' || request.command === 'resume-run')
          && executeSnapshotUsesFullPlaywright(executeSnapshot)
        if (request.command === 'execute-run' || request.command === 'resume-run') executionSecretBroker = await RuntimeSecretBroker.open({
          homeDir: dependencies.homeDir, projectRoot: executionIdentity.realRoot,
        })
        quarantineSecretProvider = await RuntimeQuarantineSecretProvider.createForProject({
          homeDir: dependencies.homeDir,
          projectRoot: executionIdentity.realRoot,
        })
        quarantine = new EncryptedQuarantine({
          root: runtimeLayout(dependencies.homeDir).quarantine,
          secrets: quarantineSecretProvider,
          audit: new InMemoryQuarantineAuditLog(),
          now: () => new Date(),
        })
        if (request.command === 'execute-run' && !fullPlaywright) writeExecutor = createProductionWriteBrowserCapability({
          homeDir: dependencies.homeDir,
          projectRoot: request.projectRoot,
          installation,
          authorityHost: getAuthorityHost,
          secretBroker: executionSecretBroker!,
          writeProduction: writeProduction!.capability,
        })
        if ((request.command === 'execute-run' || request.command === 'resume-run') && fullPlaywright) {
          const artifacts = await getArtifactAuthority()
          fullPlaywrightExecutor = createProductionFullPlaywrightBrowserCapability({
            homeDir: dependencies.homeDir, projectRoot: request.projectRoot, installation,
            authorityHost: getAuthorityHost, writeProduction: writeProduction!.capability,
            freshnessAuthority: artifacts.createTrustedApprovalFreshnessClient(),
            freshnessIssuer: artifacts,
            checkpointSigner: { signDigest: (digest) => artifacts.signDigest(digest) },
            checkpointAuthority: { material: artifacts.artifactVerifierMaterial,
              expectedPublicKeyDigest: artifacts.artifactVerifierMaterial.publicKeyDigest },
            secretBroker: executionSecretBroker!,
          })
        }
        if (request.command === 'execute-run' && !fullPlaywright) injectionExecutor = createProductionInjectionBrowserCapability({
          homeDir: dependencies.homeDir,
          projectRoot: request.projectRoot,
          installation,
          authorityHost: getAuthorityHost,
        })
        if (request.command === 'execute-run' || request.command === 'resume-run') {
          evidenceQuarantine = createProductionEvidenceQuarantine({ quarantine })
        }
      }
      if ((request.command === 'render-report' || request.command === 'finalize-run')
        && dependencies.projectPublisherFactory === undefined) {
        artifactAuthority = await getArtifactAuthority()
      }
      const projectPublisherFactory = dependencies.projectPublisherFactory ?? (artifactAuthority === undefined
        ? undefined
        : (root: string) => new ProjectPublisher({
            projectRoot: root,
            scanner: new PatternPrivacyScanner(RUNTIME_PACKAGE_VERSION),
            authority: artifactAuthority!,
          }))
      let generationFinalizer
      let finalizationMaterialSealer
      if (request.command === 'finalize-run') {
        if (artifactAuthority === undefined || quarantine === undefined || projectPublisherFactory === undefined) {
          throw new E2EError({ code: 'E2E_RUNTIME_FINALIZER_NOT_READY', category: 'environment',
            message: '生产最终化依赖未就绪', retryable: false })
        }
        const snapshot = await runStore.getRun(
          (await resolveProjectIdentity(request.projectRoot)).digest, request.payload.runId,
        )
        if (snapshot === undefined) throw new E2EError({ code: 'E2E_RUNTIME_RUN_NOT_FOUND', category: 'input',
          message: 'Run 不存在', retryable: false })
        const tempParent = join(runtimeLayout(dependencies.homeDir).logs, 'regression')
        await mkdir(tempParent, { recursive: true, mode: 0o700 })
        const regressionPublisher = await RegressionPublisher.create({
          issuer: 'e2e-runtime-regression', keyId: `regression-${snapshot.runId}`, tempParent,
        })
        const provider = new ProductionFinalizationMaterialProvider({
          quarantine: {
            readEvidence: async ({ runId, relativePath }) => await quarantine!.readEvidence({
              runId, relativePath,
              actor: { subject: 'runtime:finalization-material-provider', roles: ['e2e-sanitizer'] },
            }),
          },
          authority: artifactAuthority,
          projectCompilerInput: ({ artifacts }) => {
            const readinessArtifacts = artifacts.filter((artifact) =>
              ['prd-manifest', 'prd-diff', 'acceptance-scope'].includes(artifact.artifactType))
            const readiness = createTrustedCompilerReadiness({
              artifacts: readinessArtifacts, contractsVersion: '2.0.0',
              verifyArtifactSignature: artifactAuthority!.verifySignature,
              verifyDecisionReceipt: artifactAuthority!.verifyDecisionReceipt,
            })
            const trust = createTrustedCompilerProjectorTrust({
              artifactAuthority: { material: artifactAuthority!.artifactVerifierMaterial,
                expectedPublicKeyDigest: artifactAuthority!.artifactVerifierMaterial.publicKeyDigest },
              approvalFreshnessAuthority: { material: artifactAuthority!.approvalFreshnessVerifierMaterial,
                expectedPublicKeyDigest: artifactAuthority!.approvalFreshnessVerifierMaterial.publicKeyDigest },
              readiness,
            })
            return projectCompilerInputFromArtifacts({
              artifacts: artifacts.filter((artifact) => [
                'prd-manifest', 'prd-diff', 'acceptance-scope', 'project-policy',
                'requirement-model', 'coverage-universe', 'test-cases', 'browser-action-map',
                'execution-contract', 'run-bundle', 'approval-grants',
              ].includes(artifact.artifactType)),
              nodeVersion: process.versions.node, playwrightVersion: '1.61.1',
              typescriptVersion: TRUSTED_TYPESCRIPT_VERSION, trust,
            })
          },
        })
        const assembler = new GenerationAssembler({
          reportPresentation: { title: 'E2E 验收报告', injectionBoundary: '由材料提供者绑定。',
            recommendations: [], regressionCommand: 'npx playwright test',
            browser: { version: '1.61.1', channel: 'chromium' } },
          gatewayVerifier: () => false, sanitizerVerifier: () => false,
          privacyReviewVerifier: () => false, regressionDiscoveryVerifier: () => false,
          attemptProofVerifier: () => false,
        })
        const publisher = projectPublisherFactory(request.projectRoot)
        generationFinalizer = new ProductionGenerationFinalizer({
          materialProvider: provider, regressionPublisher, assembler,
          projectPublisher: publisher as ProjectPublisher, quarantine,
        }).capability()
        finalizationMaterialSealer = authorizeRuntimeFinalizationMaterialSealer(
          new RuntimeFinalizationMaterialSealer({
            quarantine, authority: artifactAuthority,
            runtimeVersion: RUNTIME_PACKAGE_VERSION, contractsVersion: RUNTIME_PACKAGE_VERSION,
            engineVersion: RUNTIME_PACKAGE_VERSION, playwrightVersion: '1.61.1',
          }),
        )
      }
      const host = new E2ERuntimeHost({
        installation,
        doctor: async () => await (dependencies.runRuntimeDoctor ?? runRuntimeDoctorDefault)({
          installation, homeDir: dependencies.homeDir,
        }),
        runStore,
        now: () => new Date(),
        approvalMode: configuredApprovalMode,
        ...(request.command !== 'submit-candidate' ? {} : {
          reserveExecutionLeases: async (input) => await (
            await getArtifactAuthority()
          ).reserveExecutionLeases(input),
        }),
        ...(browserCapabilities === undefined ? {} : {
          preflightExecutor: browserCapabilities.preflight,
          readExecutor: browserCapabilities.read,
        }),
        ...(targetProbe === undefined ? {} : { targetProbe }),
        ...(writeExecutor === undefined ? {} : { writeExecutor }),
        ...(fullPlaywrightExecutor === undefined ? {} : { fullPlaywrightExecutor }),
        ...(injectionExecutor === undefined ? {} : { injectionExecutor }),
        ...(evidenceQuarantine === undefined ? {} : { evidenceQuarantine }),
        ...(generationFinalizer === undefined ? {} : { generationFinalizer }),
        ...(finalizationMaterialSealer === undefined ? {} : { finalizationMaterialSealer }),
        ...(writeProduction === undefined ? {} : { writeProduction: writeProduction.capability }),
        ...(!['open-approval', 'confirm-approval', 'prepare-manual-result', 'finalize-manual-result-role']
          .includes(request.command) || configuredApprovalMode !== 'webauthn' ? {} : {
          authorityHostFactory: async () => {
            return await getAuthorityHost()
          },
          presentUserPresenceUrl: async (url: string) => await writeText(stderr, `${url}\n`),
        }),
        ...(!['open-approval', 'confirm-approval', 'prepare-manual-result',
          'finalize-manual-result-role'].includes(request.command)
          || configuredApprovalMode !== 'local-confirmation' ? {} : {
          localAuthorityHostFactory: async () => createRuntimeLocalApprovalHost(
            await getArtifactAuthority(),
          ),
        }),
        ...(projectPublisherFactory === undefined ? {} : {
          projectPublisherFactory,
        }),
        ...(request.command !== 'render-report' ? {} : {
          standaloneEvidencePublisher: new StandaloneEvidencePublisher({
            homeDir: dependencies.homeDir,
          }),
        }),
      })
      response = await host.handle(request, requestBytes)
    } catch (error) {
      processingError = error
    }
    const cleanupErrors: unknown[] = []
    if (executionSecretBroker !== undefined) {
      try { await executionSecretBroker.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (quarantineSecretProvider !== undefined) {
      try { quarantineSecretProvider.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (authorityHost !== undefined) {
      try { await authorityHost.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (artifactAuthority !== undefined) {
      try { await artifactAuthority.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (writeProduction !== undefined) {
      try { await writeProduction.close() } catch (error) { cleanupErrors.push(error) }
    }
    try { await runStore.close() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new E2EError({
        code: 'E2E_RUNTIME_CLEANUP_FAILED',
        category: 'internal',
        message: 'Runtime 单请求资源未能完整关闭',
        retryable: false,
        cause: new AggregateError(
          processingError === undefined ? cleanupErrors : [processingError, ...cleanupErrors],
        ),
      })
    }
    if (processingError !== undefined) throw processingError
    if (response === undefined) throw new Error('Runtime response missing')
    await responseWriter.write(`${canonicalizeJson(response)}\n`)
    return exitCodeForResponse(response)
  } catch (error) {
    const runtimeError = error instanceof E2EError
      ? error
      : new E2EError({
          code: 'E2E_RUNTIME_INTERNAL_ERROR',
          category: 'internal',
          message: 'Runtime 处理请求时发生内部错误',
          retryable: false,
          cause: error,
        })
    return writeErrorResponse(responseWriter, requestIdFromUntrustedJson(json), runtimeError)
  }
}

function publicBrowserInstallResult(result: unknown, installation: RuntimeInstallation): Record<string, unknown> {
  const output: Record<string, unknown> = {
    installed: true,
    runtimeVersion: installation.version,
    runtimeInstallationDigest: installation.installationDigest,
  }
  if (!isRecord(result) || !isRecord(result.manifest)) return output
  const manifest = result.manifest
  if (manifest.playwrightVersion === '1.61.1') output.playwrightVersion = manifest.playwrightVersion
  if (typeof manifest.revision === 'string' && /^\d+$/.test(manifest.revision)) {
    output.chromiumRevision = manifest.revision
  }
  if (typeof manifest.closureDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(manifest.closureDigest)) {
    output.browserClosureDigest = manifest.closureDigest
  }
  if (typeof manifest.executableDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(manifest.executableDigest)) {
    output.browserExecutableDigest = manifest.executableDigest
  }
  return output
}

async function runSecretCommand(
  arguments_: string[],
  stdin: Readable,
  responseWriter: SingleJsonResponseWriter,
  dependencies: RuntimeCliDependencies,
): Promise<number> {
  if (arguments_.length !== 6 || arguments_[1] !== 'provide'
    || arguments_[2] !== '--run-id' || !SECRET_RUN_ID.test(arguments_[3]!)
    || arguments_[4] !== '--ref' || !SECRET_REF.test(arguments_[5]!)) {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID', category: 'input',
      message: 'secret provide 只接受 --run-id <safe-id> --ref <SAFE_REF>', retryable: false,
    }))
  }
  const terminal = dependencies.secretTerminal ?? terminalAdapterFor(stdin)
  if (!terminal.isTTY) {
    return writeErrorResponse(responseWriter, 'UNKNOWN', new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_TTY_REQUIRED', category: 'safety',
      message: '交互秘密只能从真实 TTY 隐藏输入读取', retryable: false,
    }))
  }
  const runId = arguments_[3]!
  const secretRef = arguments_[5]!
  const projectRoot = (dependencies.currentWorkingDirectory ?? process.cwd)()
  let secret: Buffer | undefined
  let broker: CliSecretBroker | undefined
  try {
    await (dependencies.validateSecretRun?.(runId)
      ?? validateDefaultSecretRun(dependencies.homeDir, projectRoot, runId))
    broker = await (dependencies.openSecretBroker ?? RuntimeSecretBroker.open)({
      homeDir: dependencies.homeDir,
      projectRoot,
    })
    secret = await readHiddenSecret(terminal)
    try {
      await broker.provide({ runId, secretRef, value: secret })
    } finally {
      secret.fill(0)
      secret = undefined
    }
    await broker.close()
    broker = undefined
    await responseWriter.write(`${canonicalizeJson({ runId, secretRef, status: 'stored' })}\n`)
    return 0
  } catch (cause) {
    if (broker !== undefined) {
      try { await broker.close() } catch { /* output remains a single sanitized error */ }
    }
    const error = cause instanceof E2EError ? cause : new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_FAILED', category: 'safety',
      message: '交互秘密未能安全保存', retryable: false,
    })
    return writeErrorResponse(responseWriter, 'UNKNOWN', error)
  } finally { secret?.fill(0) }
}

async function validateDefaultSecretRun(homeDir: string, projectRoot: string, runId: string): Promise<void> {
  const store = await RuntimeRunStore.open({ homeDir, projectRoot })
  try {
    const identity = await resolveProjectIdentity(projectRoot)
    if (await store.getRun(identity.digest, runId) === undefined) {
      throw new E2EError({
        code: 'E2E_SECRET_RUN_NOT_FOUND', category: 'input',
        message: 'secret provide 必须绑定当前项目中已存在的 Run', retryable: false,
      })
    }
  } finally { await store.close() }
}

function terminalAdapterFor(stdin: Readable): SecretTerminalAdapter {
  const candidate = stdin as Readable & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?(enabled: boolean): void
  }
  return {
    isTTY: candidate.isTTY === true && typeof candidate.setRawMode === 'function',
    get isRaw() { return candidate.isRaw === true },
    setRawMode(enabled: boolean) {
      if (typeof candidate.setRawMode !== 'function') throw new Error('TTY raw mode unavailable')
      candidate.setRawMode(enabled)
    },
    read: () => candidate,
  }
}

async function readHiddenSecret(terminal: SecretTerminalAdapter): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_SECRET_BYTES)
  let length = 0
  const originalRawMode = terminal.isRaw === true
  let restoreRequired = false
  let result: Buffer | undefined
  let failure: E2EError | undefined
  try {
    restoreRequired = true
    terminal.setRawMode(true)
    let completed = false
    for await (const raw of terminal.read()) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      try {
        for (const byte of chunk) {
          if (completed) continue
          if (byte === 0x03) throw new E2EError({
            code: 'E2E_SECRET_INTERACTIVE_INTERRUPTED', category: 'safety',
            message: '交互秘密输入已中断', retryable: false,
          })
          if (byte === 0x04 || byte === 0x0a || byte === 0x0d) { completed = true; continue }
          if (byte === 0x7f || byte === 0x08) {
            if (length > 0) { length -= 1; bytes[length] = 0 }
            continue
          }
          if (length >= MAX_SECRET_BYTES) throw new E2EError({
            code: 'E2E_SECRET_VALUE_TOO_LARGE', category: 'safety',
            message: '交互秘密超过 64KiB 上限', retryable: false,
          })
          bytes[length] = byte
          length += 1
        }
      } finally { chunk.fill(0) }
      if (completed) break
    }
    if (length === 0) throw new E2EError({
      code: 'E2E_SECRET_INPUT_INVALID', category: 'safety',
      message: '交互秘密不能为空', retryable: false,
    })
    result = Buffer.alloc(length)
    bytes.copy(result, 0, 0, length)
  } catch (cause) {
    failure = cause instanceof E2EError ? cause : new E2EError({
      code: 'E2E_SECRET_INTERACTIVE_FAILED', category: 'safety',
      message: '交互 TTY 读取失败', retryable: false,
    })
  } finally {
    bytes.fill(0)
    if (restoreRequired) {
      try { terminal.setRawMode(originalRawMode) } catch {
        result?.fill(0)
        failure ??= new E2EError({
          code: 'E2E_SECRET_INTERACTIVE_RESTORE_FAILED', category: 'safety',
          message: '交互 TTY 状态未能恢复', retryable: false,
        })
      }
    }
  }
  if (failure !== undefined) {
    result?.fill(0)
    throw failure
  }
  return result!
}

async function runInstallManagementCommand(
  arguments_: string[],
  responseWriter: SingleJsonResponseWriter,
  dependencies: RuntimeCliDependencies,
): Promise<number> {
  try {
    if (arguments_.some((argument) => [
      '--purge-state',
      '--purge-quarantine',
      '--purge-identity',
    ].includes(argument))) {
      throw installArgumentError('Runtime 卸载不得混入 state、quarantine 或 identity 销毁')
    }

    if (arguments_[0] === 'install-runtime') {
      if (arguments_.length !== 3 || arguments_[1] !== '--version' || !isExactRuntimeVersion(arguments_[2])) {
        throw installArgumentError('install-runtime 需要 --version <exact>')
      }
      const result = await dependencies.installRuntime({
        homeDir: dependencies.homeDir,
        version: arguments_[2],
      })
      await responseWriter.write(`${canonicalizeJson({
        version: result.version,
        installationDigest: result.installationDigest,
        launcher: result.launcher,
      })}\n`)
      return 0
    }

    const withoutReplacement = arguments_.length === 3
      && arguments_[1] === '--version'
      && isExactRuntimeVersion(arguments_[2])
    const withReplacement = arguments_.length === 5
      && arguments_[1] === '--version'
      && isExactRuntimeVersion(arguments_[2])
      && arguments_[3] === '--activate'
      && isExactRuntimeVersion(arguments_[4])
    if (!withoutReplacement && !withReplacement) {
      throw installArgumentError('uninstall-runtime 需要 --version <exact> [--activate <exact>]')
    }
    const result = await dependencies.uninstallRuntime({
      homeDir: dependencies.homeDir,
      version: arguments_[2]!,
      ...(withReplacement ? { activateVersion: arguments_[4]! } : {}),
    })
    await responseWriter.write(`${canonicalizeJson(result)}\n`)
    return 0
  } catch (error) {
    const runtimeError = error instanceof E2EError
      ? error
      : new E2EError({
          code: 'E2E_RUNTIME_INTERNAL_ERROR',
          category: 'internal',
          message: 'Runtime 安装管理发生内部错误',
          retryable: false,
          cause: error,
        })
    return writeErrorResponse(responseWriter, 'UNKNOWN', runtimeError)
  }
}

async function writeErrorResponse(
  responseWriter: SingleJsonResponseWriter,
  requestId: string,
  error: E2EError,
): Promise<number> {
  if (responseWriter.started) return 70
  const response = runtimeErrorResponse(requestId, error)
  try {
    await responseWriter.write(`${canonicalizeJson(response)}\n`)
  } catch {
    return 70
  }
  return exitCodeForResponse(response)
}

class SingleJsonResponseWriter {
  started = false

  constructor(private readonly stdout: Writable) {}

  async write(text: string): Promise<void> {
    if (this.started) throw new Error('Runtime stdout response has already started')
    this.started = true
    await writeText(this.stdout, text)
  }
}

async function readBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 4 * 1024 * 1024) throw new E2EError({
      code: 'E2E_RUNTIME_REQUEST_TOO_LARGE',
      category: 'input',
      message: 'Runtime RPC request 超过 4 MiB',
      retryable: false,
    })
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function decodeRequestBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new E2EError({
      code: 'E2E_RUNTIME_REQUEST_INVALID',
      category: 'input',
      message: 'Runtime request 必须是 UTF-8 JSON',
      retryable: false,
      cause,
    })
  }
}

async function writeText(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve())
  })
}

function requestIdFromUntrustedJson(json: string): string {
  try {
    const value = JSON.parse(json) as unknown
    if (isRecord(value) && typeof value.requestId === 'string' && SAFE_ID.test(value.requestId)) {
      return value.requestId
    }
  } catch {
    // The response still needs a schema-valid correlation value for malformed JSON.
  }
  return 'UNKNOWN'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function installArgumentError(message: string): E2EError {
  return new E2EError({
    code: 'E2E_RUNTIME_INSTALL_ARGUMENT_INVALID',
    category: 'input',
    message,
    retryable: false,
  })
}

function defaultDependencies(): RuntimeCliDependencies {
  return {
    homeDir: process.env.HOME ?? homedir(),
    installRuntime: installRuntimeDefault,
    uninstallRuntime: uninstallRuntimeDefault,
    inspectRuntimeInstallation: inspectRuntimeInstallationDefault,
    runRuntimeDoctor: runRuntimeDoctorDefault,
  }
}

async function configureSystemBrowserDefault(input: {
  homeDir: string
  projectRoot: string
  executablePath?: string
}): Promise<BrowserSelection> {
  const installation = await inspectRuntimeInstallationDefault({ homeDir: input.homeDir })
  const executablePath = input.executablePath ?? await discoverSystemChrome()
  const inspected = await inspectSystemChrome({
    executablePath,
    projectRoot: input.projectRoot,
    runtimeInstallationDigest: installation.installationDigest,
    controlledLaunchProofDigest: `sha256:${'0'.repeat(64)}`,
    configuredAt: new Date().toISOString(),
  })
  await bootstrapInstalledBrowserRuntime({
    homeDir: input.homeDir,
    installation,
    browserInstallation: inspected,
    prepareAuthorityRoot: async () => {
      await prepareBrowserBootstrapAuthorityRoot({
        homeDir: input.homeDir, installation,
        openAuthority: openRuntimeArtifactStoreAuthority,
      })
    },
  })
  const proof = await inspectRuntimeCapabilityProof({
    homeDir: input.homeDir,
    runtimeInstallationDigest: installation.installationDigest,
  })
  const selection = {
    ...inspected.selection,
    controlledLaunchProofDigest: proof.proofDigest,
    configuredAt: new Date().toISOString(),
  }
  await writeBrowserSelection(input.homeDir, selection)
  return selection
}

async function prepareBrowserBootstrapAuthorityRoot(input: {
  homeDir: string
  installation: RuntimeInstallation
  openAuthority: typeof openRuntimeArtifactStoreAuthority
}): Promise<void> {
  const authority = await input.openAuthority({
    homeDir: input.homeDir,
    installation: input.installation,
    subject: localAuthoritySubject(),
  })
  await authority.close()
}

function isHumanAuthorityCommand(arguments_: string[]): boolean {
  if (arguments_.length === 2 && arguments_[0] === 'identity' && arguments_[1] === 'enroll') return true
  if (arguments_[0] !== 'approve' || arguments_[1] !== '--run-id' || !SAFE_ID.test(arguments_[2]!)
    || arguments_[3] !== '--type' || !isApprovalType(arguments_[4])) return false
  const grantsCapability = arguments_[4] === 'discovery' || arguments_[4] === 'execution'
  return grantsCapability
    ? arguments_.length === 7 && arguments_[5] === '--subject-file' && Boolean(arguments_[6])
    : arguments_.length === 5
}

async function openDefaultHumanAuthoritySession(
  arguments_: string[],
  dependencies: RuntimeCliDependencies,
): Promise<RuntimeAuthoritySession> {
  const inspect = dependencies.inspectRuntimeInstallation ?? inspectRuntimeInstallationDefault
  const installation = await inspect({ homeDir: dependencies.homeDir })
  const startAuthority = async () => await (dependencies.startAuthorityHost ?? startRuntimeAuthorityHost)({
    homeDir: dependencies.homeDir, installation, subject: localAuthoritySubject(),
    ...(dependencies.approvalSessionTtlMs === undefined ? {} : {
      approvalSessionTtlMs: dependencies.approvalSessionTtlMs,
    }),
  })
  if (arguments_[0] === 'identity') {
    if ((await readApprovalMode(dependencies.homeDir)).mode !== 'webauthn') {
      throw new E2EError({
        code: 'E2E_WEBAUTHN_MODE_REQUIRED', category: 'input',
        message: 'identity enroll 仅用于 approvalMode=webauthn；默认本地确认无需登记身份',
        retryable: false,
      })
    }
    const authority = await startAuthority()
    try {
      return closeAuthorityAfterWait(await authority.enroll({ subject: localAuthoritySubject() }), authority)
    } catch (error) {
      return await closeResourcesAndRethrow(error, [authority])
    }
  }

  const projectRoot = (dependencies.currentWorkingDirectory ?? process.cwd)()
  let store: RuntimeRunStore
  try {
    store = await (dependencies.openRunStore ?? RuntimeRunStore.open)({
      homeDir: dependencies.homeDir, projectRoot,
    })
  } catch (error) {
    throw error
  }
  let authority: RuntimeAuthorityHost | undefined
  try {
    const identity = await resolveProjectIdentity(projectRoot)
    const runId = arguments_[2]!
    const initial = await readRunWithLease(store, identity.digest, runId)
    if (initial.runtimeInstallationDigest !== installation.installationDigest) {
      throw cliAuthorityError('E2E_RUNTIME_INSTALLATION_BINDING_MISMATCH')
    }
    if (approvalModeFromTrustedFacts(initial.trustedExecutionFacts) === 'local-confirmation') {
      throw new E2EError({
        code: 'E2E_LOCAL_APPROVAL_RPC_REQUIRED', category: 'input',
        message: '本地确认必须由 Skill 依次调用 rpc open-approval、展示 summary，再调用 confirm-approval；不得伪装成 WebAuthn session',
        retryable: false,
      })
    }
    const approvalType = approvalTypeForWorkflow(initial.workflow.current, arguments_[4]!)
    const grantSubject = await readHumanGrantSubject(arguments_, approvalType, identity)
    const subjectDigest = computeRuntimeApprovalSubjectDigest(initial, approvalType, grantSubject)
    const stable = stableHumanApprovalRequest(initial, approvalType, subjectDigest)
    const reservation = grantSubject === undefined
      ? { kind: 'pending' as const }
      : await store.beginRequest(stable.requestId, stable.requestDigest)
    if (reservation.kind === 'replay') {
      await store.close()
      return {
        url: '', sessionId: stable.finalizationId,
        async wait() { return reservation.response as Awaited<ReturnType<RuntimeAuthoritySession['wait']>> },
      }
    }
    authority = await startAuthority()
    const approvalBinding = grantSubject === undefined ? undefined : {
      runId, approvalType: approvalType as 'discovery' | 'execution', subjectDigest,
      installationDigest: installation.installationDigest,
    }
    const assertCurrentApprovalSubject = async () => {
      const current = await store.getRun(identity.digest, runId)
      if (current === undefined
        || current.runtimeInstallationDigest !== installation.installationDigest
        || approvalTypeForWorkflow(current.workflow.current, approvalType) !== approvalType
        || computeRuntimeApprovalSubjectDigest(current, approvalType, grantSubject) !== subjectDigest
        || stableHumanApprovalRequest(current, approvalType, subjectDigest).requestId !== stable.requestId) {
        throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_CHANGED')
      }
      return current
    }
    let recoveredSessionId: string | undefined
    let recoveredOutcome: Awaited<ReturnType<RuntimeAuthoritySession['wait']>>
    if (grantSubject !== undefined) {
      const currentIdentity = await resolveProjectIdentity(projectRoot)
      assertSameProjectIdentity(identity, currentIdentity)
      const lock = await store.acquireRunLock(identity.digest, runId)
      try {
        assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
        await assertCurrentApprovalSubject()
        const recovered = await authority.recoverApproval({
          finalizationId: stable.finalizationId, requestDigest: stable.requestDigest,
          grantSubject, approvalBinding: approvalBinding!,
        })
        if (recovered !== undefined) {
          assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
          const response = {
            sessionId: recovered.sessionId,
            status: 'verified' as const,
            signedGrant: recovered.grant,
            approvalBinding: recovered.approvalBinding,
          }
          recoveredOutcome = await persistFinalizedApprovalOutcome({
            persist: async () => await store.readRunOutcome(
              identity.digest, runId, stable.requestId, stable.requestDigest, () => response, lock,
            ) as typeof response,
            acknowledge: async () => {
              await authority!.acknowledgeFinalization({
                finalizationId: stable.finalizationId,
                requestDigest: stable.requestDigest,
                grantId: recovered.grant.grantId,
                approvalBinding: recovered.approvalBinding,
              })
            },
            persistencePending: (cause) => new E2EError({
              code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING', category: 'safety',
              message: 'Authority 已恢复 Grant，但 Run Store outcome 尚未持久化；可用相同命令重试',
              retryable: true, cause,
            }),
          })
          recoveredSessionId = recovered.sessionId
        }
      } finally { await lock.close() }
    }
    if (recoveredSessionId !== undefined) {
      await runWithResourceCleanup(async () => undefined, [store, authority])
      return {
        url: '', sessionId: recoveredSessionId,
        async wait() { return recoveredOutcome },
      }
    }
    const session = await authority.requestApproval({
      runId, approvalType, subjectDigest, installationDigest: installation.installationDigest,
      ...(grantSubject === undefined ? {} : {
        finalizationId: stable.finalizationId, requestDigest: stable.requestDigest,
      }),
    })
    return {
      url: session.url,
      sessionId: session.sessionId,
      async wait() {
        let outcome: Awaited<ReturnType<RuntimeAuthoritySession['wait']>> = undefined
        await runWithResourceCleanup(async () => {
          await session.wait()
          const currentIdentity = await resolveProjectIdentity(projectRoot)
          assertSameProjectIdentity(identity, currentIdentity)
          const lock = await store.acquireRunLock(identity.digest, runId)
          try {
            assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
            await assertCurrentApprovalSubject()
            if (grantSubject !== undefined) {
              if (!session.finalize) {
                throw cliAuthorityError('E2E_APPROVAL_FINALIZE_UNAVAILABLE')
              }
              const finalized = await session.finalize(grantSubject)
              assertSameProjectIdentity(identity, await resolveProjectIdentity(projectRoot))
              const response = {
                sessionId: session.sessionId,
                status: 'verified' as const,
                signedGrant: finalized.grant,
                approvalBinding: finalized.approvalBinding,
              }
              outcome = await persistFinalizedApprovalOutcome({
                persist: async () => await store.readRunOutcome(
                  identity.digest, runId, stable.requestId, stable.requestDigest, () => response, lock,
                ) as typeof response,
                acknowledge: async () => {
                  await authority!.acknowledgeFinalization({
                    finalizationId: stable.finalizationId,
                    requestDigest: stable.requestDigest,
                    grantId: finalized.grant.grantId,
                    approvalBinding: finalized.approvalBinding,
                  })
                },
                persistencePending: (cause) => new E2EError({
                  code: 'E2E_RUNTIME_APPROVAL_PERSISTENCE_PENDING', category: 'safety',
                  message: 'Authority 已最终化 Grant，但 Run Store outcome 尚未持久化；可用相同命令恢复',
                  retryable: true, cause,
                }),
              })
            }
          } finally { await lock.close() }
        }, [store, authority!])
        return outcome
      },
    }
  } catch (error) {
    return await closeResourcesAndRethrow(error, [store, ...(authority === undefined ? [] : [authority])])
  }
}

function stableHumanApprovalRequest(
  snapshot: RuntimeRunSnapshot,
  approvalType: 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy',
  subjectDigest: string,
): { requestId: string; requestDigest: string; finalizationId: string } {
  const requestDigest = digestText('e2e-runtime-human-approval/v2', canonicalizeJson({
    runId: snapshot.runId,
    approvalType,
    subjectDigest,
    workflowSequence: snapshot.workflow.sequence,
    workflowEventChainDigest: snapshot.workflow.eventChainDigest,
    recordedRequestIds: Object.keys(snapshot.requestResponses).sort(),
  }))
  const suffix = requestDigest.slice('sha256:'.length)
  return {
    requestId: `HUMAN-APPROVAL-${suffix}`,
    requestDigest,
    finalizationId: `FINALIZE-HUMAN-${suffix}`,
  }
}

async function readHumanGrantSubject(
  arguments_: string[],
  approvalType: 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy',
  identity: Awaited<ReturnType<typeof resolveProjectIdentity>>,
): Promise<ApprovalGrantSubject | undefined> {
  const grantsCapability = approvalType === 'discovery' || approvalType === 'execution'
  if (!grantsCapability) {
    if (arguments_.length !== 5) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_UNEXPECTED')
    return undefined
  }
  if (arguments_.length !== 7 || arguments_[5] !== '--subject-file') {
    throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_REQUIRED')
  }
  const reader = new SecureProjectFileReader()
  const bytes = await reader.readFile({
    realRoot: identity.realRoot, device: identity.device, inode: identity.inode,
  }, arguments_[6]!, 16 * 1024 * 1024)
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    const subject = ApprovalGrantSubjectSchema.parse(parsed)
    const actualType = canonicalGrantApprovalType(subject)
    if (actualType !== approvalType) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_INVALID')
    return subject
  } catch (error) {
    if (error instanceof E2EError) throw error
    throw cliAuthorityError('E2E_RUNTIME_APPROVAL_SUBJECT_INVALID')
  } finally { bytes.fill(0) }
}

function closeAuthorityAfterWait(
  session: RuntimeAuthoritySession,
  authority: { close(): Promise<void> },
): RuntimeAuthoritySession {
  return {
    url: session.url,
    sessionId: session.sessionId,
    async wait() {
      await runWithResourceCleanup(async () => { await session.wait() }, [authority])
    },
  }
}

async function settleResources(resources: Array<{ close(): Promise<void> }>): Promise<unknown[]> {
  const results = await Promise.allSettled(resources.map(async (resource) => await resource.close()))
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
}

async function closeResourcesAndRethrow(
  operationError: unknown,
  resources: Array<{ close(): Promise<void> }>,
): Promise<never> {
  const cleanupErrors = await settleResources(resources)
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      'E2E_RUNTIME_OPERATION_AND_RESOURCE_CLEANUP_FAILED',
    )
  }
  throw operationError
}

async function runWithResourceCleanup(
  operation: () => Promise<void>,
  resources: Array<{ close(): Promise<void> }>,
): Promise<void> {
  let outcome: { status: 'fulfilled' } | { status: 'rejected'; reason: unknown }
  try {
    await operation()
    outcome = { status: 'fulfilled' }
  } catch (reason) {
    outcome = { status: 'rejected', reason }
  }
  const cleanupErrors = await settleResources(resources)
  if (outcome.status === 'rejected') {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [outcome.reason, ...cleanupErrors],
        'E2E_RUNTIME_OPERATION_AND_RESOURCE_CLEANUP_FAILED',
      )
    }
    throw outcome.reason
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'E2E_RUNTIME_RESOURCE_CLEANUP_FAILED')
  }
}

async function readRunWithLease(
  store: RuntimeRunStore,
  projectIdentityDigest: string,
  runId: string,
) {
  const lock = await store.acquireRunLock(projectIdentityDigest, runId)
  try {
    const snapshot = await store.getRun(projectIdentityDigest, runId)
    if (snapshot === undefined) throw cliAuthorityError('E2E_RUNTIME_RUN_NOT_FOUND')
    return snapshot
  } finally { await lock.close() }
}

function executeSnapshotUsesFullPlaywright(snapshot: RuntimeRunSnapshot | undefined): boolean {
  const content = snapshot?.frozenArtifacts['browser-action-map']?.content
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    && (content as Record<string, unknown>).executionProfile === 'full-playwright'
}

function approvalTypeForWorkflow(
  workflow: string,
  requested: string,
): 'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy' {
  if (!isApprovalType(requested)) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_TYPE_MISMATCH')
  const allowed: Record<string, Array<typeof requested>> = {
    'awaiting-scope-approval': ['scope', 'lineage'],
    'coverage-audited': ['discovery'],
    'awaiting-execution-approval': ['execution'],
    diagnosing: ['privacy'],
    finalizing: ['privacy'],
  }
  if (!allowed[workflow]?.includes(requested)) throw cliAuthorityError('E2E_RUNTIME_APPROVAL_TYPE_MISMATCH')
  return requested
}

function isApprovalType(value: string | undefined): value is
  'scope' | 'lineage' | 'discovery' | 'execution' | 'privacy' {
  return value !== undefined && ['scope', 'lineage', 'discovery', 'execution', 'privacy'].includes(value)
}

function localAuthoritySubject(): string {
  if (typeof process.getuid !== 'function') throw cliAuthorityError('E2E_RUNTIME_PLATFORM_UNSUPPORTED')
  return `local:uid:${process.getuid()}`
}

function cliAuthorityError(code: string): E2EError {
  return new E2EError({
    code,
    category: 'safety',
    message: `${code}: 人类审批命令无法建立可信 Run/Authority 绑定`,
    retryable: false,
  })
}

function formatDoctorReport(report: RuntimeDoctorReport): string {
  const statusLabels: Record<RuntimeDoctorReport['probes'][string]['status'], string> = {
    passed: '通过',
    blocked: '阻塞',
    'not-installed': '未安装',
  }
  const lines = [
    'Runtime Doctor',
    `运行时版本：${report.runtimeVersion}`,
    `浏览器来源：${report.browserSource}`,
    `审批模式：${report.approvalMode}`,
    `就绪：${report.ready ? '是' : '否'}`,
    '探针\t状态\t原因代码\t修复建议',
  ]
  for (const [name, probe] of Object.entries(report.probes)) {
    lines.push(`${name}\t${statusLabels[probe.status]}\t${probe.reasonCode}\t${probe.remediation}`)
  }
  return `${lines.join('\n')}\n`
}
