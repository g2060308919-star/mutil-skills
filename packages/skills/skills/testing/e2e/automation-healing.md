# 自动化诊断与自愈

## 目的

区分业务、输入、环境、未决需求和自动化问题，并只修复自动化层中允许变化的部分。

## 触发条件

当浏览器 Case 失败或阻塞，且需要诊断自动化问题并决定是否可安全重试时使用。

## 必需输入

browser-results.json、browser-evidence.json、browser-action-map.json、execution-contract.json 和 test-cases.json。

## 可选输入

Console、Network、Trace、视频和 DOM 证据引用。

## 工作流

依序诊断页面身份、账号角色、数据、环境请求、定位器等待、PRD 歧义和业务行为；仅自动化问题进入有界自愈。

## 详细算法

允许修改 locator、wait、action、pageIdentity、evidence、routePattern。无副作用失败最多两次自愈并重跑；写操作生效状态未知时绝不自动重试。将每次尝试记录为 observation、change、sideEffectState、rerunAllowed 和证据；保持 assertionChanged 为 false。

## 输出

diagnosis.json、修订 browser-action-map.json，以及可选重跑结果。

## 完成条件

每个失败 Case 已分类为 business-failure、missing-input、environment、automation 或 pending-requirement，并有最终状态。

## 阻塞条件

证据不足以分类、需要用户补输入或确认预期、写操作结果未知，或两次允许自愈后仍无法可靠执行。

## 禁止行为

不得修改产品代码、PRD、断言强度、Case 范围或结果分类以让 Case 通过；不得重试可能已生效的写操作。

## 独立使用示例

找不到按钮时先用 Trace 确认页面身份，再替换 role locator；审核提交后未知是否生效时标记 automation-blocked 而非重试。
