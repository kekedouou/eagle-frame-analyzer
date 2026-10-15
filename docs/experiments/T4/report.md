# 阶段4验收准备执行记录

## 2026-10-15 本地准备完成，真实Eagle接线待验

来源为Codex本地检查、真实Windows自有进程/磁盘验证和用户停止线批准，三者分别记录。本轮未载入Eagle验收插件、未测真实画布性能或物理声画，不宣称T2/T4通过。正式`plugin/`运行文件保持bd7481f，用户集中体验认可仍适用；本次改动限tests/scripts、忽略规则与文档。

### 证据审计与样本

`node scripts/audit-mvp.cjs --read-only --samples`实际通过：T2的131目录/440文件/14375893B，308份封装记录摘要通过，另有1份早期未封装盘点；T3的48目录/96文件/312374B，48份封装记录摘要通过。旧T2锁保留，原件/额度未改。旧资源摘要3份（2历史通过、1失败），旧六轮性能摘要6份、复用摘要3份；源码覆盖均不足当前候选，不把旧通过值当新成绩。标注Eagle适配与时间索引相对T3标签未改，Player预算及会话/关闭/UI外围已变，原单素材写入凭据可有条件引用，现版本帧/交互仍需回归。

只读核对7段输入，文件SHA与登记一致，核对前后精确ID/大小/mtime不变；实际ffprobe规格如下。合成定义沿旧作者预期，本次未重新生成或以平均帧率证明所有VFR帧间隔。

| 输入 | 实际视频信息 / 容器时长秒 | SHA256 |
| --- | --- | --- |
| 地狱野蛮之锤 | VP9、3840×2160、nominal60、13.821；有Opus轨，既有结果为数字静音 | 1482d4d245564789866a00dcd8993a3cd3154df49b92d719962762f67e051931 |
| h264-cfr合成 | H.264、1280×720、30、有AAC、3.021333 | 2275abc6a31d82870e53510019edbc16b6b8cd10b8f0d9b75f3b02abb9a1f79e |
| hevc-vfr合成 | HEVC、1280×720、既有VFR定义、有延后AAC、4.199333 | 38dc934706748d415af8f1b81d5b04456fb9427618647789768a934314fa0c32 |
| vp9-silent合成 | VP9、1280×720、30、无音轨、2 | 0db3ea80f90190d66162caa225fd6823149957935783940fe5b2f3a07454194b |
| 索尼克（原10月11日） | H.264、3840×2160、60、有AAC、24.845011；ID MV3FZJJ7AC1CI | 0823a48f0d7b365163297206e8e8c66591c3aa6cf4c30253b3187d19c9644cba |
| 喜多郁代 | HEVC、3840×2160、60、有AAC、26.666333 | d7bbab0b425381c880adacb9f8d95d900aa162c4c5c9308cf9a3f8482ff67658 |
| 天空 | HEVC、3840×2160、60、无音轨、6.983008 | a35814395cc39b73c1d705b0d4cca7096ffb1974e6b85f9243815079195f1042 |

FFmpeg SHA256 `ba242553f0ff60ad788069d5d376c1b4f7a2f3a3566416e0ed950ca7920da5fa`；ffprobe `ae5db42a4b7d7fa719a325082e447adb5df674a69935117eb9dff2292a1f23ec`。本机正式偏好读到1024MiB，未修改。原H.264视频只重命名，内容摘要仍一致；此次只核对当前名称，不声称重新验过产品重命名缓存复用。

### 工具与Windows结果

- 纯检查覆盖旧记录被篡改/阶段不符、当前新增运行文件缺失、精确大文件ID；资源集合同时RSS/CPU差值/多核口径、PID重用、观察工具分列、未知归属/错误/停止线；记录单片/分片完整还原、摘要篡改拒绝、重复保存先校验、并发槽与空/截断槽保留。
- launcher模型证明记录准备失败不破坏正式路径/启动/关闭，关闭无晚到失败，实际T4不获取旧T2 writer；共用计量驱动24项检查通过，新增T4实际2GiB/3GiB及独立store接线。模拟UI/解码不作为真实Eagle通过。
- `node scripts/verify-resource-sampler.cjs`真实Windows通过5组：guard/worker分列、工具额外占用分列、错误创建时间排除、Node窗口替身的子进程发现、观察者仍开着时后台组能正常退出。隔离约3.5秒，2段各15样本；首段自有组RSS观测峰值54444032B，工具集合39682048B；同轮总峰值94126080B。第二段Node替身＋自有组97161216B，不是Eagle窗口成绩。最大采样间隔分别109.8497/112.0364ms，轮询跨度上界20.9435/23.5146ms；不能把它们当P-01画面停顿。无FFmpeg负载，峰值可能漏采，CPU退出尾段不完备。生成21688B隔离文件后核对ID/摘要定点清除。
- 采样源码SHA `77ca095e6c92078883f96c93c3a664bdb65ff80ec84762653e864e6a5658c9b3`，本机17920B EXE SHA `fb30a884040a71f98f9b8e806995bf773a3366e1c437705c171b81efce29894c`；未安装依赖。源码/脚本入Git，本机构建忽略且保留当前唯一产物。
- `node scripts/verify-t4-records.cjs`真实磁盘通过两独立进程原子占不同槽、跨进程读回、空/截断旧槽保留及后续写入不阻塞。生成1460B后按已核对的自有文件定点清除；未访问真实T4记录/正式缓存/素材库。
- `node scripts/prepare-mvp-host.cjs`生成9546B可加载文件及指纹，路径为tests/host/t4，独立ID EVAMVPACCEPT20261015；未载入Eagle、未运行自动拖动。最终指纹随当前源码重新核对，旧T2入口保持停用。

用户本轮明确接受“2GB档按合计3GB保护”，已落实verification及采样/驱动检查；默认1GiB仍合计1.5GiB，FFmpeg每进程1GiB。停止线调整不等于RAM设置或高画质验证通过。

### 最终检查与原始记录

统一检查实际通过107份脚本语法/依赖、全部单元/模型、28份文档235条链接及9546B当前验收入口/构建指纹；随后文档追加证据引用只复核链接，不重跑媒体或旧测量。正式plugin相对bd7481f无改动，用户偏好仍1024MiB，两种scratch均不存在。T4记录当前3个槽/39970B，含阶段说明，未预填32MiB。

| 原始记录 | 结果与边界 | 文件SHA256 |
| --- | --- | --- |
| [本地完整检查及只读样本审计](../../../verification-runs/t4/slot-000/record.json) | stdout/审计JSON完整压缩保存、读回还原一致；所有7段SHA与本报告一致；非Eagle GUI | ca06adc323f144d2664896c06217c3d3e4c13b8db599de6ee521586b7951af74 |
| [Eagle内置Node兼容](../../../verification-runs/t4/slot-001/record.json) | 实际v16.17.1执行6组新/共用纯检查全部通过，不是SDK/HTML/画布验收 | 70cd299c0ce08aff789b91a0ac128c65df2cbef01da8cbee0582a65bca62470c |
| [Eagle Node模式Windows集成](../../../verification-runs/t4/slot-002/record.json) | 同v16.17.1下真实并发记录/精确文件身份读回及guard/worker/采样器5组通过；1448B与21688B隔离产物均清除，GUI/正式缓存未触及 | a25fef69012a539cf6ece2d489fed7bdaedee0bf244877724110a93ea78362d6 |

上述三份是原始工具/Node运行结果，含同批32个来源指纹；由t4-evidence.readReceipt只读验证/还原，不要求用户执行命令。第三项的自有组RSS观测峰值57393152B，Node窗口替身组合97107968B；只是约3.5秒空闲隔离检查，不能当实际插件或长时资源成绩。末次文档核对28份/238条本地链接及git diff --check通过。所有本地/旧失败证据保留，不创建T2/T4完整通过标签。工具准备已提交2385979；当时加载授权未到，后续授权见下节。

### 首次短回归已获授权，等待实际打开

用户原话“允许载入并进行这次验证”，对应“视频分析 · 阶段4验收”入口、“索尼克”默认1GiB短回归、约2～3分钟前台验证；原视频/标注只读，设置不变，正常缓存5GiB，新记录独立32MiB。已授权事项不再次询问。

Codex尝试只读检查Windows可操作控件：Eagle主窗口存在，控件树只有窗体及一个不可操作窗格；当前工具也没有可用桌面控制能力。未点击、未载入、未修改Eagle配置；不能据窗口存在声称宿主接线通过。需要用户关闭其他视频分析窗口，在Eagle载入包含manifest.json的整个tests/host/t4目录，选中索尼克后打开新入口。打开后由现有工具自动计量，用户不必输入命令；取得记录后再核对真实性、指标和限制。

### 首次真实加载中止：观察工具启动边界遗漏

用户截图显示资源观察停止、窗口停在“正在关闭”。只读验证slot-003～005的封装及内容摘要通过：真实Eagle pid18532，默认1GiB，选择MV3FZJJ7AC1CI。仅3个资源样本，第三个在205.3491ms发现guard/worker，worker pid31708出现NullReferenceException；同一轮稍后已经读到该worker的172683264B RSS。插件集合观测峰值393359360B，低于1610612736B停止线；performance=null，未执行拖动，不记为播放器性能失败或内存超限。启动/轨迹/摘要SHA依次450c0f9d3e331c220e62eec4e4af0853401acbcfe9a86ec8ce93f22a32b34433、b2b1d4dce0abcfcedc412ed51b1228306756711812a8e171d76c6d08bfa0a3d2、c8461ace98cb43c9f94d4bbf4ca1ccabfaab5aa04e970d3577d8d8d364f4acba；原件保留。

代码中进程映像通过Process.MainModule.FileName读取，该模块列表在进程刚启动时可能尚不可用；具体异常栈未记录，因此空值位置按源码及同轮恢复证据定位，后续用原实现与修正版启动压力对照。原Windows自检先等worker就绪再观察，漏掉了真实入口“先观察、后启动worker”的顺序。另有独立测试入口缺陷：观察失败直接请求formalClose，只等清理却未显示完成状态，造成“正在关闭”停留，不把它归因于正式窗口退出架构。

本轮修复限测试工具：改用Windows进程映像查询接口并保留身份/访问错误检查，补充先观察后启动/退出的隔离回归；清理结算后明确显示“测量已停止/清理完成”或失败。原测量门槛、停止线、正式plugin和设置不改，不靠忽略错误或扩大RAM使测试通过。

依据：[微软MainModule说明](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.mainmodule?view=netframework-4.8.1)明确未加载完时可以返回null；[QueryFullProcessImageName](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew)可用有限查询权限取得映像名称。实现另外用该句柄的GetProcessTimes核对创建时间，避免PID复用错认；真实访问错误仍停止，并补充operation/message/nativeErrorCode，未吞掉原错误。

修正后的真实Windows7组自检通过，包括先观察再启动/退出8个worker，以及一个由测试句柄控制、尚未初始化的Eagle Node子进程。该子进程的旧MainModule查询实际抛Win32Exception，新查询在放行执行前已正确识别；它重现了“初始化前旧信息不可用”的边界，不伪称再次捕获完全相同的NullReferenceException。8次普通启动在原Eagle Node观察器下也曾全部通过，因此随机短循环不足以排除本次问题。Node24检查中额外发现其自有Windows conhost被当作未知程序；只对系统目录的conhost明确分列并计入插件总RSS，未知程序仍失败。生产端/分析端与模型同步，新角色和可选错误/清理字段不改变旧T4封装/摘要，原记录仍可读。

| 原始记录 | 实际结果与限制 |
| --- | --- |
| [真实入口失败摘要](../../../verification-runs/t4/slot-005/record.json)、[3个资源样本](../../../verification-runs/t4/slot-004/record.json) | 仅证明本轮准备及观察中止，performance=null，非P-01/P-02成绩 |
| [Node24 Windows修正版检查](../../../verification-runs/t4/slot-011/record.json) | 7组通过、8/8 worker可见、启动/暂缓初始化样本无停止原因；SHA c249e51f1d9a25fdfe2a7f399a9f37e433ae066c533e4a36063e63c37428a105 |
| [Eagle内置Node修正版检查](../../../verification-runs/t4/slot-012/record.json) | 资源分析/协调/监控3份模型及真实Windows7组通过，非GUI复测；SHA ad4c47f51b474c596f99208b75ec7597b07d6ad338ac556709979def1af52db3 |
| [自检断言失败](../../../verification-runs/t4/slot-008/record.json)、[隔离原件与清理计划](../../../verification-runs/t4/slot-009/record.json)、[清理结果](../../../verification-runs/t4/slot-010/record.json) | 最初断言过度限定只能为null，实际为Win32Exception；先保留全部原件，再按清单/精确身份定点清7文件。本机后续成功轮次生成34750B，按同一规则清完 |

launcher模型另证明：清理未结算仍显示关闭中，真正结算后才显示资源已释放；拒绝时显示清理失败；用户真实关闭后不晚到写证据。当前新观察器19968B，源码SHA a19f0fd133b7900a138782f0f3b8fee411dfa8ebb80318667224eb486f5ddc6f，EXE SHA a3d6e23d3368995383265857c829fafcfd383dd33b8fe410511d008e8f85df82。入口同路径/ID重新准备9546B，无需再次导入；旧截图所对应窗口需关闭后再开。测试临时目录已清，无自有观察/fixture/guard残留，正式设置仍1024MiB。原始和隔离失败均保留，未扩额度或自动复跑真实视频。

本轮最终统一检查通过107份脚本、全部纯/接线模型、28份文档246本地链接及9546B入口/构建指纹；[完整stdout及只读缓存盘点](../../../verification-runs/t4/slot-013/record.json) SHA 2d7d63967693ed9361d9dbf21ae3689a5933b53e65b694034520552034c65cd3，含当前32份来源及4份新增/修改检查源码摘要、实际Eagle Node16.17.1。正式plugin相对bd7481f无改动。事后只读缓存盘点1份完整缓存、20795331B、0lease，未发现writer/partial导致盘点拒绝；它不是素材完整SHA或新的性能通过证据。T4现14槽/124499B，低于原32MiB；末次补记只复核文档/Diff，不重跑媒体或历史实验。真实Eagle修正版回归尚待用户打开同一入口，不创建T2/T4完整验收标签。

### 再次真实加载中止：辅助进程用途登记遗漏

用户再次截图，slot-014～019显示两次真实入口均以owned-process-role-unclassified停止。分别10个样本，未开始拖动；唯一未知项为worker调用的powershell.exe（pid18868/30108），集合RSS峰值436797440B/444981248B，均未达1610612736B停止线。两次observationCleanup.status=completed、result.status=closed，与截图的“资源已释放”相符；上次查询修正和停止提示已实际运行，但不能据此宣称当前回归通过。原件保留，最新轨迹SHA 9f07aa0354a6c8ec3578d8eea88308d52a6818cd5677b1f71489358eb10559df，摘要SHA d3f7890c20a3cef7c570f0ff8e9b7bf0d6555466256142f95b25fd291cfec709。

生产代码调用清单已审查：task-client启动guard，guard启动Eagle Node worker；process-identity调用Windows PowerShell核对身份/恢复；media启动ffprobe、FFmpeg及PowerShell RSS观察；旧空writer恢复的Add-Type可能调用.NET csc/cvtres。此前假worker只做ping，不执行真实身份查询，7组局部通过不能覆盖这条生产调用链。这是测试工具的覆盖遗漏，不归因于用户重开或RAM额度。

本轮限测试工具补齐：对实际系统目录的Windows PowerShell及其既定.NET编译辅助程序单列system-helper，仍计入插件总RAM/停止线；其他路径或未知用途仍停止，新增完整映像路径便于核对。隔离子进程在先观察后初始化时直接调用当前生产process-identity，并保留原启动边界/退出用例。所有写入/读取端按新增可选字段和角色一起核对，不删旧记录、不改播放器和产品架构。运行结果随后追加。

实际Eagle Node模式Windows检查通过8组，[原始输出及输入源码摘要](../../../verification-runs/t4/slot-020/record.json) SHA 42556e34b1a539597e1fddc73738cd2baaa91f520076511cb89e5d8b6077d5e0。16个样本观察到C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe且归类system-helper，生产self查询成功返回才允许子进程以0退出；暂缓初始化及8个worker启动/退出的原用例仍通过。生成35732B隔离产物后按原精确身份/摘要定点清完。系统辅助RAM在纯检查中能触发同一插件集合停止线，不是排除其占用后通过；未知角色仍能触发停止。

本机采样器20992B，源码SHA d456b004cf0b53c426a52dba40b912c1c574bacc554b40f5d03bcbbfbe98c186，EXE SHA ae22d5adadc2fb1f558e17b8d469081f3bf0f6a89c235ef7da7109a493e0294c。同一tests/host/t4入口/ID已重新准备9546B，偏好仍1024MiB。旧空writer编译恢复仅静态审查既有csc/cvtres调用及准确系统路径，本次未实际执行；本次8组也不代替真正的视频准备/绘制或完整P-04。真实窗口需关闭后重开同一入口，不能把隔离通过当新六轮成绩。

最终统一检查通过107份脚本、全部纯/接线模型、28份文档249本地链接及9546B入口指纹；[完整输出与当前源码/只读盘点](../../../verification-runs/t4/slot-021/record.json) SHA 23f9ff444f4299217735212c878a754a0ddc605caa76d28c548efe04238de33a。正式plugin相对bd7481f仍无改动，现有缓存1份/20795331B、0lease；临时目录已清，未删真实缓存或素材。T4当前22槽/176022B，仍在32MiB内；末次补记只查文档和Diff，未重跑旧媒体实验或发布。真实修正版性能结果继续待验。

### 尚未通过

当前需要首次真实Eagle入口接线及默认1GiB下“索尼克”六轮回归。其后仍有全编码/独立帧参考、P-03首次及复用各3轮、新进程长时资源、必要异常宿主证据。原T3素材写入授权已关闭，真实Eagle强退未授权；不能用本轮隔离进程结果代填。完整执行方式/有限记录/人工加载见[计划](plan.md)。本轮不发布、推送或创建T2/T4完整验收标签。
