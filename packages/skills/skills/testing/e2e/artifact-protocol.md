# 产物协议与安全发布

## 目的

为所有 PRD、设计、浏览器、回归和报告产物提供 Schema、路径、脱敏和原子发布纪律。

## 触发条件

当需要读取、校验、写入或发布任意 .biztest 产物时使用。

## 必需输入

testWorkspace、artifact 名称、待读写 JSON 或目录，以及对应 Schema。

## 可选输入

现有 requirements、current、latest 目录和 rollback 目录。

## 工作流

解析并校验 Schema，解析安全路径，写入临时文件或 staging，校验完整性，切换目标，失败时恢复 rollback。

## 详细算法

所有输出必须 realpath 到 testWorkspace/.biztest 内，拒绝绝对路径逃逸、../、符号链接逃逸和未知 artifact。单文件执行 Schema parse → 同目录临时文件 → fsync/close → rename。requirements、current、latest 执行 next 或 staging → 校验目录 → 原目录改名 rollback → 新目录切换 → 复验 → 删除 rollback。只保留当前 requirements、current 与一份 latest。

## 输出

路径和 Schema 校验结果，以及原子发布或回滚后的安全生命周期状态。

## 完成条件

所有引用均为任务目录相对路径，JSON 已验证，目录完整，目标切换成功或旧版本已恢复。

## 阻塞条件

路径逃逸、Schema 失败、未知 artifact、目录不完整、rename 失败或无法安全恢复。

## 禁止行为

不得直接覆盖半成品、写出 .biztest、保留秘密、手工维护与 Schema 冲突的字段，或保留多份 latest。

## 独立使用示例

渲染报告前把 tasks/<prd-id>/.staging 校验通过后替换 latest；切换失败时恢复上一份 latest。
