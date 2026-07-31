# 使用 Host Capability Proof 驱动宿主集成矩阵

## 状态

Accepted

## 日期

2026-07-31

## 背景

Gateway、进程回收、POSIX 权限和一次性 Profile 依赖真实宿主能力。受限 sandbox 可以合理拒绝 loopback，但若所有环境都条件 skip，就只能证明策略代码而不能证明生产 adapter。

## 决策

Runtime 提供 HostCapabilityProof，分别记录 loopback、process、filesystem、browser、profile 和 Gateway canary 的 executed、unsupported、failed 或 not-executed。测试矩阵显式声明 required capability；required 但未执行时失败。受限环境验证稳定的 unsupported reasonCode。

## 备选方案

- 删除条件 skip：拒绝，因为受限 sandbox 会把环境限制误报为产品失败。
- 保留所有 skip 且不设强制环境：拒绝，因为生产 adapter 可能从未执行。
- 只依赖操作系统名称：拒绝，因为同一系统上的 sandbox、权限和工具安装不同。

## 影响

- `verify:e2e-host` 生成机器可读 proof。
- `verify:e2e-host-matrix` 在真实宿主强制 loopback/Gateway/进程/文件系统测试零跳过。
- Doctor 和测试报告可以区分业务失败、Runtime 失败和宿主能力缺失。
