# 2026-10-10：仓库整理与简要复盘

## 范围与依据

用户批准整理现有仓库，保留单一 Git 历史，明确项目/实验/原型职责。没有新增播放器功能，也没有自动进入正式开发。

参考 ftop 提交 `801a6066dfa9a83350c41f68f8a71ec6bce33fb2` 的 [根规范](https://github.com/Nongfsq/ftop/blob/801a6066dfa9a83350c41f68f8a71ec6bce33fb2/AGENTS.md)、[项目说明](https://github.com/Nongfsq/ftop/blob/801a6066dfa9a83350c41f68f8a71ec6bce33fb2/docs/agents/project-profile.md) 与 [进度记录](https://github.com/Nongfsq/ftop/blob/801a6066dfa9a83350c41f68f8a71ec6bce33fb2/docs/progress/2026-10-09.md)：借鉴长期规则、资料位置、阶段状态及证据分工。该仓库没有证明“每个实验必须复制独立实现”，本次原型布局是针对当前项目的选择。

## 迁移映射

原根：`outputs/eagle-window-poc-a/`。新根：`outputs/eagle-video-analysis/`。

| 原位置 | 新位置 |
| --- | --- |
| .git | 新根 .git，整仓保留 |
| AGENTS.md | 根规范重写；原型另建局部约束 |
| README.md 的 A 实验说明 | docs/experiments/A/plan.md；新根 README 为项目入口 |
| REPORT-A.md / REPORT-B.md | docs/experiments/A/report.md、B/report.md |
| EXPERIMENT-B.md | docs/experiments/B/plan.md |
| RECORD.md | docs/progress/legacy-experiments.md，保留历史上下文 |
| 播放器、检查及复算代码、清单、图标 | prototypes/window-player/ |
| evidence、工具配置、关闭的授权、合成输入 | 原样移到原型内相同子位置，继续 Git 忽略 |

原始 JSON 绝对路径和历史 SHA256 不改写。代码仅更新批准目录、插件显示名称/补丁版本；检查和复算改成不覆盖原始证据。插件 ID 保持原身份，避免仅为改名造成新的身份。

本地标签 `poc-a-verified` 指向 2a4000e，`poc-b-performance-verified` 指向 becf389；后者仍带有像素准确性、长期内存限制。未初始化新仓库或重写历史。

## 简要复盘：可复用做法与弯路

| 曾经的问题 | 采用的修正 | 后续可复用做法 |
| --- | --- | --- |
| 阶段 A 名称被延用为整个项目，根文档继续混入 B 状态 | 中性项目根；根 README/规则负责项目，A/B 文档各自负责实验 | 多阶段开始前明确项目层与阶段层，复用实现仍保留分阶段验收 |
| 规则文件混入状态及具体过期授权 | 长期规则与当前进度、报告分开 | 读规则后再读进度，不把旧许可视为新许可 |
| 曾只建议改目录名，未处理文档职责和路径依赖 | 成套迁移入口、固定路径、ignored 证据、文档导航和检查 | 整理必须有迁移清单与适当验证，不能把“重命名”当作完成 |
| A 初版假设页面一定是 file URL，模拟未覆盖实际协议 | 已在 A 改用 plugin.path，并取得真实运行证据 | 区分页面地址与磁盘路径；模拟条件写清，随后核对真实宿主 |

复用 A 的集成代码开展 B 并不是已证实的错误；错误是未及时建立清晰的项目职责和阶段记录。当前结构只是经过本次检查的项目选择，不宣称通用最优流程，不在此任务创建 skill。

## 迁移验证

迁移前文件清单、长度、SHA256 和提交历史保存在原型 evidence/migration-before.json。迁移后核对结果保存为 evidence/migration-verification.json；本地检查输出另存 migration-*.log。

- 原仓库 19 个提交完整保留，项目内只有一个 .git；A/B 标签正确指向原验收提交。
- 迁移前 34 个文件全部找到对应位置；18 个受保护文件（15 份原始证据、工具配置、关闭授权、合成输入）逐个 SHA256 一致。B 验收记录里的原实现哈希也与迁移前清单一致。
- A 的 19 项本地/VM 检查通过；B 的合成 VFR、请求队列、容量与清理检查通过；已有 B 会话只读复算通过。没有重新测量真实视频性能。
- 检查记录生成新日期文件，原 b-local-checks.json 和 b-final-assessment.json 均未覆写。24 个本地 Markdown 链接有效，git diff --check、git fsck --full 通过；缓存测试目录已清理。
- 初次迁移核对脚本把证据中的 Windows 反斜线路径与清单的正斜线路径直接匹配，报键不存在。统一比较用的路径分隔符后通过；没有修改原始 JSON 或待核对文件。

待真实确认：用户在 Eagle 重新选择 `prototypes/window-player` 开发目录并检查启动、播放。当前会话没有操作 Eagle 加载界面，不能把本地检查作为该项通过。
