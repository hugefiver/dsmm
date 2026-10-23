# DSMM

DSMM 是 DeepSeek Harness（DSH）的插件。它让不同 Agent 分工处理任务，给各个角色配置模型和备用模型，把常用设置保存成方案，也提供 Git 写操作等命令防护规则。

比如，让 Planner 拆解任务、Coding 写代码、Reviewer 检查结果，再由 Orchestrator 协调。各个角色可以用不同的模型，不必共用一套配置。

当前发布版本为 `@dsmm/dsmm@0.3.16`，支持 DSH `0.2.1-rc.2`。安装前请确认客户端版本；其他 DSH 版本暂不在支持范围内。Desktop 使用自带运行时，独立命令行环境需要 Node.js 22 或更高版本。

- 源码仓库：[hugefiver/dsmm](https://github.com/hugefiver/dsmm)
- 发布地址：[GitHub Releases (v0.3.16)](https://github.com/hugefiver/dsmm/releases/tag/v0.3.16) 与 [npm (@dsmm/dsmm)](https://www.npmjs.com/package/@dsmm/dsmm)

---

## 安装与升级

### 初次安装

1. 打开 DeepSeek Harness Desktop，进入 **插件（Plugins）** 页面。
2. 点击 **添加插件（Add plugin）**，输入 `@dsmm/dsmm@0.3.16` 并确认。
3. 安装完成后，检查插件是否处于启用状态。如果界面提示需要重启，请按提示重启客户端。

Desktop 的插件由客户端自己管理。全局 npm 安装和独立 npm 版 `dsh` 命令不能替代这一步。

### 已有版本升级（Windows）

DSH Desktop 当前不支持在界面中用同名版本原位覆盖更新插件。受支持的升级方式如下：

1. 保存好正在进行的任务，**正常退出并完全关闭 DSH Desktop**。
2. 使用 Desktop 安装自带的命令行工具更新配置。以下示例适用于 Windows 默认安装路径（`%LOCALAPPDATA%\Programs\DeepSeek Harness\`）：
   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @dsmm/dsmm@0.3.16 --save-exact --ignore-scripts --registry=https://registry.npmjs.org
   ```
   *若安装在自定义路径，请替换为对应的实际位置；非 Windows 系统请参考 Desktop 自身菜单或官方指引，不要混用非 Desktop 的独立 CLI 命令。*
3. 重新打开 DSH Desktop 即可加载新版本。

不要在任务还在运行时升级，也不要为升级手动删除配置。插件更新不保证正在运行的任务能继续执行。

---

## 启用 Deepwork

Deepwork 是 DSMM 提供的角色委派与模型路由工作流模块。

插件安装后，Deepwork 模块总开关默认开启，但新创建的普通会话默认不开启 Deepwork 模式。

- **在当前会话中开启**：点击会话菜单中的「启用 Deepwork」（英文界面为 Enable Deepwork）。开启后当前会话即可使用角色调度；再次点击「关闭 Deepwork」即可停用。
- **让新会话默认开启**：在预设方案配置中，将「默认 Deepwork 模式」（`defaultActive`）设置为启用。
- **模块总开关限制**：如果在插件部署配置中关闭了 Deepwork 模块总开关，会话菜单中将无法开启该模式；若界面提示需要重启，需重启客户端生效。

---

## 配置与方案

### 两种配置范围

DSMM 包含两处相互独立的配置区域：

- **插件部署配置（Plugins → DSMM bundle config）**：用于管理全局部署或当前原生 profile 的覆盖项，包括模块开关、全局执行策略与防护设置。
- **具名预设方案（Settings → Deepwork Profiles）**：用于保存不同的工作流配置（如日常编码、深度审查等），每个方案拥有独立的角色模型路由与参数。

### 方案保存、设为默认与会话切换

在 **Settings → Deepwork Profiles** 中编辑方案时，请注意以下操作的区别：

- **保存方案（Save profile）**：仅将当前修改写入文件保存，不会自动改变正在运行的会话，也不会自动变成新建会话的默认方案。
- **设为未来默认（Set as future default）**：将当前选中的方案设为后续新建会话使用的默认配置。
- **在当前会话中应用方案（Apply profile to current session）**：在已有对话历史的原生会话中直接更换预设方案。
  - 会话必须处于真正空闲状态：无正在生成的回复、无排队输入、无待处理审批且无运行中的子任务。界面单独显示 `idle` 状态并不代表没有后台活动，需等待所有操作完全结束。
  - 切换成功后，已存在的旧子任务继续保留启动时的原配置与限制，后续新委派的子任务才会使用新方案。
- **使用方案模型（Use profile model）**：把当前会话的原生模型选择切换为方案中配置的主模型。默认的 `rootModelPolicy: native` 下，保存或切换方案不会自动改模型；要一起换模型，需要明确点击这个操作。操作期间如果又手动选择了模型，以较新的选择为准。

### 配置角色模型与参数

在方案编辑页点击「配置全部 Agent 模型」（Configure all Agent models），可以为各个角色配置：

- **主模型（Primary）**：该角色优先调用的服务商与模型。
- **推理强度与参数**：按模型支持的选项填写，例如 medium 或 high。不同模型接受的值可能不同，不能把同一组档位套在所有模型上。
- **备用路由（Fallback Routes）**：当主模型不可用时依次尝试的候选通道（最多支持 32 个备用路由）。

### 在 dsh-TUI 中使用

终端适配提供 `/dsmm` 操作菜单、简单设置和已保存方案的选择，不另做复杂配置编辑器。DSMM 必须加载在 TUI 实际使用的 profile 中，Desktop 中已安装的插件不会自动共用。

如果希望根会话也完全按配置中的主模型和备用路由运行，可在 TUI 的部署配置中将 `rootModelPolicy` 设为 `configured`。它影响同一部署中的所有客户端，具名方案不能覆盖这个策略；其他独立部署默认仍使用原生模型选择。具体版本要求、配置范围和联调限制见 [TUI 使用说明](docs/tui.md)。

---

## 权限和后台任务

- **Git 保护范围不是执行许可**：“所有写操作”和“仅高风险写操作”决定保护规则检查哪些 Git 操作；检查后是询问、禁止还是关闭保护，由对应设置决定。选择范围不代表自动执行或批准命令。
- **子任务不继承临时授权**：子任务被拒绝的操作不会自动继承父任务已获得的单次审批。
- **禁止审批时会直接拒绝**：如果原生会话的审批策略是 never，需要审批的操作会被拒绝，DSMM 不能替它放行。
- **授权功能仍有限制**：目前没有按指定外部目录单独授予写权限、为子 Agent 开放审批，或跨会话记住临时授权的功能。
- **任务等待与取消**：角色调用默认等待执行完成。若需后台异步执行，须在启动前完成配置，正在前台同步等待的任务无法中途切入后台；取消任务请使用原生的中断操作。

---

## 相关文档

需要了解具体设置时，可以继续阅读：

- [预设方案](docs/profiles.md)
- [插件设置](docs/settings-status.md)
- [模型与备用路由](docs/model-routing.md)
- [权限与审批](docs/native-permissions.md)

参与开发请看[测试说明](docs/testing.md)、[兼容性说明](docs/compatibility.md)和[维护指南](docs/maintenance.md)。

---

## 许可证与归属

本项目遵循 [Anti American AI Public License (AAAPL)](LICENSE)，版权所有 © 2026 Hugefiver。依赖库与第三方授权详情请见 [docs/maintenance.md](docs/maintenance.md)。
