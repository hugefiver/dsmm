# DSMM → dsh-TUI 原生适配实施计划

## 1. 最终目标与约束

dsh-TUI 的 **DSH kernel** 能通过原生插件链安装、加载 DSMM，并使用 Desktop 对应的 Core、Deepwork、配置、会话和角色委派核心功能。终端只提供简单开关、选项表格和命令；复杂配置复用现有 Global、native-profile 与 named-profile，不重做编辑器。

**TUI 不做模型调整：在其独立部署 profile 显式设置 `rootModelPolicy: "configured"`，合资格 root 使用已 admission 的 primary/继承/fallback 配置，在既有策略允许的障碍下自动回落。** 不自动识别请求来自哪个客户端；同一 configured 部署中的 Web root 也遵循配置。策略默认 `native`，独立 Desktop 默认保持 native 用户模型优先。执行、会话、prepared call、权限及持久化仍由原生 Host 所有，不引入替代 runtime、shell wrapper 或 permission 系统。

- 本仓库为完整独立项目；构建输入不得来自父仓库或兄弟项目。
- 交付 `@dsmm/dsmm` **0.3.16**，保持所有 DSH **0.2.1-rc.2** 依赖及未被本任务明确改变的公开契约。
- TUI 兼容依据为已发布 **0.16.1**，源码 `ccch1mneyyy/dsh-TUI@73ff99fbed56563bf154d719effd09f9f9725349`；不依赖 main 新增的顶层 page、effort options source 或私有 API。
- 保留 `ea93049` 的 client-ready 修复；不修改用户未跟踪的 `docs/superpowers/plans/2026-10-22-profiles-page-redesign.md`。
- Git 写、用户 Host 操作、依赖安装、发布和配置迁移分别需要明确授权。实际安装/启动测试须有明确的隔离资源和操作授权；缺失即报告 `missing`。
- 保持 Web client 及 Web RPC 的 operator/Peer/Connection 校验。DSMM-managed LSP 默认关闭，已有的条件性启动挂载路径保持不变；保存配置不会动态重新挂载。
- trusted local TUI 的真实托管 dialog 对具体 action 的单次确认是本地用户同意，不是认证 Peer、可转交 token 或持久 grant。

## 2. 功能范围

| 能力 | 终端表面与完成行为 |
| --- | --- |
| 安装/加载/卸载 | 原生插件管理器、manifest 与现有 bundle patch；可发现命令和设置；明确准入失败/缺服务；释放所有注册与 pending dialog |
| 状态 | TUI 使用 `/dsmm status [json]` 和 `/dsmm` 简单菜单/表格；区分 desired、startup、next-root、current admission、未来默认、module readiness、restart-required 与实际请求路由；Desktop 保留 `/dsmm-status [json]` |
| 模式 | TUI 使用 `/dsmm deepwork [off|message]`，保留原目标资格；Desktop 保留 `modeName` 和原生命令；TUI 动作确认绑定 maintenance 提交和 steer，不扩大成 module-on |
| Native-profile 简单配置 | `/settings` 的真实 DSMM namespace：`rootModelPolicy`、`defaultActive`、`locale`、`workflow.policy`、`subagents.toolTopology`；支持稀疏继承、显式 pin 与清除；策略选择不是模型编辑器 |
| Global 简单配置 | `/dsmm config` 仅开放上述适用标量与 `modules.deepwork.enabled` 的 set/unset；明确 Global 作用域、确认后使用既有 CAS/协调器 |
| Named profiles | `/dsmm profiles` 动态列出已保存 profile、诊断和 revision；选择/清除未来默认、当前会话 Apply、当前会话 pin baseline；不编辑文档、不把浏览当激活 |
| 配置模型路由 | `rootModelPolicy: configured` 的合资格 root 使用当前 admitted role primary、继承 baseline 与有效 fallback 链；无终端模型编辑/选择按钮或命令；状态显示实际策略/路由及回落原因，不把任何前端 picker 当生效凭据 |
| 角色与任务 | 复用 admission、角色工具、提示/技能、原生子任务与恢复；观察实际启动、结果、取消及 Queue/Steer/interrupt 对应功能，不以 preset 文件或接收回执证明可执行/完成 |
| 复杂配置 | 沿用现有 Global/native-profile/named-profile 配置方法；不复制 Desktop profile、不生成镜像、不开放任意文件路径或任意 JSON setter |

只读调用不创建/恢复会话。workspace 与会话创建使用原生 TUI，再明确应用 profile，不自动选第一个 workspace。共享 home 中 Global/named documents 可以共享，但 native overrides、未来默认和会话 selection 仍按真实 profile/entry 身份隔离；默认 `dsh-tui` 不等于 Desktop profile。Windows 原生 full-access/approval-never、child never 和 DSMM guards 均不由适配器改写。

## 3. 接口、装配与生命周期

### 最小模块与共享接点

- `src/tui-adapter.ts`：TUI capability 软探测、管理服务生命周期、命令/设置区块注册；动作逻辑足够复杂时拆 `src/tui-actions.ts`。只声明使用到的结构接口，不增加 TUI runtime 依赖。
- `src/index.ts`：在已有 `dsmmProfileRuntime`、`dsmmDeploymentConfig`、`dsmmNativeAdmission` owner 下接线；模型路由只消费既有 immutable admission，不创建 TUI root 绑定或第二个业务 owner。
- `src/commands.ts`、必要的 `src/state.ts` 内部事务接点：复用定义/业务逻辑，给 TUI mode 动作在实际提交及 steer 前检查 authority；保持现有导出默认行为。
- `src/profile-runtime.ts`、`src/deployment-config.ts`：复用 `describe/read/select/getSession/selectSession/selectMode`、`saveGlobal` 及 authority callback；不绕过或放宽 `src/profile-rpc.ts`。
- `src/settings.ts`：新增部署策略及其解析/投影；`src/profiles.ts` 保持部署字段不进入 named overlay。模型接点位于 `src/model-routing.ts`、`src/runtime-recovery.ts`、`src/role-routing.ts`、`src/role-llm-runtime.ts`、`src/host-llm.ts` 与 `src/status.ts`。共享一个基于 admission 的内部 root routing decision/capture，不查询客户端身份。

### 命令、manifest 与注册

1. 保留原生 `inject: [profileContext, agents]`；TUI 服务只通过 `ctx.get(name, false)` 软探测，不放入 inject。使用 Cordis 服务/owner 生命周期通知处理首次、晚到、替换与移除；仅对 `COMPONENT_NOT_ADMITTED` 使用绑定 owner/generation 的有限重试，耗尽后诊断并停止，其他拒绝不重试。
2. `tuiPluginHost.registerCommand(pluginCtx, contributionId, definition)` 使用真实 DSMM activation 和稳定贡献 ID；mode 显示名保持可配置。Desktop 保留 `commands.register`，同一 owner 不得同时存在 mediated 与 raw 同名副本。新增菜单遇到已有命令冲突时明确拒绝，不能覆盖命令或修改用户配置。
3. **同一 DSMM activation 一旦接入 TUI 管理 Host，准入失败、服务掉线、替换等待期间管理命令只撤销/标记 unavailable，绝不恢复 raw fallback。** 新的有效 TUI owner 才能恢复 mediated 注册；晚服务接入须撤销旧注册，不能留下无归属副本。此管理注册状态不参与模型路由决策。
4. `dsh-plugin.json` 使用 manifestVersion `0.15`、host facet `v1alpha1`、`commands.dsh/v1alpha1#Command`，仅声明 `/dsmm` 对应的 `com.hugefiver.dsmm.manage` contribution 和该精确 scope 的单条 `commands.invoke` 权限。TUI 命令整体启用或撤销，不分别授权子命令；host entry 对应实际包入口。保留独立的 `package.json.dsh.client.platform: web`；manifest 不声明 client/worker facet。
5. `package.json.files` 纳入 manifest，保留现有 exports/Web client/bundle patch；patch 决定实际 Loader 装配，不重复挂载 DSMM 或 TUI 服务。注册清理绑定 activation，不能绑到 `ctx.root`。
6. 管理服务身份按 Cordis original identity（必要时 `symbols.original`）与 TUI `generationId` 比较，不能把调用 proxy 的变化误认成 owner 替换。管理服务停用/替换取消 dialog、撤销注册/监听及动作授权，旧结果不能晚写或重新注册；不能仅因该服务丢失而取消仍有效的 DSMM 模型请求。

### 部署级模型策略与 immutable capture

最小字段为顶层 `rootModelPolicy?: "native" | "configured"`，解析后的 `DsmmSettings.rootModelPolicy` 必填、默认 `native`。它是路由语义，不是身份标记、权限、admission 或 executor 可用性的证明，也不改变 `modelParameters.passthrough` 的独立含义。

- **作用域：** Global 与当前 native-profile 均可配置，沿用 defaults → sparse Global → explicit native-profile 优先级。仅独立 TUI profile 显式设 `configured` 即可完成目标部署；公共 `cordis.patch.yml` 不写此默认，避免安装包改变 Desktop。文档给出原生 DSMM entry 的 `config: { rootModelPolicy: "configured" }` 配置片段；实际写入仍需正常授权。
- **Named profile：** 不允许设置此字段。`profiles.ts` 的 `DsmmProfileOverlay` 为显式 Pick，`OVERLAY_FIELDS`/`validateProfileOverlay` 为独立 allowlist；不扩展它们以接纳部署策略。named 文档仍可选择角色 primary/fallback 等现有字段，但不能改变部署对这些配置的采用方式；传入策略字段应按既有 unknown-field 规则拒绝。
- **解析与同步：** 同步 `settings.ts` 中 `DsmmPluginConfig`、`DsmmSettings`、`DEFAULT_DSMM_SETTINGS`、`CONFIG_FIELDS_SCHEMA`、`DSMM_SETTINGS_SCHEMA` 和 `resolveConfig`（含直接调用的 enum 校验）。Global/native sparse schema、`deploymentEditorSchema`、merge/validation 沿既有派生链工作，禁止把默认值写进 sparse 层。同步 `status.ts` 的手工 `readOnlySettings` 与来源/实际策略投影；既有 Web 部署编辑器只需在 `client/deployment-modules.ts`、`deployment-locales.ts` 分类/标注该枚举，不新增编辑器或改 client-ready。
- **生效：** 保存只更新 desired，不热改驻留 Agent。新激活/冷恢复或已有显式维护事务成功重新 admission 时捕获当前部署策略；不新增 restart pin、热挂载或独立刷新通道。named Apply 沿现有事务读取 deployment，不能用 named 内容替换部署策略。状态分别显示 desired 与 admitted 值。

内部接点在 recovery 前从 exact live admission 捕获 routing mode、Agent/frame/signal、admission epoch、role/policy 身份与路由 generation，并贯穿 prepared call。DSMM owner 退休、Agent 替换、admission 或相关 policy 改变使旧 lock、prepared call、pending retry 与异步结果失效；失效不能静默降为 native。TUI 服务是否存在、哪个客户端发起请求、是否处于管理命令 context 均不参与该 capture。只卸载 TUI 管理服务而 DSMM owner/admission 仍有效时，配置路由继续有效。

## 4. 本地动作授权与配置事务

真实 `tuiDialogs` 队列由 Host 私有保存；公开 `select/confirm/input` 绑定 activation，取消/超时/owner disposal 结束请求。严格 `true` 才是 confirm 同意。命令调用、`commands.invoke`、rawInput、Agent、缺失 invocation 和客户端 `confirmed` 都不是写授权。模型最多请求显示确认，不能自动确认或使用 `--yes` 跳过。

1. 捕获当前 service/owner/generation、作用域、snapshot/revision 与本次取消。session profile 操作仅接受 invocation 的 exact live ordinary root，核对 registry 对象、session ID、roots 和父 owner；**既有 mode 命令保持 `DeepworkModeController.select()` 的目标资格，不套用 profile 的 root-only 限制**。
2. profile 选项来自本次 inventory，回答 ID 必须回查；超过 Host 的 100 个选项限制时简单分页或精确 ID 查找。确认清楚显示动作、目标 ID、Global/native/session 作用域及关键变化，Global 说明共享影响；采用安全有界文本，不能让截断隐藏关键身份。
3. 合并 invocation、DSMM/admission lifetime 与操作取消，并设有限 timeout。确认绑定原始 Agent/目标，不重定向到新前台；命令 signal 不能被当作所有导航的取消证明。取消/超时/owner 丢失时不开始提交。
4. 同意保留在单次事务私有闭包，传入现有 authority callback；该 callback 可以被事务重复检查，但同意不能用于另一操作。每次 await 后及 precommit 检查 owner、Agent、admission、相关 revision、配置 writable 与 activation 的当前 grant。不能伪造 facade 不支持的任意 root principal 查询。
5. Global 带 `expectedRevision`；profile 带 `expectedRevision/expectedSelectionRevision`；session 再带 `expectedAdmissionEpoch`，适用的 mode API 带 `expectedModeRevision`。业务 command 冲突必须重新读取/确认，不自动把旧同意用于新版本。
6. mode 的检查必须进入 maintenance 提交点并在 steer 前再次执行，不只包裹旧 handler。mode 已提交但 steer 失败报告部分结果；所有事务保留 committed-but-refresh-required，不因晚取消或观察失败声称零变更，不自动重试未知结果。

`/settings` 是 Host 的另一种明确用户操作：布尔/枚举改变、文本 Enter 即保存，没有独立 Save，Esc 不撤销已发起写入。保留 Host namespace、`settings.mutate` 授权/CAS 和冲突刷新 revision 后重试一次的语义，不套用业务 command 的重新确认流程。

- 区块注册用真实 `nativeNamespace`/descriptor；不可用或不合法时明确拒绝，不拿包名/row ID/改名 namespace 替代。
- 使用公开 `TuiSettingsField.parse/format`：布尔为“继承/开启/关闭”，枚举有“继承”，继承解析为 `{ kind: "clear" }`，其他项为正确类型的 set；UI sentinel 不写入配置。
- missing、false、空值和同默认值的显式 pin 保持语义；Unset 只移除该层，不把 merged defaults 写回。静态 options 只放固定枚举，动态 profiles 不放进去。无任意业务 setter、`onSave` 或复杂编辑器。
- Global 仅有限标量 allowlist，复用 `saveGlobal` 候选校验和现有 write coordinator；`modules` 不进入 native/named。cold-off 后 desired-on 保持 restart-required，不热挂载。
- session Apply 复用 native maintenance、整棵关联子树静止检查与原子 publication，不以 `idle` 标签替代；有历史但满足条件的 root 仍可 Apply。历史、draft/attachments、child capture/ceiling 不改。下一请求按新 admission 的部署策略执行；`native` 部署保持原生模型优先，`configured` 部署使用配置，不区分客户端。
- 普通状态只用 redacted projection，不直接打印 Global/named 原文、环境或凭据；浏览、保存、未来默认与 current admission 分开。

## 5. 显式部署策略的请求路由与自动回落

### 适用范围与数据流

只有 **exact live DSMM admission + admitted `rootModelPolicy === "configured"` + admitted `modules.deepwork.enabled` + 当前有效 DSMM role** 的 ordinary root 使用配置路由。同一部署的 TUI/Web root 一视同仁；`native` 部署保持原生用户模型优先。role 由实际 `resolveAdmittedDsmmRole`/mode/preset 规则确定：普通 preset 的 Deepwork off 没有 orchestrator role，沿用 native baseline、不启用 DSMM role fallback；standing DSMM preset 的 role 仍按现有语义有效。Core-only/module-off 和未 admitted Agent 不获得该路由权限。子任务保持既有角色/调用 capture 语义，不借本次 root 改动扩大权限。

请求流为：immutable deployment/admission capture → native assembled proposal → 本次 role/policy 与有效候选选择 → 既有参数投影及 Host 解析/prepared-call capture → 原生请求头/真实 provider stream → 既有证据驱动 recovery。所有阶段使用同一 Agent、frame/signal、admission epoch、rootModelPolicy、role policy、route generation 和 step 身份，await 后重验；不读取最新磁盘配置覆盖不可变 admission，不接受模型调用参数改变策略。

无显式 primary 时保持稀疏继承：使用 Host 配置形成的 native assembled baseline；有 primary 时配置优先。候选复用 `orderedModelRoutes([primary ?? inherited, ...effectiveRoleFallbackRoutes(...)])`，保留 fallback 来源、顺序、显式空链与既有策略预算。不发明默认模型、扫描 catalog 任选模型或扩大规则；没有可解析候选时报配置错误。

### 必须一致修改的接点

| 接点 | 必需行为 |
| --- | --- |
| `model-routing.ts` 的 ordinary-root 提前返回 | `native` 策略继续锁 native assembled；合资格 configured root 复用现有 role candidate/initial admission/lock 路径，不直接返回原生选择 |
| 同文件 manual-selection 与锁路径 | configured 路由不将 native `model/selection` 变成覆盖 primary 的授权，也不因此增加候选或重置回落预算；native 策略和已有 child 的用户优先语义不变 |
| `role-routing.ts` 的 policy identity / `persistedRoleRoute` | root 策略进入相关 policy 身份；configured root 只接受当前 policy/generation 对应的有效配置候选及已验证 recovery 结果，不能采用任意非链历史 Host route；冷恢复不继承旧授权/预算 |
| `runtime-recovery.ts` 的 pending prepare | 现有 root 在应用 pending route 前返回 downstream；应允许同一有效 configured admission capture 消费 pending route，同时保留所有 failure/header/attempt/generation/step 检查 |
| 同文件 request-error 切模 | 现有 429 switching 仅限 subagent；最小扩展为子任务或合资格 configured root，仍受原策略与预算限制。prepare/error/等待后重验使用相同 routing decision |
| `host-llm.ts` / `role-llm-runtime.ts` effort 与 call capture | 当前普通 root 或历史 native intent 会标为 native effort；configured 路由必须传递本次实际选中 route 的来源，避免将配置 effort 误标为用户选择。保留 `modelParameters` 策略、native-defaults/passthrough、能力验证及 raw seam 拒绝 |
| `roleRouteRuntimeState` / `status.ts` | 当前 root 固定 `startup-lock`，且 `createDsmmStatusSnapshot` 隐藏 root primary/fallback 并覆写 runtime strategy；按 admitted 策略联合修正，显示实际策略、primary/继承来源、route、回落/预算和未知状态；native 策略投影不变 |

最小共享接口是基于已 admission 的 `rootModelPolicy` 的 request routing capture 与路由结果（最终 config、来源、当前 policy/generation），由初选、recovery、参数投影和状态消费；除新增部署字段外保留现有公开 API 默认行为。不增加身份 token、selector 或模型所有权服务。native model 事件可保留为 Host 事实，但不是部署配置修改、retry/fallback 授权或旧结果重放依据。

### 回落边界

- 初始 `selectInitialModelRouteChoice` 只在机器可判定的 missing provider / `UNKNOWN_MODEL` 下继续候选；保留其 status/类型约束。身份认证、权限、取消、参数/能力错误直接拒绝。
- 运行时必须有准确 committed attempt、header、generation/step 和确定无输出证据。路由不可用回落保留现有 startup 未 settled、首次 attempt 等条件；429 只有既有 `rate-limit-fallback`、阈值、maxRetries/maxSwitches/delay/total budget 满足时才换候选，否则按既有有限同路重试/终止语义处理。
- cancel、auth、permission、quota、partial output、证据缺失/错序均不产生 DSMM fallback；普通网络错误或任何笼统“障碍”不扩大为通用 retry。预算耗尽、候选耗尽、scope 退休后不落入上游无限重试。
- 回落只改变本次被授权的请求路由/既有 policy lock，不写配置文件、native picker/default preference、`Agent.options` 或合成 `model/selection`。不导入 TUI 私有 channel、不安装第二个 model-selection owner。
- TUI 自有 `/model` 若存在，本适配不 patch/删除它，也不把它变成 DSMM 配置编辑器。在 configured 部署中，显式配置 primary 优先于 TUI 或 Web native picker；未指定 primary 时仍是已有 native baseline 继承。native 部署保持用户优先。DSMM 状态/说明明确实际策略，不承诺 picker 展示即配置路由，不改 Desktop client-ready。

### 原生 capture 顺序与可执行性

本地 rc.2 `dsh-agent-loop/lib/index.js:prepareRequest` 的 `agent/request` waterfall 在 provider/model 完整性检查和 `llm.prepareCall` 之前；DSMM `createDsmmRoleLlmOwner.preflight` 在 `resolveCallConfig`/provider generation capture 前调用 `prepareDsmmRequest`。发布版 startup `validateModelRoute` 的 baseline 校验有自身 fallback 行为，不能将 baseline 错误推断为必然启动失败。配置路由可先用不含 TUI 服务的真实 source fixture 贯通 prepare/recovery，再验证 TUI 组合，无需构造虚假 TUI owner。

实现必须覆盖 native baseline 缺失/失效而 admitted primary 有效的情况，不能先对无关旧 provider 做失败 capture 再尝试配置。不要在选择 primary 前无条件 `modelRouteFromCall` 校验不需要的 inherited baseline；选择后才为实际 route 绑定 provider、capabilities、effort 与 raw/stock generation。无 primary 时必须保留 baseline 校验。原生更早的 system-prompt/启动/图像预检不能靠伪造能力或改 options 绕过。

**验证限制：** source fixture 必须覆盖有效 configured primary 配合缺失/失效 baseline、首次 root/cold resume、system-prompt/setup 和请求最终 provider capture；TUI 实机还需覆盖其 startup fallback 到达同一流程。只有观察到路由接缝前确实拒绝创建/准备且公开接口不能接入时，才报告该具体场景 blocker，不预设“无 API”结论。原生图像/effort/raw 能力拒绝保留；不能伪造 baseline/能力或只通过 mock 宣称兼容。

## 6. 任务与实施波次

| 波次/责任 | 产出与依赖 | 主要证据 |
| --- | --- | --- |
| A：部署策略与投影 owner | `settings.ts` enum/解析、named 拒绝、admission capture 行为、`status.ts`/既有部署 UI 元数据；提供 immutable `rootModelPolicy` 及生效语义，内部请求决策由 C 实现 | defaults/sparse merge/非法值/clear、named 拒绝、desired/admitted 分离、同部署跨前端语义 |
| B：TUI 管理适配 owner | manifest/包资源、`tui-adapter.ts`/actions、命令定义与 `state.ts` 必需 authority 接点、简单设置；与 A 可并行，消费已约定字段 | 真实 attribution/lifecycle、晚服务/掉线无 raw fallback、即改即存、profile/maintenance/steer 授权 |
| C：请求与 recovery owner | 依赖 A 的字段契约，不依赖 B 的服务；独占第五节 routing/recovery/LLM 文件及共享内部决策，A 按该结果完成状态投影 | 无 TUI owner 的 native source fixture：primary/继承/初始和运行时回落、同一 capture/provider stream、失败 fences |
| D：集成 owner | 单一负责 `index.ts` 接线与共享测试分类；整合 A/B/C；更新 README、compatibility、settings-status、profiles、model-routing 的相关终态说明 | 统一受影响模块、默认 Desktop 与 configured 同部署 Web/TUI、隔离安装/加载和实际执行 |

子任务控制优先复用 TUI 原生界面和 DSMM role tools。若不能覆盖既有核心 Queue/Steer/interrupt，最小提取 `role-control-rpc.ts` 中非传输业务，Web 保留 browser scope，TUI 使用本地动作 scope，仍调用 native `listChildren/listDescendants/prompt/interruptByParent` 与 admission。后代观察不授予控制，one-shot 不变成 continuable，不另造 scheduler/队列。

## 7. 验收与验证限制

worker 使用现有 `test/suites.mjs` 分类和 Node runner，对实际改动跑轻量文件/模块；共享当前 build，不为每个任务重复全量检查。parent 统一集成与重检查受影响证据，不以 smoke 替代相关模块，也不默认运行 `test:diagnostic:all`。

- **装配/授权：** 首次与晚 TUI service、替换/移除、准入/grant 拒绝、重复注册、Desktop 缺 TUI；已识别 TUI 失活不回 raw。模型直接调用管理 handler 无同意不写；未知 dialog ID、取消/超时、Agent 同 ID 替换、revision/admission 变化均有安全结果。
- **部署策略：** 未配置默认为 native；Global configured 可被 native-profile 显式 native 覆盖，clear 后继承；错误 enum/类型和 named 字段拒绝；保存不改变旧 admission，新激活/显式重新 admission 捕获新值。模型调用参数不能改变策略；同部署 Web/TUI 使用相同 configured 行为，独立默认 Desktop 保持 native。
- **设置/会话：** 从真实 `/settings` 可达的选项操作验证即改即存、Host conflict retry、parse/format 的继承/clear/false/同默认 pin，不只调用内部 reset。profile Apply 保留整棵静止检查、历史/draft/attachments/child ceilings；mode 保留旧目标资格，maintenance 和 steer 前均检查，部分结果如实报告。
- **Configured 路由：** 不挂 TUI 服务的真实 source fixture 即可证明有效 primary 胜过不同 native baseline、无 primary 继承、无可解析模型失败、失效 baseline 下有效 primary 到达实际 capture；显式空 fallback、来源/参数投影/effort/raw 拒绝保持。module-off、普通 mode-off、standing role、未 admitted Agent 分别证明适用范围。TUI 管理服务单独卸载不改变有效路由；DSMM owner/admission 退休必须使旧请求/重试失效。
- **回落：** missing provider/UNKNOWN_MODEL 初选、确定无输出 429 与 startup route-unavailable、pending route 的 root 消费；actual request/header/provider route 一致。取消、认证/权限/quota、partial output、过期 attempt、budget 耗尽不回落；owner/admission/mode/role/generation 变化使旧重试失效，native model 事件不能抢配置优先级或重置预算。
- **兼容：** 保留 `native-root-model-authority.test.ts`、`native-model-selection.test.ts`、`client-native-model-intent.test.ts` 中默认 native 用户优先；新增显式 configured 模式覆盖，不全局改掉旧断言。配置同步使用 `settings.test.ts`、`deployment-config.test.ts`、`native-deployment-config.test.ts`、`profiles.test.ts` 与 session profile suites；路由复用 `model-routing.test.ts`、`role-routing.test.ts`、`native-role-routing.test.ts`、`runtime-recovery.test.ts`、`host-llm-adapter.test.ts` 的真实 seams。
- **业务/交付：** 复用 profile/runtime/store/RPC/session suites；角色实际可调用、子任务执行/结果/取消、停用/卸载清理。包验证真实 manifest、入口、exports 与资源可加载，不锁文档文本、版本号、环境或整文件快照。

统一检查（按实际变更增加 `permissions`；测试 fixture 类型检查与 build 合并安排）：

```powershell
pnpm run typecheck
pnpm run build
pnpm run test:module -- config-profiles routing-model native-runtime frontend-package
pnpm run test:integration -- native-runtime delivery
```

browser 共享边界受影响时加入 `frontend` integration。包交付使用 `pnpm pack --pack-destination <approved-output-directory>`，经授权在隔离 profile 用本次 artifact 走原生插件安装路径；不能以旧已发布包代替本次实现，不能为测试升级版本或安装到用户 Desktop/`dsh-tui` profile。

实机前提：明确操作授权、TUI 0.16.1/rc.2 Host、隔离 home/profile、PTY/交互驱动、适用的测试 provider。现有 Host anchor 为 `DSMM_TEST_DSH_ENTRY`，部分用 `DSMM_COLD_PROFILE_SDK_ANCHOR`；browser 另需 `DSMM_TEST_PLAYWRIGHT_ENTRY`，它们不证明真实 TUI 已可运行。安装完成码、toast、模拟 dialog 或编译成功不是端到端证据。

缺失的实机覆盖报告 `missing`/skip，不擅自安装补齐或冒称通过。native setup/system-prompt/早期 capture 的具体组合限制以真实 fixture 和实际安装证据报告，不影响显式部署策略的定义。完整目标包含管理写面、配置路由与回落，不以只读界面或模拟通过替代。只清理本任务资源；终止进程核对 PID 与启动身份，保留用户配置/history/credentials/未跟踪文件。commit、tag 和发布必须分别获得授权。
