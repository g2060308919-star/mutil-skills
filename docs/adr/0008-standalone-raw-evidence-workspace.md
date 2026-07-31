# 独立 Run Workspace 保存原始截图和 Trace

## 状态

Accepted

## 日期

2026-07-31

## 背景

E2E 可能只面对一份 PRD 和远程网站，不存在业务源码仓库。把报告强制发布到 `.biztest` 或 Git 会错误限制使用场景。调用者同时要求在报告中直接查看未经内容脱敏的真实截图。

## 决策

每个 Run 发布到独立 Standalone Run Workspace。未指定位置时使用 `~/.mutil-skills/e2e/reports/<asset-id>/<run-id>/`。原始 PNG bytes 不做 OCR、遮罩或像素修改；Trace 保存在本地目录。Runtime 仍校验来源、媒体格式、大小、相对路径、权限、摘要、Case/Checkpoint 绑定，并原子发布 manifest 和报告。

## 备选方案

- 强制发布到 Git：拒绝，因为 E2E 不一定有仓库。
- 只保存摘要：拒绝，因为用户无法直观看到验收证据。
- 对截图强制脱敏：按产品决定拒绝；原图可见性优先，但这一决定不放宽 Secret、DOM、日志和宿主文件边界。

## 影响

- Git、CI Artifact、对象存储和 `.biztest` 都是可选 publisher adapter。
- HTML 报告直接显示本地截图并提供 Trace 下载。
- outputRoot 必须拒绝 traversal、symlink、hardlink 替换和并发内容冲突。
