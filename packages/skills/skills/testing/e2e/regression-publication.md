# 声明式 Playwright 回归编译与资产准备

## 适用状态

`execution-approved → compiled`；执行事实完成后冻结最终 regression manifest。

## 必需 Artifact 与摘要

Engine 对真实 `prd-manifest`、`prd-diff`、`acceptance-scope` 及其决定回执完成验证后签发的 generation readiness capability；同代且通过严格 Schema 的 `project-policy`、`requirement-model`、`coverage-universe`、`test-cases`、`browser-action-map`、`execution-contract`、`run-bundle`、`approval-grants`；Host 启动期固定且钉扎摘要的 Artifact/Freshness/Discovery Authority 信任根、Chrome 和 Gateway Proxy；以及固定 Contracts、可信 Compiler、模板和本地 Playwright CLI 版本。

## 允许的语义输出

Projector 只输出不可伪造的 `TrustedCompilerInput` token；其中只有声明式 Case、`assertText`/`reversibleWrite` Action、Oracle、blocked Case/reasonCode 和代际摘要。Compiler 输出密封 Playwright 项目；Discovery 输出 Schema 2.0.0 `regression-manifest` 和 `regression-discovery-attestation/v2` 专用证明。

## 调用的确定性 API

Skill 唯一调用固定 launcher `~/.mutil-skills/bin/repo-e2e rpc`，按 JSON stdin/stdout 发送严格 `RuntimeRequestEnvelope` 并解析严格 `RuntimeResponseEnvelope`。每个业务命令成功后必须立即调用 `get-status`；只有严格拒绝未知字段的 `get-status` `result` 才提供 `state`、`nextEdge`、`verifiedDigests`、`minimumMissingInput`，其他命令结果不得用于猜测状态；编译、隔离 discovery、固定 Playwright 与 Browser launcher 均由 Runtime 内部托管，Skill 不执行 `npx`、低层命令或生成源码。

Runtime 内部必须依次调用 `projectCompilerInputFromArtifacts()`、受信确定性 Compiler、独立 Discovery Authority、真实本地 Playwright CLI 固定的 `test --list --reporter=json` 离线质量门、`prepareTrustedCompilerRun()`、Contracts 校验和 Engine readiness 审计。可恢复写回归还必须由 Runtime 调用 `createTrustedCompilerControlledWriteLauncher()`、loopback Controlled Write Bridge 与 fresh-run launcher。

## 执行步骤

Projector 必须从实际 content 重算每个 Artifact digest，使用启动期 trust token 中的固定 Artifact Authority 公钥重验签名，并重验完整执行投影 Artifact 的严格 Schema、同一 assetId/generationId/prdRevision、readiness 中三份 PRD/scope/lineage Artifact 摘要、已审批 runId、active Case 与 caseQueue 闭包、obligation 自动化处置、Step→Action 唯一映射、effect 一致性、可逆写 Lease/Cleanup/前后置 Oracle 和 freshness 专用签名。输入中的 `playwrightAction` 只能作为设计审计事实，绝不能进入 CompilerInput；未知、不可逆或 unmapped Case 只能投影为 blocked Case。任何源码 bytes、配置、hook、fixture、reporter、import 或 caller 自报 playwrightCaseIds 都必须拒绝。

Compiler 只消费 Projector 签发的 opaque token，并在全新的空目录用 `wx` 一次性写入固定模板。调用方不能直接构造 token，也不能选择模板代码。blocked Case 只进入 Run Bundle 的处置清单，不能进入 spec 源码；自动化代码只能调用受信 `safePage.assertText()` 或 `safePage.reversibleWrite()`，不得生成任意 `page.click()`、`page.evaluate()`、shell、文件读取或原生业务网络访问。手工 Case 是普通人工验收资产，不生成或执行“手工脚本”，也不能计入自动化通过率。

Discovery Authority 必须从真实目录枚举完整 Source Set，拒绝 symlink、hardlink、非普通文件、路径逃逸、额外文件和缺失文件，逐文件绑定 canonical path/digest/byteLength/mediaType。它先执行受控 import、宿主 API、环境读取、动态执行、页面脚本执行和网络入口的静态安全扫描，并拒绝 `test.skip/fixme/fail/only/todo`，再在项目目录之外创建临时 HOME/TMPDIR，由已解析的本地 CLI 直接执行固定 list 命令；禁止下载、install script、业务环境变量和网络。Case ID 只能从 JSON reporter stdout 解析，不能由调用方回填。

V2 证明必须绑定 `testDomain=prd-e2e-trusted-compiler`、`executionProfile`、assetId、generationId、prdRevision、Compiler/模板/Contracts 版本、environmentId、approvalDigest、policyDigest、Compiler Input digest、全部 Source Set、Case 映射、blocked Case、Node/Playwright/CLI 标识、固定命令、exitCode=0、stdout digest 和 exact discovered Case IDs。caseMappings/discoveredCaseIds 与 blockedCases 必须互斥，并对 active Case 精确闭合。

真正启动生成测试前，`prepareTrustedCompilerRun()` 必须只接受 Host 启动期固定的 execution trust token，复验 V2 attestation、Authority 当前 freshness/撤销状态、真实 Source Set 与 `run-bundle.json`，并核对代际、已审批 runId、审批摘要、执行 Profile、Case 和 Action。`executeTrustedCompilerProject()` 必须在调用瞬间从内存中保留的已证明 bytes 创建随机私有只读快照，递归密封并再次逐字节核对、token 级静态扫描、复验 CLI 与 Chrome bytes；它只能以 `process.execPath + 已解析本地 Playwright CLI` 启动，只注入 Host 固定的 Chrome/Gateway、逐 Profile 白名单环境、私有 HOME/TMP/输出目录。Discovery 后任何 byte、文件集合或工具链变化都必须在浏览器动作前终止。返回的 `TrustedCompilerRunSession` 是不可伪造且单次消费的 runtime capability；只读和可逆写 launcher 都必须单次认领同一 session，Bridge 只能用与该 session/launcher 绑定的 opaque handle 进入执行器。只读 `assertText` 由 Controlled Read Bridge 在该次 execution 内驱动真实 Page，Bridge 保存的 Case Result 与 Page Evidence 是 Browser Results 的唯一来源。

可恢复写源码只能向 `127.0.0.1` Controlled Write Bridge 提交声明式 Action。每个独立复跑必须创建新 Run、重新完成 Discovery preflight、Lease 与 v2 Execution Approval，并重新做 Source Set 复验。Bridge 使用 CSPRNG 256-bit 一次性 RunGate，精确核对 actionId、页面语义、leaseId 和 cleanupPlanId；Action 一旦进入 launcher 就永久消费。只有 Runner passed、effect=applied、cleanup=verified-clean、ExecutionOutcomeReceipt 验签成功且 Authority/Lease/Gateway/evidence 闭合时才返回 200；未知副作用禁止自动重试。

Builder 和 staging 发布审计必须从实际 supporting bytes 重算 Source Set、复验专用证明，并要求 Browser Results 与逐 Case `trustedCompilerExecution` 在 runId、approval、Compiler Input、Source Set、Case 集合、passed/failed 状态和 exitCode 上闭合；execution 记录的 Chrome/Proxy digest 必须分别等于执行前 Host opaque measurement capability 投影进签名 browser-preflight 的固定测量 check。只读 Bridge 必须按 session 的 `Case→Action` 精确映射收齐全部结果，Runner 产生的 screenshot/DOM/Gateway evidence digest 必须与送入 sanitizer 的同一批 bytes 对账。最终报告必须投影 Compiler Input、Compiler/模板、Source Set、Discovery、固定 launcher execution、Node/Playwright/CLI 的摘要与版本，供独立审计重算。Discovery 失败自动清理临时目录；固定 launcher 无论成功、失败或环境绑定拒绝都必须撤销 session 并清理私有执行与运行目录。

## 退出条件

每个 ready Case 在 Source Set、caseMappings、reporter discovery 三处 exact 相等且映射唯一；blocked Case 只有明确 reasonCode 而无假测试；执行前 Source Set 复验通过；可恢复写 Golden 由已编译 Playwright 子进程经 trusted session、RunGate/bridge 完成真实写入和清理；全部实际 bytes 和专用签名通过 Builder 与 staging 双重审计。

## 暂停条件

Artifact 非同代、动作映射不全、审批无效、编译/list/secret 质量门失败、Runtime/本地 CLI/verifier/launcher 缺失、Source Set 或工具链摘要不一致、非零 exitCode、V1 discovery 证明或未知 major；旧版一律 `migration-required`，不得猜测升级。

## 禁止行为

不得让模型或调用方提供可执行源码、模板片段、hook、环境读取或 playwrightCaseIds；不得生成 skip/only/todo/空断言；不得为 blocked/manual Case 造假测试；不得绕过 Projector、fresh approval、Source Set 复验或 Gateway；不得用通用 Artifact 签名替代 Discovery 专用密钥；不得使用 `npx` 自动下载；不得复用旧代证明。

## 独立调用

缺少必需 artifact/digest 时，只返回最小缺失项；不得重建上游，不得推进状态。
