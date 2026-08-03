# Changelog

## [Unreleased]

## [0.5.1] - 2026-08-03

### Added

- Target Probe 新增 `resource-closure`、`application-ready`、`dom-identity` 分级策略，以及 URL/title、DOM、可见文本、Console/pageerror、失败请求、未闭合资源和长期连接诊断快照；Run Status 的 JSON/Markdown/HTML 可直接展示阻断原因和恢复动作。
- Runtime 新增 `E2EInputPreparer`、Facade `prepareInput/startFromInput` 与 `repo-e2e prepare-input`：把 Skill 已读取并确认的 PRD、需求契约及必要来源幂等封装成私有不可变快照和严格 `create-run` payload，不再要求调用者手写内部文件或 RPC envelope。

### Changed

- Target Probe 延后到需求理解和 Case lane 编译完成后；全部 `preview-readonly` Case 首次使用 application-ready，页面暂未就绪可维持策略重试，只有资源类阻断升级为 dom-identity。页面身份、pageerror 和含写 lane 均不降级；可信 preflight、Gateway、Authority、Lease 与 Cleanup 门不降低。
- E2E Skill 明确 Runtime 0.5 高层主线，并把项目身份、requirements contract、machine view、Source Bundle 与 project policy 定义为 Skill 自动准备的内部材料，不再要求调用者手写严格 envelope 或中间文件。
- 编译结果分别报告唯一 `mappedAcceptanceCount` 与 `oracleCount`，避免重复 Oracle 放大覆盖数量。

### Fixed

- Target Probe 在资源闭包耗尽前先评估页面身份并保留页面诊断，不再把已渲染的 localhost SPA 简化为无标题的通用资源失败；真正 pending request、未获批的新 URL、WebSocket/SSE 与 pageerror 分别分类。
- 输入封装复用并冻结已有 project policy，拒绝 symlink root、hard link、非当前 UID 和不安全目录；接入 I/O 错误与 JSON 校验错误分开分类。
- Runtime 严格请求错误返回字段路径和约束；同一 Case 的重复 `contractNodeId + acceptanceCriterion` Oracle 由编译器拒绝。

## [0.5.0] - 2026-08-02

> 升级说明：Skill、Runtime 与全部 `@mutil-skills/*` 包必须统一使用 `0.5.0`；`AcceptanceReview` 和 Semantic Case 执行投影新增严格字段，禁止与 0.4.x 闭包混装。

### Added

- 新增 Runtime-owned `TargetContract`、可配置 `PageIdentityPolicy`、非权威 Target Probe、`AcceptanceReview`、`RunHandle`、可恢复 Run Condition 和静态 Run Status Workspace。
- 新增 Semantic Case 的 `ExecutionLane`、`FixtureContract`、locator candidates 与 binding 状态，使预检阻断时仍可审查完整需求覆盖和不可执行原因。
- 新增真实 localhost SPA Golden：系统 Chrome 经正式 Gateway 发现并精确授权同源只读静态资源，证明非标题业务身份；Runtime Host 回归测试独立证明同一 Run 的身份修订、语义资产保留和下游失效。

### Changed

- E2E Skill 在 Discovery 授权和可信浏览器预检前展示并确认一次完整的“PRD 原文/SourceSpan → Clause 处置 → Requirement → Rule → Oracle → Case”验收视图；Execution Approval 只确认执行差异。
- Runtime 状态投影分离阶段、可恢复阻断和业务终态；`status/review/confirm-review/retry/report` 友好命令不再要求调用者手写 RPC envelope。
- Target Probe 的可达性以受控浏览器为准。SPA 资源闭包使用显式来源内 GET/HEAD、精确 URL、有限轮次和有限总量发现，不使用 shell reachability 覆盖浏览器事实。

### Fixed

- Trusted Publishing 在同版本 tgz 封装字节变化时，下载 Registry 包并比较稳定文件内容摘要；内容相同则安全幂等跳过，内容不同仍拒绝覆盖，发布工作流可安全重跑。
- Runtime 重复安装使用稳定内容身份判断幂等；普通封装 metadata 或非执行权限变化不再制造版本冲突，活跃/不明 owner 仍 fail-closed。
- 页面身份不匹配不再销毁 Run。修改 TargetContract 后仅失效 Probe、Discovery、Preflight 与下游执行事实，保留冻结 PRD、Requirement、Rule、Oracle 和 Semantic Case。
- Target Probe 不再把 SPA 脚本/样式资源被旧单文档规则阻断误报为目标不可达；底层 E2E reasonCode 也不再统一吞并为导航失败。
- `report --run` 与 Skill 文档保持一致，并保留 `--run-id` 作为兼容别名；Facade 客户端版本从 Runtime 唯一版本常量读取。

## [0.4.7] - 2026-07-31

### Fixed

- Registry Golden 将 npm Registry 的 `dist.integrity` 与安装 lockfile 对账，并以忽略 gzip metadata 和普通文件权限归一化、但保留可执行语义的文件内容摘要，对账当前 Tag 的 clean pack 与安装目录；不再把两次 `npm pack` 的封装字节误当作稳定内容身份。
- 正式发布门在构建、打包和 Golden 前强制执行 TypeScript clean build，避免被忽略的旧 `dist` 或增量声明产物进入本地发布真相。

## [0.4.6] - 2026-07-31

### Added

- 新增 `PRDRunCompiler`，将冻结的 PRD 契约编译为可持久化的多 Case 执行计划，并建立 Requirement、Rule、Oracle、Obligation、Case 与执行结果之间的可追踪关系。
- 新增可恢复的多 Case 调度器；每个 Case 使用独立 Gateway 会话与隔离尝试，进程中断后从未完成 Case 继续，已完成 Case 不重放。
- 新增生产级原始 PNG 截图和 Playwright Trace 证据发布；JSON、Markdown、HTML 报告可直接定位每个 Case 的浏览器证据。
- 新增 500 Requirement、2000 Rule、5000 Obligation、1000 Case 的 p95 性能证明，以及 loopback、进程、文件系统、Profile、系统浏览器宿主能力矩阵。

### Changed

- Runtime 正式跨仓 Golden 扩展为三个真实浏览器 Case，覆盖表单输入、Popup、多页面、带 JSON Body 的写请求、Cleanup 与 Reload 验证。
- 最终化、审计、隔离区与事实合并改为多 Case 模型，并保证并发证据封存不会破坏隔离区清单。
- E2E 领域模型和关键恢复、证据、脱仓运行决策补入 `CONTEXT.md` 与 ADR。

## [0.4.5] - 2026-07-29

### Fixed

- 只读执行结果复用生成证据时的 Gateway 审计快照，避免浏览器后台请求在审计发布前改变计数，造成证据与最终输出偶发不闭合；完整签名审计仍独立保存在最终化事实中。

## [0.4.4] - 2026-07-29

### Fixed

- npm 发布工作流拆分为 Ubuntu 全量代码验证与固定 `macos-14` 系统 Chrome Golden/发布任务；不再为 GitHub Linux runner 绕过 Chromium sandbox，同时保留 Linux 测试覆盖和 macOS 真实浏览器发布门。

## [0.4.3] - 2026-07-29

### Fixed

- Authority RPC 容量边界测试继续执行 4096 次真实认证 RPC，但为受支持的 Linux 共享 runner 预留 60 秒时限，避免资源竞争造成与功能无关的发布失败。

## [0.4.2] - 2026-07-29

### Fixed

- Vitest 在干净 checkout 中显式、幂等创建仓库级 `.tmp`，消除 GitHub Actions 因被忽略目录不存在导致的全套 `mkdtemp ENOENT`；普通测试与 Golden 配置共享同一初始化契约。
- 发布 Golden 对 npm 明确报告的瞬时网络错误执行一次有界续传，同时让完整性、鉴权及其他确定性错误立即失败，避免把网络抖动误判为 Runtime 缺陷。

## [0.4.1] - 2026-07-29

### Added

- E2E Skill 支持单次消费外部 `$understand-prd`，并在其不可用时使用互斥的内置等价流程生成唯一 requirements contract。
- Runtime 冻结契约原文、严格 machine view、执行来源 origin/relevance 与唯一 prepared projection，建立 Contract → Clause → Requirement/Rule/Flow → Oracle 的可验证追踪链。
- 新增 GitHub Actions OIDC/npm Trusted Publishing 发布链，按内部依赖拓扑发布十四个 workspace，并以 tarball SHA-512 支持安全幂等重跑。

### Changed

- `prd-request` 升级到 `2.0.0`，Runtime 快照升级到 `1.6.0`；旧 Run 不伪造新增契约事实，需要时明确新建 Run。
- Runtime RPC、execution projection、Source Bundle 与 trusted facts 增加分层总量上限；阶段门在 supplemental artifacts 齐备前 fail-closed。

### Fixed

- SourceSpan 统一为 1-based、end-exclusive 列语义；跨仓 Golden 的订单 Clause 现在从共享 PRD 原文生成并由 Runtime 逐字回切验证。

## [0.4.0] - 2026-07-26

### Added

- 新增完整 PRD Clause Inventory 与逐条处置模型，强制每个原文 Clause 恰好一次映射为 modeled、excluded、not-applicable 或 ambiguous。
- 新增 `Clause → Requirement → Rule → Oracle → Obligation → Checkpoint → Evidence → Verdict` 原子追踪链，并在 JSON、Markdown、HTML 报告中持久化。
- full-playwright 新增每个 Oracle 的执行期 checkpoint，逐项保存 expected/actual、状态以及 screenshot、DOM、URL、trace 四类证据。
- TodoMVC 官方 PRD Golden 扩展为 35 个 Clause、25 个功能 Oracle 与 25 个真实浏览器 checkpoint，覆盖全部 PRD 功能语义。

### Fixed

- Engine 完整性审计现在拒绝未处置 Clause、空语义链、未计划或未执行 Oracle、孤立证据及 checkpoint/回执绑定漂移。
- Finalizer 按证据集合校验执行回执，兼容真实 runner 的证据采集顺序，同时继续拒绝缺失、重复或额外证据。
- generation audit 将签名 checkpoint 证据纳入 ExecutionOutcomeReceipt 上下文，避免正式执行结果在发布审计阶段被误判漂移。
- 跨仓 Golden 为全新 HOME 的冷缓存 npm 安装提供独立 13 分钟故障边界；浏览器 child 仍保持原有 10 分钟执行边界。
- 正式 pack/Registry Golden 与“预期发现 TodoMVC 实现偏差”的公共诊断分离，正式门只接受零跳过、业务 accepted。
- 发布门按环境、业务和门禁内部错误分类，Runtime doctor 复验当前 Gateway helper 路径，固定 launcher 在安装时 Node 消失时返回可操作 reasonCode。
- 仓库及十四个发布包补齐 MIT `LICENSE`、`license` 与精确 Node 支持范围；非 E2E 包不再被无依据提高到 Runtime 的 Node 下限。

### Changed

- E2E Skill 的语义确认升级为逐字展示 `PRD → Clause 原文/来源/处置 → Requirement → Rule → Oracle`，缺失任一链路时 fail-closed。
- 根包、十四个 workspace、内部依赖、Skill 安装命令与 Runtime/Engine 常量统一升级到精确 `0.4.0`。

## [0.3.1] - 2026-07-26

### Added

- 新增固定 TodoMVC 官方 PRD 与 TypeScript+React 公网站点的完整 full-playwright Golden，覆盖表单、键盘、checkbox、路由、双击、Escape、blur、hover、持久化、Reload 和 Cleanup。
- 新增浏览器网络请求的“有序阶段、阶段内无序”模型，使并发 CSS/JS 首次请求既可审计又不会被误判越序。

### Fixed

- Discovery preflight 使用签名请求的完整资源闭包，不再只批准主文档。
- full-playwright 在 Gateway 冻结发布前关闭 program/cleanup 浏览器生命周期，避免成功请求残留 HTTPS tunnel 阻塞审计最终化。
- Gateway 子进程只跟踪完整匹配并已授权的真实传输，并将上游完成事件绑定回原始授权 requestId。
- Authority Grant 的有效期不再越过父 approval context；公开页缺少 `data-e2e-role` 时允许执行，但显式冲突仍 fail-closed。
- TodoMVC 生成资产统一绑定 `visitor` actor，确保 PRD、Requirement、Case、审批、执行身份和最终报告闭合。

### Changed

- 根包、十四个 workspace、内部依赖、Skill 安装命令与 Runtime/Engine 常量统一升级到精确 `0.3.1`。

## [0.3.0] - 2026-07-24

### Added

- `full-playwright` 正式执行 Profile：支持表单与键盘、Popup、多页面/多 Context、冻结 JSON Body 写请求、独立 Cleanup 和 Reload 验证。
- 执行批准时展示并绑定完整 `PRD 原文 → Requirement → Rule → Oracle` 语义审查，保存可追踪 `reviewDigest`。
- Authority 在可逆写批准最终化时按批准主题中的真实 resourceKey 原子配置 DataLease，精确绑定 leaseId、target fingerprint 与 fencing token；不同 Run 对同一资源真实争用。
- 跨仓发行 Golden 支持在全新 HOME 中从 workspace tarball 或 npm registry 安装，使用系统 Chrome、正式 `repo-e2e rpc` 与完整报告验证发布闭包。

### Fixed

- 执行批准后将 Authority 实际 capabilityId 绑定到 ActionMap，并冻结同一 RunBundle 供执行和最终报告复用。
- Gateway 读请求审计按 requestId 计数，不再错误退化为 capabilityId。
- Finalizer 使用真实输入 artifactId，并签署批准时冻结的 RunBundle，避免审批、执行和发布三段发生投影漂移。
- JSON Body 只从批准并冻结的 body material 渲染，Cleanup 始终使用独立浏览器上下文与受控 Gateway。
- 过期 active DataLease 的隔离状态在业务拒绝后仍独立持久化；批准恢复会重新验证全部 Lease，不能用 outbox 重放绕过过期或隔离。

### Changed

- 根包与全部十四个 workspace、内部依赖、Skill 安装命令及 Runtime 常量统一升级到精确 `0.3.0`。
- 默认本地批准仍不做身份权限管控，但每次执行必须显式确认完整语义映射和执行影响；WebAuthn 模式同样先完成语义确认，再进行用户在场认证。报告继续如实声明实际身份与职责分离保障。
- 发布前 tarball 检查与发布后 Registry Golden 分离；正式发布门强制安装并核验 npm 上全部十四个精确同版包及内部依赖。

## [0.2.1] - 2026-07-20

### Fixed

- Runtime 闭包安装显式绑定事务 staging prefix，避免与既有 Telemetry Runtime 共用父目录时 npm 向上解析并污染父级依赖。
- CLI 协议测试显式注入未安装环境，不再因开发机真实 HOME 已安装 Runtime 而进入生产执行路径。
- `create-run` 对协议允许但不符合发布 ID 格式的 requestId 使用大写摘要派生 runId，避免浏览器执行完成后才在 finalization 阶段失败。
- 跨仓发行验收不再复制被 Git 忽略的 `.tmp`，避免受信执行生成的只读临时文件阻断源码副本清理。

## [0.2.0] - 2026-07-19

### Added

- 默认使用经过完整性重验的系统 Google Chrome；托管 Chromium 保留为显式兜底。
- 每次 Run 创建、关闭并清理独立的一次性 Profile，且继续强制所有目标流量通过 Gateway。
- 默认本地确认模式与主题绑定的一次性 confirmation challenge；WebAuthn 保留为显式增强模式。
- FinalReport、Markdown 与 HTML 报告展示实际 `approvalMode`、身份验证和职责分离保障。

### Changed

- 七个 E2E package 与内部依赖统一升级为精确 `0.2.0`。
- 首次使用不再要求下载 Chromium 或登记 WebAuthn 身份；默认依次配置系统 Chrome、本地确认并运行 Doctor。

### Migration

- 旧 Run 缺少审批模式时固定迁移为 `webauthn`，避免升级后降低既有审批语义。
- 已安装的旧托管 Chromium 继续识别为 `managed-chromium`；系统 Chrome 不可用时不会静默下载或切换浏览器。
- 本地确认报告固定声明 `identityVerified=false`、`separationOfDutiesVerified=false`。

## [0.1.0] - 2026-07-16

### Added

- 用户级隔离 E2E Runtime Host、固定 `repo-e2e` 协议和空白项目运行能力。
- 独立 WebAuthn Approval Authority、HTTP/HTTPS Safety Gateway 与受控 Chromium；WebSocket/SSE 在安全桥完成前显式阻塞。
- PRD 到同代回归资产和可追踪报告的完整发布闭环。

### Fixed

- Skill 安装后仍依赖源码仓库和项目本地 E2E package 的可移植性缺陷。

### Security

- 权威执行不加载生成源码；测试进程不继承宿主秘密或项目依赖。
- 浏览器目标流量默认拒绝并强制经过 Gateway；原始证据只进入 Git 外加密 Quarantine。

### Changed

- E2E Skill 从七个低层 package capability 切换到单一 `e2e.runtime-host` 能力门。

### Migration

- 旧 E2E Skill 可继续作为文档读取；要执行受信验收，必须显式安装精确 `0.1.0` Runtime、Chromium 并完成本地 identity enrollment。
- 首发不重写既有 active generation；未知 Runtime state schema 会以 `migration-required` 阻塞。
