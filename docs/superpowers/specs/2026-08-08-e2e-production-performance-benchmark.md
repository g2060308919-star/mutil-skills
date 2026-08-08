# E2E 生产模块大规模性能 Benchmark Spec

## 1. 目的与结论边界

本 Benchmark 证明 E2E 在固定大规模输入下调用真实生产模块的延迟、进程峰值 RSS、输出大小与失败率。它替代不了浏览器目标站点的端到端耗时，也不能用普通共享 CI runner 的偶然结果作为硬 SLA。

旧 `verify:e2e-scale` 保留为轻量合成回归；它的数组/filter/string 操作不能作为生产链路 p95 证据。正式证明由 `verify:e2e-production-benchmark` 生成，schema 为 `2.0.0`。

## 2. 固定 Fixture

- 500 Requirement；
- 每个 Requirement 4 个 Rule，共 2000 Rule；
- 1000 business Rule × 2 scenario + 1000 validation Rule × 3 scenario，共 5000 Coverage obligation；
- 每个 Requirement 10 个 acceptance criterion，由 2 个 Case、每 Case 5 个 Oracle 完整覆盖，共 1000 Case 与 5000 Oracle mapping；
- 全部 ID、SourceSpan、Rule/Oracle 双向引用、Case/obligation 引用和摘要确定性生成；
- 完整 fixture 以 `e2e-production-benchmark-fixture/v1` 域分离 SHA-256 绑定。

任一阶段返回的 fixture digest 或数量不一致，主进程以 `E2E_PRODUCTION_BENCHMARK_FIXTURE_DRIFT` 阻断证明。

## 3. 被测生产模块

| 阶段 | 生产入口 | 固定输出 |
| --- | --- | --- |
| `compiler` | `compilePrdRun`（PRDRunCompiler） | 1000 Case、5000 Oracle mapping 的 `CompiledPrdRunPlan` |
| `requirement-graph` | `RequirementModelSchema.parse` | 500 Requirement / 2000 Rule / 2000 Oracle 的闭合双向图 |
| `coverage-audit` | `buildCoverageUniverse` | 5000 required automated obligation |
| `case-schedule` | `createCaseSchedule` | 1000 个持久调度记录 |
| `checkpoint-finalization` | `projectAssertionResultV1` + `createPersistedRuntimeFinalizationMaterial` | 5000 个 Assertion 与 5000 条 Evidence 引用的 schema/digest 绑定 material |
| `engine-verdict` | `computeVerdict` | 5000 obligation + 1000 real result 的 accepted Verdict 与 metrics |
| `report-render` | `renderCompleteReport` | 5000 obligation、5000 trace row、1000 Case 的 JSON/Markdown/HTML |
| `artifact-publication` | `LocalArtifactStore.publish` | requirement、compile、coverage、verdict、JSON/HTML 的原子 generation |

fixture 构造和上游输入准备在计时前完成。Checkpoint 阶段测量 Assertion 投影及生产 finalization material 的 5000 条 Evidence 引用校验、JSON 规范化与摘要绑定，不把 Quarantine I/O 或最终 Artifact publication 重复计入；后者由 `artifact-publication` 阶段独立测量。报告阶段只测 Renderer；Verdict 的真实性和规模由独立 `engine-verdict` 阶段证明，报告不重新计算 Verdict。Artifact 阶段真实执行 helper、签名、fsync、generation 选择和 publication integrity。

## 4. 测量方法

1. 每个阶段在独立 Node 进程运行，防止前一阶段 GC、JIT 或 RSS 高水位污染下一阶段；
2. 每个进程先构造同一 fixture，再执行 3 次不计入结果的 warmup；
3. 正式执行 20 个样本，使用 `performance.now()` 测量生产入口；
4. 使用 nearest-rank 计算 p50/p95/p99；20 样本下 p99 等于观测最大值，报告同时保留 `maxMs`；
5. `process.resourceUsage().maxRSS × 1024` 记录该独立进程的绝对峰值 RSS，包含固定 fixture 常驻内存，不伪称为纯增量；
6. 每个样本记录生产输出 byte length；Artifact 阶段记录实际发布文件总字节；
7. 异常样本不丢弃，记录 reason code、失败数和失败率；任一失败或 p95 超预算使总体 `passed=false`；
8. proof 绑定 runner ID、稳定资源标志、平台、架构、Node、CPU 型号/核数、总内存、fixture、样本和 proof digest。

## 5. 初始预算

| 阶段 | p95 预算 |
| --- | ---: |
| compiler | 500 ms |
| requirement-graph | 300 ms |
| coverage-audit | 500 ms |
| case-schedule | 200 ms |
| checkpoint-finalization | 500 ms |
| engine-verdict | 500 ms |
| report-render | 2000 ms |
| artifact-publication | 3000 ms |

预算是首版回归上限，不是对任意宿主的产品 SLA。预算只能通过新证据收紧；放宽需要独立架构审查，不能为让 CI 变绿而修改。

## 6. Runner 与 CI 门禁

- 普通 PR runner 资源会漂移，只能产生趋势告警，不作为硬 gate；
- `.github/workflows/e2e-production-benchmark.yml` 只允许人工触发，并固定到带 `self-hosted/e2e-benchmark/macos/arm64` 标签的专用 runner；
- 稳定 runner 必须设置固定 `runnerId` 与 `stableResources=true`，否则 proof 的 `gateEligible=false`；
- runner 需要固定 Node 24、关闭并发任务、记录硬件变更；硬件或 Node 变化必须建立新基线，不能与旧分布直接比较；
- 稳定 runner 尚未注册时，workflow 不应加入普通 PR required checks，避免永远排队或把共享硬件伪装成稳定证明。

## 7. 本机趋势证明（2026-08-08）

证据文件：`docs/benchmarks/e2e-production-performance-2026-08-08.json`。

环境：Apple M1 Pro / 10 CPU / 16 GiB / macOS arm64 / Node v24.18.0。20 个正式样本均为零失败，总体 `passed=true`；因为这是开发机而非登记的专用 runner，`gateEligible=false`。

| 阶段 | p50 | p95 | p99 | 峰值 RSS | p95 输出 | 失败率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| compiler | 58.820 ms | 61.259 ms | 61.399 ms | 586 MiB | 1.11 MiB | 0% |
| requirement-graph | 14.008 ms | 14.815 ms | 14.959 ms | 460 MiB | 0.64 MiB | 0% |
| coverage-audit | 80.797 ms | 83.699 ms | 90.736 ms | 563 MiB | 1.73 MiB | 0% |
| case-schedule | 24.361 ms | 27.241 ms | 33.768 ms | 593 MiB | 0.11 MiB | 0% |
| checkpoint-finalization | 98.724 ms | 109.542 ms | 112.872 ms | 762 MiB | 3.20 MiB | 0% |
| engine-verdict | 15.789 ms | 17.076 ms | 27.673 ms | 529 MiB | <0.01 MiB | 0% |
| report-render | 168.844 ms | 181.323 ms | 185.552 ms | 785 MiB | 7.39 MiB | 0% |
| artifact-publication | 821.027 ms | 827.550 ms | 830.021 ms | 661 MiB | 9.06 MiB | 0% |

这份结果证明生产模块在该机器上的大规模趋势全绿；只有在专用稳定 runner 上复跑得到 `gateEligible=true` 后，才能宣称完成稳定 CI p95 硬门禁。

## 8. 验收与回滚

验收要求：固定数量、八阶段齐全、3 warmup、≥20 样本、fixture digest 一致、p50/p95/p99/最大值、峰值 RSS、输出分布、失败率、runner 描述和 proof digest 全部存在；production workload 表征测试必须证明每阶段真实输出固定规模事实。

回滚时可移除 v2 命令和手动 workflow，旧 `verify:e2e-scale` 不受影响。不得把旧合成证明改名后冒充 v2 生产证明。
