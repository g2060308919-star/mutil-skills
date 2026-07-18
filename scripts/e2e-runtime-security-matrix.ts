export type RuntimeSecurityTerminalState =
  | 'input-blocked'
  | 'environment-blocked'
  | 'safety-blocked'
  | 'artifact-blocked'
  | 'migration-required'

export interface RuntimeSecurityMatrixRow {
  threat: string
  reasonCode: `E2E_${string}`
  errorCategory: 'input' | 'environment' | 'safety' | 'artifact'
  terminalState: RuntimeSecurityTerminalState
  coverage: readonly string[]
}

/**
 * 发行门禁使用的安全威胁索引。这里不替代各模块的行为测试；它把发布规范中的每个
 * 攻击面绑定到稳定 reason code 和至少一个执行真实边界的测试文件，防止重构时遗漏
 * 整类威胁或把 fail-closed 结果悄悄降级成普通失败。
 */
export const E2E_RUNTIME_SECURITY_MATRIX = Object.freeze([
  row('恶意 PRD shell 文本', 'E2E_RUNTIME_CHILD_ENTRYPOINT_OUTSIDE_INSTALLATION', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/process-supervisor.test.ts'),
  row('path traversal / symlink swap / hardlink', 'E2E_RUNTIME_MANIFEST_UNSAFE_NODE', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/runtime-layout.test.ts'),
  row('恶意 project node_modules / NODE_PATH / NODE_OPTIONS', 'E2E_RUNTIME_MANIFEST_MISMATCH', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/runtime-discovery.test.ts'),
  row('SSH key canary / env secret / project .env', 'E2E_RUNTIME_CHILD_ENV_INVALID', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/process-supervisor.test.ts'),
  row('Gateway 直连', 'E2E_GATEWAY_DENIED', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/gateway-proxy-security.test.ts'),
  row('未批准 redirect', 'E2E_GATEWAY_DENIED', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/gateway-proxy-security.test.ts'),
  row('未批准 WebSocket / Beacon / Service Worker', 'E2E_GATEWAY_PROTOCOL_FORBIDDEN', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/gateway-proxy-security.test.ts'),
  row('审批 challenge 错绑 / stale / replay / 无 UV', 'E2E_APPROVAL_SESSION_BINDING_MISMATCH', 'safety', 'safety-blocked',
    'packages/e2e-authority/test/webauthn-user-presence.test.ts'),
  row('Runtime package version skew', 'E2E_RUNTIME_PACKAGE_VERSION_SKEW', 'safety', 'migration-required',
    'packages/e2e-runtime/test/runtime-installer.test.ts'),
  row('Runtime manifest tamper', 'E2E_RUNTIME_MANIFEST_MISMATCH', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/runtime-discovery.test.ts'),
  row('raw evidence canary', 'E2E_GENERATION_SANITIZER_OUTPUT_DIGEST_MISMATCH', 'artifact', 'artifact-blocked',
    'packages/e2e-engine/test/complete-generation-builder.test.ts'),
  row('report absolute path', 'E2E_REPORT_INPUT_INVALID', 'artifact', 'artifact-blocked',
    'packages/e2e-report/test/complete-report.test.ts'),
  row('Host crash / effect unknown', 'E2E_RUNTIME_WRITE_EFFECT_UNCERTAIN', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/effect-unknown-recovery.test.ts'),
  row('publication kill point', 'E2E_ARTIFACT_NO_RELIABLE_GENERATION', 'artifact', 'artifact-blocked',
    'packages/e2e-engine/test/artifact-recovery-matrix.test.ts'),
  row('同版安装内容冲突', 'E2E_RUNTIME_VERSION_CONFLICT', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/runtime-installer.test.ts'),
  row('active version 卸载', 'E2E_RUNTIME_ACTIVE_VERSION_REMOVAL_BLOCKED', 'safety', 'safety-blocked',
    'packages/e2e-runtime/test/runtime-installer.test.ts'),
  row('缺失 state 迁移器', 'E2E_RUNTIME_STATE_MIGRATION_REQUIRED', 'artifact', 'migration-required',
    'packages/e2e-runtime/test/runtime-state-migration.test.ts'),
] satisfies readonly RuntimeSecurityMatrixRow[])

function row(
  threat: string,
  reasonCode: `E2E_${string}`,
  errorCategory: RuntimeSecurityMatrixRow['errorCategory'],
  terminalState: RuntimeSecurityTerminalState,
  ...coverage: string[]
): RuntimeSecurityMatrixRow {
  return Object.freeze({ threat, reasonCode, errorCategory, terminalState, coverage: Object.freeze(coverage) })
}
