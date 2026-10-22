# dsh-plugin-scout 情报员日报

一个 **DeepSeek Harness（DSH）插件**：每天到点自动采集技术情报（GitHub、Hacker News、B 站等），用 DeepSeek 汇总成一份中文日报，推送到你的飞书群。

宿主插件负责跑、设置页负责配，待办清单负责告诉人「去哪拿、给什么权限」。

## 功能

- **每日定时**：DSH 宿主进程内定时（默认 19:00，Asia/Shanghai），不需要会话在线触发窗口；错过时点几分钟内自动补跑，跨零点写稿被拒收时自动换今天重跑一次
- **多源采集**：GitHub 搜索 / awesome 列表 / releases / Hacker News / B 站，源开关与限额在设置页调
- **飞书推送**：支持多个渠道、多份 Webhook；同一渠道逐条发送带间隔，防刷屏
- **峰时不拦截**：高峰时段照常运行（只在面板提示），跑不跑、几点跑由你定
- **演练模式**：全流程走一遍但不真发消息，验收报告和收录效果
- **待办清单**：缺什么凭据、去哪拿、粘到哪个字段、怎么验证，一条条列出来
- **成本透明**：设置页常驻 DeepSeek 官价小表 + 空闲/高峰实时徽章

## 组成

插件分两层，本仓库只含插件层：

| 层 | 说明 |
|---|---|
| **插件**（本仓库） | DSH 宿主工具 + 设置页 + 调度，通过子进程调用 scout 工程跑采集与写稿 |
| **scout 工程** | Python 写的采集/写稿引擎（`run_daily.py`），单独部署；插件配置里的 `root` 指向它 |

scout 工程的写入红线：插件只调用它；写入仅限 `config.yaml` 的白名单字段（行级编辑，注释保留、写前备份、写后校验失败自动回滚）和 `data/backups/`，其余一律只读。

## 安装

前置：Windows、DeepSeek Harness（desktop 或 web profile）、Python 3.10+、部署好的 scout 工程。

```powershell
# 解压后进插件目录，一条命令安装（含跨盘兜底）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop

# 看是否生效（desktop profile 由 Electron 管理，会拒绝 dump，属正常）
dsh --profile web --dump-config
```

装完重启 DSH，在 **设置 → 情报员日报** 完成配置。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Profile desktop
```

> 跨盘注意：profile 在 `C:`、插件在其它盘时，pnpm 对本地目录建不出 junction，`dsh plugin add`
> 会留下「依赖已记录、node_modules 里没有包」的半成品。`install.ps1` 会在 add 之后补一次实体拷贝。

## 配置

- **scout 位置**：设置页 `root` 字段指向 scout 工程目录
- **凭据**（GitHub token / DeepSeek Key / B 站 SESSDATA）：只在设置页配，密钥掩码存储；凭据只经环境变量传给运行进程，不进日志、不进返回值
- **渠道**：飞书自定义机器人 Webhook（支持签名 secret）或通用 Webhook；设置页会识别「URL 是飞书但类型配错」的常见错误并一键修正
- **定时**：`HH:MM` + 时区 + 是否强跑；非法时间会在面板报错而不是悄悄失效
- **白名单写回**：本期重点、日报条数、各源开关与限额等直接写回 scout 的 `config.yaml`，注释与键顺序原样保留

## 工具

| 工具 | 说明 |
|---|---|
| `scout_run_daily(dry_run?, force?, date?)` | 跑一轮日报；`dry_run=true` 只到发送前 |
| `scout_last_run()` | 最近一期摘要（日期/状态/收录数/是否真发/渠道/耗时） |
| `scout_test_channel(name?)` | 给指定渠道发一条【测试】消息，返回成败与人话诊断 |

## 开发

```powershell
# Node 测试（定时、加载去重、凭据判定、跨零点重试等）
node --test test/*.test.mjs

# Python 测试（config 写回与校验、飞书报文解析）
python -m unittest discover -s test -p "test_*.py"
```

改完源码重跑 `install.ps1` 即可刷新运行副本（实体拷贝，幂等）。

