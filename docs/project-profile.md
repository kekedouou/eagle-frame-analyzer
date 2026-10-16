# 项目说明

## 身份与入口

- 正式主线是Eagle Window视频分析插件，正式实现只在plugin/；MVP固定720p、短MP4，默认RAM1GiB、512MiB及1～10GiB档位，JPEG池≤总额度1/8，额度不是整个程序内存硬上限。
- 阶段3A/3B/3C已批准，阶段4主要实现已收尾。R1已接受Beta限定范围，R2独立安装用户人工验收通过；当前先做文档/清理/本地提交，待用户再次确认才执行R3推送/标签/Release。历史路径公开已明确接受；当前尚未发布Beta2，许可证未指定。
- Git根为eagle-video-analysis/，只有一个.git。正式开发入口为plugin/manifest.json；发行入口名为“视频分析 · MVP Beta”，独立ID，不与日常开发入口混为一谈。
- 原型A/B和S1分别在prototypes/window-player/及playback-clock/，受局部AGENTS约束、默认封存。tests/host为历史专用验证入口，旧T2/T4自动测量入口已停用，不要求用户重新导入或恢复长测。
- 栈为HTML/CSS/JavaScript、Eagle API、Node内置模块、Eagle现有FFmpeg/ffprobe；小型Windows C#守护使用系统已有.NET Framework编译器，不安装依赖。
- 实际已测Eagle为Node16.17.1/Chrome108，开发检查Node24；不能用新Node通过代替Eagle兼容。各能力的限定证据及长期内存/全矩阵缺口见[Beta2记录](releases/v0.1.0-beta.2.md)。

## 资料位置

| 内容 | 位置与职责 |
| --- | --- |
| 长期权限和工程规则 | 根AGENTS.md；不堆进度 |
| 产品、架构 | docs/product.md的R/P及批准补充；docs/architecture.md的C/A-01～A-08 |
| 任务、清理规则 | docs/development-plan.md的T0～T4及F-01～F-07 |
| 验证协议 | docs/verification.md；协议、真实运行和人工反馈分开 |
| 当前状态 | docs/progress.md；先读当前段，日期部分为历史 |
| 专项结果 | docs/experiments/A、B、S1、T0～T4；保留原数据/失败/测量局限 |
| 发布交接 | docs/releases/v0.1.0-beta.2.md；唯一当前版本清单/风险/授权入口 |
| 旧发行与过程 | docs/releases/旧版本、docs/progress/、demos/standalone-preview/；历史说明不冒充下载或新授权 |
| 私人原始证据/配置 | verification-runs/和原型evidence/等Git忽略路径；不公开、不覆盖 |

## 运行与检查

- 当前本地入口：node scripts/check.cjs --without-prepared-host。检查语法、边界、纯/模拟测试、manifest和文档；不处理真实媒体、清共享缓存或写素材库。参数只排除已停用旧T2准备入口，不豁免正式代码检查。
- Windows守护源码变更或新检出时，由Codex用node scripts/build-task-host.cjs构建并核对本机指纹，再提供可运行包；用户不需安装Node或输入命令。
- Beta2打包器：node scripts/package-release.cjs build、verify、extract、verify-install分别显式执行。build要求干净来源、不覆盖旧输出；21运行文件＋README/CHANGELOG/BUILD-INFO，目录和ZIP各≤2MiB。verify/verify-install依赖尚存在的构建/独立目录；清理后只可按保全回执核对ZIP，复跑需明确重建来源，不能假设旧目录仍存在。
- 已人工验证包来源9e2fd0d，ZIP SHA256及验收见发布记录；不因文档更新覆盖此包。BUILD-INFO内布尔值是构建时状态，后续用户人工结果记录在报告，不改冻结包冒充构建时已验收。
- scripts/audit-publication.cjs只读扫描当前内容和待推历史，报警不代表删除许可；旧提交路径与当前包隐私分开。历史路径公开已由用户接受，实际推送仍待最新确认。
- 技术计量/命令由Codex执行。正常产品页面无测试按钮；不重跑认可拖动体验或专门一小时测量，不以后台/模型通过冒充Eagle窗口操作。
- 具体历史媒体/关窗/计量工具及副作用见各实验计划/报告，须按具体范围显式调用，不从旧命令中自动恢复已消费授权。

### 历史原型命令及副作用

A/B的check.cjs、check-b.cjs、assess-b.cjs --verify-only及S1的check-local/check-prepare/check-selected仅用于对应封存范围；带reset、媒体生成或删除的命令先读局部AGENTS和原计划，不为文档同步重跑实验。旧测量配置和原始证据保留，不能借Git回退恢复已消费的标注写入授权。

## 版本与证据

- 既有poc-a-verified、poc-b-performance-verified、phase3c-approved、T1体验/早期技术、T3及生命周期体验标签保留，各自只是限定节点，不是所有R/P通过。
- 标签固定源码；原始证据另存有界本机记录，用户反馈明确标注来源，不假称Codex亲测。
- 当前0.1.0-beta.2标签/新Release均尚未创建；预定标签指向包来源9e2fd0d，之后的文档提交记录验收/整理，不改包。
- 正式磁盘缓存5GiB，实际插件根下cache，与安装同盘且非C盘。运行缓存1天未用及容量淘汰，与开发生成物清理分开；不能以文件年龄删除写锁。
- 发行本地清理记录固定verification-runs/release-0.1.0-beta.2，总1MiB/单份128KiB/最多16文件；不挤占或扩大原T4等配额，不进包、不入Git。

## 当前工作区与正式文件边界

正式开发只维护plugin/这一套播放器，使用HTML/CSS/JavaScript、Node内置模块和现有工具链。下列正式模块已经存在，模块存在不代表T2/T4全部验收完成；原型和发行副本不作为第二套开发主线。

| 主要目录/文件 | 通俗说明 |
| --- | --- |
| plugin/ | 真正继续开发的插件；改播放器功能从这里开始。cache/是自动生成的视频预览，memory-settings.json是本机记住的内存选择，不是源码 |
| tests/ | 检查功能与安全边界的测试。host/window/和host/t4/是停用的历史Eagle测试入口，不重新导入。host/t0/保留早期测试，host/t2/cache-scratch/只放可清理的小测试现场 |
| scripts/ | 开发者使用的检查、准备测试入口、核对记录和打包命令；用户日常播放不需要手工运行 |
| docs/ | 产品要求、架构、开发任务、进度及验收报告；product说“需要什么”，architecture说“怎样分工”，development-plan说“按什么顺序做”，progress说“做到哪一步” |
| verification-runs/ | 测试产生的原始记录及核对回执，相当于验收凭据；被Git忽略仍需有界保留，不能当普通垃圾清空 |
| prototypes/ | A/B与S1的早期实验，保留探索过程和必要证据；正式插件不依赖它们 |
| demos/standalone-preview/ | 临时独立版的装配方法、说明和证据；work/中的软件零件用于重建冻结版，不用于插件日常运行 |
| dist/ | 仅构建/验收暂存；发布核对后只留最新ZIP/校验，日常安装迁出仓库，正在注册使用的目录先保护 |
| AGENTS.md、README.md、.gitignore、.git/ | 分别是长期工作约束、项目使用入口、不提交的文件名单、Git版本历史；忽略名单不负责自动清理，也不代表删除授权 |

工作协作可理解为：app接线 → ui接收鼠标/键盘 → session调度当前视频 → eagle读素材/标注、media准备、cache管文件 → player显示画面和声音。frame-index负责“这个时间是哪一帧”，preferences负责记住内存档位。详细边界如下。

| 文件 | 职责与边界 |
| --- | --- |
| plugin/manifest.json、index.html | Eagle Window 与页面入口 |
| plugin/app.js | 宿主生命周期、依赖装配和事件接线，不承载媒体、缓存、标注业务 |
| plugin/ui.js、styles.css | 极简主画面与侧栏、状态及实际帧时间提示、带输入焦点保护的空格操作；只向会话发出操作，不直接访问文件或 Eagle 素材/标注 API；正式页面无测试控制 |
| plugin/session.cjs | 素材/库快照、状态与任务所有权，协调适配、准备、缓存和播放 |
| plugin/eagle.cjs | 唯一素材/标注 API 边界；独立读回，不直接写 metadata.json |
| plugin/media.cjs | 只读源媒体、分析和 FFmpeg；通过缓存句柄受限写入，不自行淘汰目录 |
| plugin/cache.cjs | 文件所有权、实际路径、预算、锁、完整提交、淘汰与清理；不操作 UI 或素材元数据 |
| plugin/preferences.cjs | 固定RAM档位/物理上限与旧百分比只读转换、本地原子保存；不访问素材库或清理媒体缓存 |
| plugin/process-identity.cjs | Windows进程出生/后代只读证明；独占句柄核对后接管空writer记录；未知时保留，不终止进程、不调用Eagle API |
| plugin/task-client.cjs、task-worker.cjs、native/task-host.cs | 窗口与后台请求、复用媒体/缓存、Windows互斥与任务组；控制消息不传图片，实际实现见A-07 |
| plugin/frame-pack.cjs | 校验集中图片包的纯布局；物理文件读写仍归cache |
| plugin/frame-index.cjs | 纯时间/源帧映射；整数 PTS、呈现编号与源时间关系 |
| plugin/player.js | Canvas、Web Audio 与调度；通过缓存读取/预算句柄取得资源，不调用标注 API |
| tests/、scripts/check.cjs | 隔离测试与统一检查；正式代码不依赖 prototypes，开发检查不进入产品 UI |

### 工作区整理入口

统一规则见[开发计划F机制](development-plan.md#发行产物统一整理f-01f-05f-06f-072026-10-16-用户批准)，本轮已清理8目标/187文件、911.65MiB，dist余18.67MiB；清单/保留原因见[发布整理记录](releases/v0.1.0-beta.2.md#工作区整理与文档一致性2026-10-16)。日常安装路径由用户指定，实际路径只记本机清理回执，不写进公开包。未重新注册前的旧安装副本保留；唯一待发包/校验工具所需目录待远程确认后清。冻结原型、原始证据及工具链不随dist整理删除。
