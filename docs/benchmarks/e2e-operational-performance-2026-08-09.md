# E2E Runtime 非功能趋势证明（2026-08-09）

本次在未登记开发机上，每个阶段采样 20 次，所有样本零失败：

| 阶段 | p50 | p95 | 最大值 | 预算 |
| --- | ---: | ---: | ---: | ---: |
| Runtime 模块冷启动 | 112.897 ms | 117.479 ms | 127.841 ms | 2000 ms |
| TUF 更新冷缓存 | 7.888 ms | 8.594 ms | 12.037 ms | 2000 ms |
| TUF 更新热缓存 | 1.545 ms | 2.225 ms | 7.299 ms | 2000 ms |
| 32 路真实新 Run Resolver | 394.039 ms | 422.113 ms | 430.031 ms | 2000 ms |
| 失败诊断分类 | 0.004 ms | 0.060 ms | 0.233 ms | 25 ms |
| Artifact 持久引用保留、解除、GC 与回读 | 425.970 ms | 433.501 ms | 438.899 ms | 2000 ms |

- Flaky rate：0%
- 失败可诊断率：100%
- Artifact retention lifecycle：已验证
- Proof digest：`sha256:69635318c344273dc3a94bf1e5af0a1329b848f6ae6044c46bdb490cabdf40e4`
- `passed=true`
- `gateEligible=false`

每阶段均包含原始 samples digest、版本化 baseline digest、CPU/内存指纹和相对预算偏差。开发机 TUF 阶段经过正式 `TufRuntimeUpdateClient` 及受控 updater fixture；稳定 runner 禁止 fixture，必须配置真实 trusted root 与 HTTPS metadata/target origin。Artifact 阶段先证明持久 validation reference 可保留非 active generation，再解除引用并证明 GC 删除，且 active generation 始终可回读。门禁资格为 false 的唯一原因是该机器未登记为稳定 runner。
