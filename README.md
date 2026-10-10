# Eagle 视频分析

一个与 Eagle 素材库关联的 Window 视频分析插件项目，当前处于技术验证阶段。

实验 A 已完成单素材集成与一次授权标注写入/回退；实验 B 已完成单视频缓存性能验证。像素级逐帧准确性、长期内存稳定性及正式产品架构尚未充分验证。当前只整理工程，尚未开始正式播放器开发。

## 从哪里开始

- [Agent 规范](AGENTS.md)：全项目长期流程与权限。
- [项目说明](docs/project-profile.md)：目录职责、运行与检查命令。
- [产品需求与决定](docs/product.md)：要解决的问题及已批准范围。
- [原型架构](docs/architecture.md)：文件职责和数据流。
- [当前进度](docs/progress.md)：当前状态、验收限制及下一步边界。
- 实验 A：[说明](docs/experiments/A/plan.md) / [报告](docs/experiments/A/report.md)。
- 实验 B：[说明](docs/experiments/B/plan.md) / [报告](docs/experiments/B/report.md)。
- [目录迁移与简要复盘](docs/progress/2026-10-10-repository-reorganization.md)：旧位置映射、验证结果、正确流程与修正原因。

## 打开原型

Eagle 本地开发项目入口是 `prototypes/window-player/manifest.json`，不是仓库根目录。移动前已加载的插件仍可能使用旧路径，需要用户在 Eagle 中重新选择新目录；实际重新加载与播放尚待确认。

原始运行证据位于 `prototypes/window-player/evidence/`，仅保存在本机；历史证据中的绝对路径保持测量时原样。项目只有根目录一个 Git 仓库。
