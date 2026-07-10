# 回归资产

## 目的

把已绑定的可执行 Case 编译为可独立运行的标准 Playwright current 资产，并安全更新 manifest。

## 触发条件

当已有 Case、动作映射和执行结果，且需要生成或更新可重复执行的 Playwright 回归资产时使用。

## 必需输入

test-cases.json、browser-action-map.json、browser-results.json、prd-manifest.json 和 testWorkspace。

## 可选输入

现有 regression manifest、支持文件与网络 mock 模板。

## 工作流

在 staging 编译 ready Case，校验 TypeScript 和 playwright test --list，执行 secret scan，再原子发布 current 与 manifest。

## 详细算法

同一 CASE-ID 更新同一测试块，新 Case 新增，PRD 删除的 Case 标为 deprecated-by-prd-revision。每条测试带 prdId、reqId、caseId、executionMode 注解。passed 和 failed 的可执行 Case 保留；blocked、declined、pending Case 只进入 manifest。拒绝 only、skip、todo、空断言、未知 Case、敏感信息和直接覆盖 current。

## 输出

regression/<prd-id>/current 目录与 regression-manifest.json。

## 完成条件

每条 ready Case 都有标准测试，playwright test --list 成功，manifest 与 current 一致且发布可回滚。

## 阻塞条件

动作映射不完整、编译质量门失败、秘密扫描命中、路径不安全或 Playwright 运行时不可用。

## 禁止行为

不得让 current import Agent Skill、为 blocked Case 生成假测试、删除稳定 CASE-ID、用 skip 逃避失败或直接覆盖 current。

## 独立使用示例

更新 CASE-SEARCH-001 对应 spec 块并保留标题；缺登录态的 CASE-ADMIN-001 只在 manifest 标为 blocked。
