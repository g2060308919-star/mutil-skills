# ADR 0017：签名 Runtime 更新信任链与 LKG

## 状态

Accepted，2026-08-09。规格已获人工批准，客户端实现已落地；生产 `stable` 激活仍受真实离线密钥、metadata origin 与跨平台 Registry Golden 门禁约束。

## 背景

Phase 5 只从本机已安装且完整验真的 Runtime closure 中执行 `offline` 或精确 `pinned` 选择。Phase 6 希望让新 Run 可以选择签名 `stable`，并在安装或健康检查失败时回退 Last Known Good（LKG）。这会把网络仓库、签名密钥、系统时钟、npm registry 和本地更新状态引入执行信任边界；错误设计可能允许任意安装、版本回滚、冻结、混搭元数据或受污染版本成为默认值。

本 ADR 采用 TUF 1.0 客户端工作流而不是自定义“一个签名 JSON”。TUF 明确区分 root、timestamp、snapshot 和 targets，要求客户端随发行物携带初始可信 root，并通过连续 root 版本和新旧阈值双重签名轮换密钥；timestamp/snapshot/targets 的版本、摘要与过期检查用于阻止回滚、混搭和冻结攻击：

- https://theupdateframework.github.io/specification/v1.0.28/#the-root-role
- https://theupdateframework.github.io/specification/v1.0.28/#update-root
- https://theupdateframework.github.io/specification/v1.0.28/#update-timestamp
- https://theupdateframework.github.io/specification/v1.0.28/#update-snapshot
- https://theupdateframework.github.io/specification/v1.0.28/#update-targets

## 决策

### 1. 信任根与角色分离

1. Bootstrap package 内置经发布审核的 TUF `root.json`，而不是从网络首次信任密钥。root schema 固定为 TUF `spec_version=1.0.x`；未知 major、未知算法、重复 key ID、低于阈值或超出大小上限均 fail-closed。
2. 初始 root 使用 3 把离线 Ed25519 root key、阈值 2；targets 使用独立 3 把离线 key、阈值 2；snapshot 和 timestamp 各用独立在线 key、阈值 1。私钥不进入仓库、npm 包、CI artifact、Runtime HOME 或远程 telemetry。
3. Runtime 客户端必须使用 The Update Framework 官方列出的 JavaScript 实现 `tuf-js` 及其 conformance tests，不自行实现签名规范或更新顺序。参考实现目录：https://theupdateframework.io/docs/getting-started/#implementations 。依赖版本必须在实施 PR 中精确锁定并单独审计。
4. 可信 root 逐个获取 `N+1.root.json`；每一步同时满足旧 root 与新 root 的签名阈值，版本必须恰为 `N+1`，并在继续获取 metadata 前持久化。不得跳过中间 root，也不得以 npm provenance 替代 root continuity。

### 2. 签名 targets 与 Runtime 身份

每个 Runtime target 由 TUF targets metadata 绑定文件长度和 SHA-512，并在 `custom` 中严格携带：

- `schemaVersion: "1.0.0"`
- `packageName: "@mutil-skills/e2e-runtime"`
- 精确 `runtimeVersion`
- `protocolMajor`
- `channel: "stable" | "latest"`
- `npmIntegrity` 与 registry tarball URL 的允许 origin
- `contentDigest`、`executableDigest` 和预期 `installationDigest`
- `supportedNode`：只列已验证 Node major 与最小 patch，不接受开放式未来 major
- `supportedPlatforms`：精确 OS/arch 列表
- `minimumBootstrapVersion`
- `revoked: boolean` 与非敏感 `revocationReasonCode`

下载 bytes 必须依次通过 TUF length/hash、与同一 SHA-512 绑定的 npm integrity、实际 target URL 与签名 registry URL 一致性、package identity、closure manifest/content/executable digest、Node/平台/协议兼容与现有 installer 的 staging 验证。下载文件必须转为当前用户独占的 `0600` 普通文件，installer 在同一文件描述符上再次验证精确长度、SHA-512 与读取期间不变性。任一身份不一致都不得安装、激活或写入 LKG。

### 3. npm provenance 的职责边界

npm trusted publishing/OIDC 与 provenance 用于证明“哪个受信 workflow 构建并发布了 tarball”，但它不证明代码无恶意，也不承担客户端 channel、撤销、回滚或 LKG 决策。npm 官方也明确 provenance 只建立源码与构建说明的可验证关联，不保证包没有恶意代码：

- https://docs.npmjs.com/trusted-publishers/#how-trusted-publishing-works
- https://docs.npmjs.com/generating-provenance-statements/#provenance-limitations

发布端必须使用既有 GitHub Actions trusted publisher 和自动 provenance；更新仓库 targets 只能引用已经完成版本真相、Git tag、Registry Golden 和 provenance 检查的精确 tarball。客户端必须验证 TUF target；能在线取得 npm attestation 时再验证仓库、workflow、commit/tag 和 package version，并把失败视为安装阻断。provenance 不可单独放行任何 target。

### 4. 回滚、防冻结、缓存与离线语义

1. 本地私有 update state 原子保存最高可信 root/timestamp/snapshot/targets 版本、metadata digest/expiry、固定 update start time、高水位 wall clock、已验证 target 和审计链。已验签 metadata 高水位必须在 target 业务校验前落盘，避免撤销或坏 target 被拒绝后重新接受更旧 metadata；版本降低、metadata 消失、摘要混搭或本地时钟倒退超过 5 分钟均阻断在线解析。
2. root 计划有效期 365 天、targets 30 天、snapshot 7 天、timestamp 24 小时；具体签发自动化必须在 50% 生命周期前刷新在线 metadata，并在 root/targets 到期前人工轮换。实现测试必须使用可注入时钟覆盖边界值。
3. `stable`/`latest` 没有“过期后继续安装”的宽限：网络不可用时，只能使用尚未过期的完整缓存来选择已经下载并验真的 target；任一 metadata 过期后，新 Run 的在线 channel 解析 fail-closed。
4. `offline` 是明确策略，不是 `stable` 失败后的静默降级。它仍可执行本机 current 的完整已验证 closure；已有 Run 仍按原 installation digest 恢复。因此 metadata 过期不会使已存在的离线闭包凭空失效。
5. `latest` 始终显式 opt-in，使用独立 delegated role/channel；不能成为默认、LKG 或 `stable` 的隐式回退来源。

### 5. 吊销与紧急处置

1. 普通 key 撤销通过下一版 root/targets 删除委托或 key，并遵循 root continuity。已泄露但未达到 root 阈值时由剩余阈值签发轮换；达到 root 阈值时必须发布新的 Bootstrap/package 进行带外 root replacement，客户端不得网络自愈。
2. Runtime target 的紧急撤销由新 targets metadata 标记精确 installation/content digest。它立即排除新 Run、canary、new-run-default 和 LKG 候选。
3. 已有 Run 永不被自动迁移到另一 Runtime；但在下次恢复/执行边界发现其摘要已被可信 metadata 撤销时进入 `safety-blocked`，需要显式运维处置。正常 stable 回滚继续使用原绑定；紧急撤销是“阻断但不换绑”的唯一例外。
4. 若客户端无法取得未过期 metadata，就不能声称知道新的撤销；报告必须区分 `revocation-checked`、`offline-unchecked` 和 `metadata-expired`，不得把后两者显示为安全通过。

### 6. 安装、canary、默认指针与 LKG

签名 `stable` 只作用于新 Run，顺序固定为：

1. 在更新锁中完成 TUF refresh 与 target 选择；
2. 下载到有大小上限的用户私有 staging；
3. 完整验证全部身份后复用现有原子 installer；
4. 用当前 `process.execPath` 运行无业务数据的 `doctor --json` 和协议握手；
5. 创建隔离 canary Run，验证 Host 启动、Artifact transaction、系统 Chrome 受控启动与只读固定 fixture；
6. canary 全绿后原子写 `new-run-default`，并把此前通过 canary 的默认值保留为 `lkg`；
7. 真实新 Run 创建仍用 Phase 5 的安装锁原子固化 installation digest。

health/canary 失败时 target 保留在 quarantine 供本地诊断，但不得成为 current/default/LKG；默认指针原子回到 LKG。已有活跃 Run 继续按摘要执行且阻止其 closure 被 GC。连续两次失败不会自动重试下载之外的业务动作。

### 7. Node 兼容

Runtime package 仍声明最低 Node 版本，但在线 Resolver 只接受 targets 中明确列出的已验证 LTS major/minimum patch。当前准入为 Node 22（`>=22.13.0`）和 Node 24；Node 26 在完成全量与 Golden 矩阵前不得由 stable 自动选择。Node 官方建议生产只使用 Active/Maintenance LTS：https://nodejs.org/en/about/previous-releases 。Resolver 不下载或替换 Node；宿主不兼容时返回独立环境阻断和建议版本。

### 8. 审计与数据最小化

更新审计默认只在本地保存：metadata role/version/digest/expiry、channel、Runtime version/digest、Node major、平台、阶段、结果码、LKG/default 指针摘要和时间。严禁记录 PRD、目标 URL、项目路径、用户名、HOME、设备 ID、请求/响应 body、浏览器证据或签名私钥。

远程 telemetry 默认关闭；若未来单独 opt-in，只能发送按版本/平台聚合的阶段与结果码，不得发送稳定客户端标识。所有日志使用大小与保留期上限，错误对象不得夹带网络响应正文或认证 header。

## 不变量与验收门禁

- 已有 Run 的 installation digest 优先级高于用户 channel 和默认指针。
- 网络、registry、缓存、provenance 或 TUF 任一失败都不能修改 current/default/LKG。
- metadata 与 target 下载必须有限长、有限重定向、HTTPS origin allowlist，并通过独立更新网络客户端；浏览器 Gateway 不承担 Runtime 自更新。
- 至少覆盖 TUF conformance、root 轮换、阈值不足、快进/回滚/冻结/混搭、时钟倒退、缓存过期、吊销、下载中断、安装 kill-point、canary 失败、LKG 回退、活跃 Run 保留和 telemetry 泄漏测试。
- stable 默认启用前，必须通过 Linux/macOS、Node 22/24 的 clean-HOME Registry Golden；`latest` 需要独立后续批准。

## 备选方案

### 仅依赖 npm dist-tag、integrity 和 provenance

拒绝。它能证明 registry 发布与构建来源，但不能提供客户端 root continuity、metadata 过期、channel 快照、紧急撤销和本地最高版本状态。

### 自定义单文件签名 manifest

拒绝。它会重新实现 root 轮换、角色分离、回滚、冻结和混搭防护，测试成本与误差风险均高于采用 TUF 客户端工作流。

### stable 失败时自动退化为 offline

拒绝。它会把“没有取得最新 metadata”伪装成“已确认安全”，并隐藏撤销检查状态。用户可显式选择 offline，但报告必须如实标注未在线检查撤销。

### 自动迁移或终止所有旧 Run

拒绝。迁移会破坏 Run 的执行身份和可复现性；Runtime 只能在紧急撤销时阻断后续恢复，不能静默换绑或声称已回滚业务副作用。

## 后果

- 在线 stable 的供应链边界可审计，并能检测仓库/缓存攻击与坏版本；代价是四类 metadata、离线签名运维、时钟/缓存状态和更大的测试矩阵。
- 网络不可用或 metadata 过期时 stable 会明确阻断；用户仍可显式 offline，但不能得到“已检查最新撤销”的声明。
- 2-of-3 root/targets 阈值要求真实的离线密钥保管与轮换流程；客户端可以先发布但必须 fail-closed，在该组织能力确认前不能启用生产 `stable`。
- npm provenance 与 TUF 形成两条互补证明链，发布流程和客户端安装会更慢，但不改变业务 E2E 执行语义。

## 回滚

关闭 `stable`/`latest` feature flag，停止更新 metadata refresh，原子恢复现有 LKG 为 new-run-default。保留所有已固化 Run 绑定、本地可信 metadata 高水位和审计记录，禁止通过删除状态来“回滚”防降级记忆。若 root 信任本身失效，只能发布带新内置 root 的 Bootstrap/package 并由人工完成带外恢复。

## 生产激活前置（不由代码仓库伪造）

已批准客户端安全语义：365/30/7/1 天计划有效期、5 分钟时钟回退阈值、已有 Run 紧急撤销后 `safety-blocked`、Node 22/24 准入、Node 26 延后，以及 `latest` 独立审批。

仍需由发布组织提供且不能提交到 Git/npm/CI artifact 的运营材料：

1. 3 把 root 与 3 把 targets 离线私钥的真实保管、2-of-3 签名与轮换演练；
2. 经审核的 bootstrap `root.json` 公钥材料；
3. metadata HTTPS origin、维护者、签发自动化与紧急响应责任人；
4. Linux/macOS、Node 22/24 的 clean-HOME Registry Golden 与撤销演练。

缺少任一项时，0.6.0 客户端保留 `offline`/`pinned` 能力并对 `stable` fail-closed；不得内置测试私钥、临时 origin 或把 npm provenance 当作信任根。
