# 第三方组件与源码材料

公开绿色包使用未修改的上游运行组件，应用以独立子进程调用FFmpeg；没有把Eagle程序或素材库文件放进包内，也没有加入禁止更换FFmpeg或查看其源码的限制。

| 组件 | 版本/来源 | 包内材料 |
| --- | --- | --- |
| Electron | 44.7.2 Windows x64，上游electron/electron | 根LICENSE、LICENSES.chromium.html、licenses/Electron-LICENSE.txt |
| FFmpeg/ffprobe | BtbN LGPL-shared，n8.1.3-18-g46d899d7a0-20261013 | licenses/FFmpeg-LICENSE.txt（LGPL-3.0-or-later）、FFmpeg-version-buildconf.txt、FFmpeg-46d899d7a0-source.tar.gz |
| FFmpeg源码 | FFmpeg/FFmpeg的46d899d7a0 | 原始源码归档；其中含COPYING.LGPLv3及COPYING.GPLv3，公开包另提供可直接阅读的副本 |
| 构建脚本参考 | BtbN/FFmpeg-Builds，63ac3265b0789ea16c7b1f8351cd2ad195a28722，MIT | 原始源码归档、BtbN-LICENSE.txt、third-party-source-index.json |

本次FFmpeg二进制配置未启用enable-gpl或enable-nonfree。FFmpeg DLL、上游许可证、版权信息和源码归档保持原样；公开包的sources索引列出已保存构建脚本所引用的依赖仓库/版本声明，供追溯和获取上游材料。

## 获取源码

- FFmpeg对应源码已包含在软件ZIP的licenses目录，也在同一GitHub发行页提供独立附件，无需注册后索取。
- Electron及Chromium组件的许可证按原运行包保留；源码入口为[Electron v44.7.2](https://github.com/electron/electron/tree/v44.7.2)。
- 构建脚本参考归档保留MIT许可，来源为[BtbN快照](https://github.com/BtbN/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722)。各外部依赖按其各自许可处理，来源见包内索引与scripts.d。
- 官方说明：[FFmpeg许可与源码说明](https://ffmpeg.org/legal.html)。本项目未取得商业替代许可，不改变上游许可。

## 证据边界

已核对主运行包/FFmpeg源码归档的SHA、FFmpeg版本配置、许可证全文、FFmpeg源码提交、Electron/Chromium许可材料和构建参考的MIT许可。BtbN脚本是邻近时间的参考快照，不能声称已精确复现所有静态依赖或完成其全量法律审计；来源索引不会把这种未验证事项写成已通过。

项目自身代码的开源许可证仍未指定，本次不擅自为用户代码选择MIT/GPL。第三方组件不归本项目所有；各组件的版权和许可按包内原文保留。公开发行状态和MVP功能验收状态分别记录。
