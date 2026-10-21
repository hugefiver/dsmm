# DSMM 全局配置与权限界面交付计划

## 目标与交付边界

交付完整、简洁的 DSMM 配置页与权限编辑体验：以平铺分类页替代窄 drawer，保留现有可用配置与真实功能；消除权限面板周期性“正在读取”闪烁；明确部署设置、全局规则与所选主会话观测的区别；针对 workspace-write 下工作区内读写仍反复要求批准、outsideReads 行为与设置不一致的报告，取得可复现的权限链路证据并修复证实的缺陷。

遵循 `DESIGN.md` 的产品优先级和已定义的五分类、原生 tokens 与交互设计，不重新设计 UI。配置/UI 实施、保存和提交不以 SDK 实验、全局恢复撤权或其他插件迁移为前置条件。DSMM 活对象和自身入口仍须验证当前 owner 与真实权限；不能用体验优先绕过授权或 CAS。

DSH 的历史加载、读取、promotion、正常显式/声明式恢复和 provider 注销后的 durable 恢复保持原生规则。DSMM 受限角色恢复可能丢失限制，当前不保证自动继承有效 DSMM 资格或安全续跑；精细保证可延后，不因此阻断正常 DSH 恢复或本配置页。缺少宿主支持时明确实际覆盖，不新增生态协议或全任务 blocker。

workspace 审批问题尚缺真实 Host 入口及同现场 mode/tool/approval 证据，不能声称已复现或修复。界面交付与该问题的动态验证分别验收。

### 不扩展的范围

不重写 Host、sandbox、原生审批协议、身份/会话生命周期或 native admission；不引入新的权限服务、授权缓存、登录流程、持久化 owner 或数据库。不给本来不受支持的字段造 UI，不开启隐藏的 LSP，不改独立 Deepwork Profiles/Conversation 模型选择行为。配置保存不创建会话、不调用 provider、不应用 profile、不重启 Host。

## 适配边界与实现定位

以下路径相对 `dsmm/`，作为实现定位而非固定文件清单。

| 边界 | 实现定位与最终约束 |
| --- | --- |
| 原生配置入口 | `src/client/DeploymentPage.tsx`、`deployment-workspace.ts`、`deployment-modules.ts`；原生 Plugins 的 DSMM bundle 内容区，保留 Global/profile 选择，按下述五分类提供全宽内容。 |
| 配置字段及草稿 | `DeploymentFields.tsx`、`deployment-controller.ts`、`deployment-data.ts`、`NativeCommandEntries.tsx`；稀疏编辑、原生 form 身份核验、CAS、无效原始文本、Unset 和 accepted-but-refresh-required 均已存在，应保留行为。 |
| 配置权威 | `src/profile-rpc.ts` 的 `DsmmConfigHost` 通过当前 browser peer、本地 `127.0.0.1` Host、`settings.writable` 约束读写；不依赖主会话。profile 写入还需要精确匹配的 native `ConfigForms`、namespace、revision、base/user。 |
| 权限读取与编辑 | `src/client/permission-controller.ts` 与 `PermissionsPanel.tsx` 区分首载、显式刷新、后台 revalidation 与保存；后台请求本身不改变整区 busy 或阻止保存。 |
| 生命周期围栏 | `bindScope(sessionId, owner, scope)` 同时核验 owner 对象、sessionId 和 scope；connection generation、request sequence、abort、dispose 阻止旧响应发布。相同 sessionId 不代表相同 owner。 |
| 规则协议 | `src/permission-rules.ts`、`permission-rpc.ts`、`deployment-permission-rules.ts`；`describeRules`/`saveRules` 需要可信可写 Root 与 Host operator；写入使用 `expectedRevision`，源和 runtime revision 必须同步。 |
| 真正持久化范围 | `DeploymentPermissionRules.save()` 写 Global 层；同 Home 的运行 owner 参与同步。所选主会话是授权和观测上下文，不是规则的私有存储范围。profile 动态权限覆盖阻止 Root rules Save，不允许隐式回退。 |
| 原生 FS/审批 | `src/permission-fs.ts` 包装原生 FS 注册；`permission-native-rules.ts` 以可信注册、当前 FS、workspace 和规则进行决策，保留下游 deny/cancel。当前 allow 返回下游结果本身不足以证明 bug。 |
| 设计与浏览器入口 | `DESIGN.md` 定义原生 tokens、控件、草稿和无障碍约束；`test/client-deployment-core-browser.test.ts` 与 `scripts/profile-ui-harness-{server,browser}.mjs` 提供本地无登录组件验收基础，不替代真实 Host 权限现场。 |

## 最终界面设计

### 配置页结构

沿用 `DESIGN.md` 已定义的布局、导航、状态、原生 theme、字体、Button/Input 和语义 HTML 控件。不新增品牌风格、应用壳、字体或动画依赖。

页面保留原生 Plugins 入口，在自身内容区展示：

1. **配置范围**：DSMM Global / 当前 DSH profile overrides；简明标明来源、可编辑性及覆盖关系，不与独立命名 Deepwork Profiles 混称。
2. **平铺分类导航及全宽内容**：运行模块、模型路由、工作流与角色、安全权限、状态诊断。subagents 并入工作流下清楚的分组；现有 other 字段按含义归组，确无合适类别的保留“其他/高级”入口。不能为了减少 tab 而丢字段。
3. **当前配置范围保存区**：展示跨分类的待保存内容与明确的 Global/profile 保存动作；不提供跨范围 Save all。状态诊断页只读，不借用其他范围的脏草稿保存。

默认打开有用的分类，普通设置直接可见，复杂策略和诊断明细渐进展开。避免“每个字段再套一层卡片/折叠”的结构；技术键作为辅助信息而非唯一标题。保留 schema 实际支持的运行模块、modelParameters、roleRouting/runtimePolicy/runtimeRecovery、workflow/roles/skills/presets/locale/promptOrder、subagents 及其他可编辑字段。遵守已有按层差异，例如 deepwork 模块开关 Global-only；隐藏 LSP 仍原样保存在文档，不因保存被删或启用。

使用一条横向 tablist 与全宽内容区，在各宽度保持同一结构；实现 `role="tablist"`、`role="tab"`、`role="tabpanel"`、`aria-selected` 和关联关系。方向键/Home/End 仅移动焦点，Enter/Space 执行切换，以便 dirty 导航仍能明确处理。窄屏允许可发现的导航条滚动，内容保持全宽，不能造成页面级横向溢出。不同 tab 与 scope 的 draft 留在 contribution memory，保留原始无效文本与保存锁；离开时提供继续编辑、保留草稿离开、明确丢弃，禁止导航隐式保存或 rebase。普通保存不移动焦点，后台刷新不抢焦点。

### 安全权限页的两个独立事务区

**配置范围设置**显示所选 Global/profile 层及其保存按钮，包含部署护栏、权限开关、权限默认值和精确原生命令条目。没有主会话时该区仍可合法编辑；编辑权威继续来自 Host，不从“有连接”“有 Root”或本地 UI 状态推导权限。

**通过所选主会话管理全局规则**显示主会话/连接/同步状态、动态规则编辑器、独立保存和刷新动作。明确提示修改会持久化全局规则并影响使用该策略的运行上下文，不把它标成“仅当前会话权限”。无 Root、child、readonly、断连、unsynced、profile override 拒绝只影响该事务，不连带禁用合法配置编辑。profile 覆盖需用户在对应范围查看/修改/Unset 后刷新，不代为清除。

短的状态与操作说明留在主要内容；tool coverage、已观测注册与详细能力限制进入可展开详情。关键权限后果、错误和不可保存原因不能被藏入详情。缺少 capability 响应表示未知，不表示空覆盖或已认证安全。保留 Host 对只读投影和错误的脱敏；不把路径、凭据或原始异常带到公共诊断信息。

### 参数覆盖与编辑方式

以 `src/settings.ts`、`permission-settings.ts`、`permission-rules.ts` 及 Host 下发 schema 为权威，补齐的是这些已支持参数的可用编辑体验，不是新增权限模型。

| 参数 | 最终可用控件与限制 |
| --- | --- |
| `guards.scope` | 固定 enum：`deepwork-or-dsmm-agent` / `always` / `off`，说明应用范围。 |
| `guards.shellCommandSafety`、`gitWriteGuard` | 布尔/`ask`、`deny`、`off` 固定选项；不把关闭提示/护栏描述为批准 Git 或绕过 readonly。 |
| 其他现有 guards | `toolOutputTruncation.enabled/maxInlineBytes`、`planFormatValidation`、`questionLabelHelper.enabled/maxLabelChars`、`todoDisciplineHelper` 全保留，按安全与辅助功能分组，使用有单位和校验的控件。 |
| `permissionControl.enabled` | 配置层开关；明确 desired 与 startup mounted 的差异、另行重启及会话取消风险；不伪装成实时解除当前保护。 |
| `outsideReads` | `inherit/allow/ask/deny` 固定选择；解释相对 Host workspace 的外部读取、叠加规则与原生边界，不授予工作区外写入。 |
| `webSearch`、`webFetch` | 各自 `enabled` 与 `rule`，配置层与 Root rules 事务分别保存；不得暗示提供私网访问、搜索目的地过滤或 shell/socket 防火墙。 |
| `nativeCommands.enabled/entries` | 结构化列表，完整保留 id、mode、tool、executable、可选 subcommand、有序 args、Host workingDirectory、sandboxMode。精确匹配且无通配符；新增默认为 ask/workspace-write。保留已有 danger-full-access 的源值展示与现有限制，不新增或自动转换为更宽授权；若要求新增可编辑授权，先上报范围/安全决策。 |
| `permissionControl.rules` | 配置层提供清晰的记录列表和 schema 校验的导入/高级编辑，不要求普通使用者手工伪造 provenance。保存由现有 Host import 路径生成来源；不得将导入记录标作已验证批准。保留 source/revision/revoked 的实际语义。 |
| Root rules 编辑器 | `changes` 仅 outsideReads/webSearch/webFetch；`upsert/revoke` 管理 id/action/match。match 支持 outside-read path + exact/tree、shell executable + exact command + workingDirectory、webSearch/webFetch。action 仅 allow/ask/deny；不发送伪造 source/revision。 |

保留显式 false、同默认值 pin、空数组与 Unset 的不同含义；数组替换继承列表，不与继承值隐式合并。leaf Unset 只移除该层字段，whole-group Unset 明确移除该层组及对应 raw draft。Host 路径保持原文，浏览器不能按自身 OS 规范化。复杂 JSON 保留错误文本并锁定该事务保存，不以重绘或编辑邻项丢弃数据。

## 权限刷新与保存状态

### 稳定交互要求

- 将网络请求占用与可见 loading 分离。首载/当前权威尚未建立可显示稳定 loading；显式刷新和 retry 有用户可感知反馈；已有可信快照的自动 revalidation 不反复显示“正在读取”、不切换整区 `aria-busy`、不播报 live region。
- 后台检查保留现有 rules、base、draft、展开状态、输入焦点与正常编辑/保存能力；不能仅因后台请求 pending 禁用保存。保存开始时取消/失效化未完成的后台读，并依赖现有 CAS 与 Host 最终核验；不能让随后到达的读覆盖保存结果。避免重叠读取和旧请求重新安排无效 timer。
- 相同策略的后台结果不得重置 draft 或产生可见跳动。clean 状态可接受新可信策略；dirty 状态保持原 CAS base，revision 改变立即标记冲突并禁止保存，不能无声合并。
- 成功的读取不是永久可写授权。继续后台检查 owner、readonly、连接、runtime 同步等安全状态；一旦观察到拒绝/失效，立即禁用对应 mutation，保留用户草稿并显式标记旧数据不再代表当前可信状态。失效检查不能被“静默刷新”隐藏，也不能只提高轮询间隔掩盖问题。
- 保留精确 owner 对象 + sessionId + scope + connection generation 的 fence，以及 request sequence/abort/dispose。owner 被换但 sessionId 不变仍使旧响应和旧保存失效。可保留原草稿供恢复，但不能自动把旧 base 当作新 owner 权威。
- 轮询仅在现有 watch 生命周期内运行，卸载清理 watcher/timer；无效 Root 不发后台请求。不要为减少重绘改变注册身份，或用 sessionId 替代 owner。

### 冲突、失败与恢复

每个事务独立呈现 pending、saved、conflict、unavailable/offline、unsynced。后台同一错误不持续触发重复 alert；用户操作失败和真正状态变化有可读、可访问提示。

`expectedRevision` 为不可跳过的协议字段。冲突保留 draft，提供非破坏性的刷新、查看最新状态，以及明确丢弃并重新加载的安全路径；用户在最新 baseline 上重新编辑并提交。不自动复制旧 draft 到新 revision，不提供“强制覆盖”或新增合并器。

accepted mutation 与后续 reread 是两个结果：已接受但读取失败仍显示已保存/需刷新，并防止 replay；transport 或协议错误不等于证明未保存，刷新确认真实状态前不自动重试写入。规则已落盘但 runtime unsynced 不能显示“已全部生效”。保留当前事务的同步和安全拒绝覆盖。

## 可证实的 workspace / outsideReads 权限修复

“workspace-write 下工作区内读写全部需批准”是待复现的问题，不作为新增“所有读写必须批准”需求，也不直接推导成“所有内部调用必定免审批”。最终行为必须遵循用户选择的实际 sandbox mode、approval policy、readonly/role ceiling 与独立 deny。DSMM allow 不能越过 native ask/deny。

### 最小动态证据路径（权限业务修改之前）

使用已有 `test/permission-managed-tools.test.ts` 的隔离 Core/native FS fixture 及相关 native 测试 seam，先以实际注册的 `read/write/edit/glob/grep` 调用观察结果；不得仅 mock 一个 allow/ask 返回值就声称修复真实链路。fixture 已有任务独占 workspace/outside、ApprovalService、真实 native 工具 bodies、sandboxPolicy 和可计数 FS 能力。

证据需连接这些事实：

1. 当前 session/Root 的实际 workspace、sandbox mode 与 approval policy；注册的工具定义及其绑定 FS，而非仅 UI 中保存的 desired 值。
2. DSMM rule 的判断、原生下游 pre-execute/approval 请求的来源、最终 execute 结果与实际读写副作用。请求批准、批准结果、工具执行成功是不同观察。
3. workspace 内 read/write/edit 和外部 read 的批准次数/结果，outsideReads 为 inherit/allow/ask/deny 时的行为；外部 write/edit 仍受 native workspace sandbox 控制。用新鲜调用验证，不能靠以前的一次批准证明持续许可。
4. 有效的原生 deny、readonly/role ceiling 和明确拒绝审批仍阻止实际副作用；DSMM ask 与原生 ask 合成一次原生审批，不制造重复 prompt。

该 fixture 的 OwnedFs 是公开能力替身，能证明 native tool/body 与 DSMM 的组合，不能单独证明真实 Host 入口、executor、同现场 mode/tool/approval 或最终 inode 隔离。若问题依赖真实本地 FS，可在已安装、已允许的隔离 native FS surface 上补充最小验证；无受支持 seam、依赖缺失或平台拒绝即报告精确缺口，不安装、不登录、不绕过、不制造 pass。只有同一问题在真实入口复现并经修复后复测，才能宣称该 Host 问题已修复。

### 修复边界

- 先区分 DSMM 配置未生效、错误 workspace/注册绑定、native approval 策略，以及原生 sandbox 自身限制；不能预先把 `return downstream` 认定为错误。
- 仅修改证实违反既有选定权限模式的 DSMM wiring/消费行为。保留下游 deny/cancel、原生 sandbox ceiling、readonly、Git 护栏及当前调用身份检查。不得将 DSMM allow 提前短路成无条件 execute。
- outsideReads 的路径判断继续依赖可信执行 FS 的 resolve/contains 与 co-location 证据；未知 backend 不能被当作 inside 或满足 path-specific allow。保留链接/路径安全覆盖，不新增“完整文件系统隔离”的承诺。
- 普通 FS 与 shell、搜索、web 的权限不相互冒充；精确原生命令规则不提供通用工作区读写放行。未覆盖的 provider auth/MCP、shell sockets、web search destinations 等能力继续明确未知或不支持。
- 若必须修改 Host 公共协议、依赖版本或扩大权限才可能达成，停止该业务修复并上报，不把 UI 成功当作权限问题已完成。其余已授权 UI 工作仍可独立交付，明确权限缺口；可采用保留现有授权的粗粒度支持，或延后依赖宿主的精细能力，不强造框架补齐保证。

## 实施所有权与波次

按成果组织实施；配置页和状态交互不依赖恢复准入实验。权限业务修改只依赖其自身可复现证据和授权边界。

### 波次一：适配既定设计并确认权限事实

**frontend 所有权**：按 `DESIGN.md` 实现分类页、两事务权限页、loading/conflict/offline 状态与键盘路径，明确所有 supported 字段入口，不重新设计 UI 或给未验证的业务权限下结论。

**backend 所有权**：按上述隔离 seam 获取 workspace/outsideReads 最小动态证据，区分 DSMM 与 native 下游，并明确真实 Host 尚缺的证据及不扩权的修复边界。该工作不扩展到 SDK admission 或恢复协议。

**结果证据**：可落实的界面结构与字段映射；真实工具调用/审批/副作用之间的可解释关联。结论和运行证据留在会话，不新增工作区报告。

### 波次二：完整配置页与稳定权限状态

frontend 实现平铺导航、按 scope 保存与字段分组、完整权限编辑器、可访问状态反馈；重点区域为 `DeploymentPage.tsx`、`DeploymentFields.tsx`、`deployment-modules.ts`、`deployment-workspace.ts`、`NativeCommandEntries.tsx`、`PermissionsPanel.tsx`、client controller/locales/styles。

权限 controller 的首载/后台刷新分离由同一 frontend owner 完成，避免与 UI 状态契约分散修改；Host RPC/CAS 由 backend owner 保持，不借 UI 重写改变协议。新增结构化控件复用已有 sparse draft 和校验语义，不另建隐藏配置副本或 localStorage。

**结果证据**：全量受支持字段可达，Global 无 Root 可编辑但 Host readonly 仍拒绝；profile form 不匹配不写；跨 tab/scope 和原生导航保留草稿；自动刷新中连续输入与保存不闪动、不丢焦点，撤权与冲突仍及时显示并阻止写入。

### 波次三：证实缺陷的最小权限修复与整合

backend 只实施波次一证实的权限消费/绑定缺陷，主要定位 `permission-native-rules.ts`、`permission-controller.ts`、managed FS adapter 与对应测试；不默认这些文件都需要改。frontend 根据实际能力和错误语义调整说明/状态，不承诺不存在的 enforcement。

可与波次二无共享文件部分并行，但任何 backend 行为变更必须先有安全证据。若配置页与 Root rules 同时修改全局权限，两端使用现有同源 CAS 与同步路径，冲突需要显式处理；不能通过分拆保存按钮假设没有并发。

**结果证据**：同一个隔离 native 调用能复现并证明缺陷已修；合法 workspace 操作符合选定模式，outsideReads 跟随真实源与优先级，denied 操作没有副作用；范围没有扩大，公共 RPC 未改变。

### 波次四：交互与集成验收

主协调合并必要检查，复用仍覆盖当前行为的有效证据；frontend/backend 各跑对应轻量局部检查，不每个小任务重复全套。

## 验证要求

### 有效回归覆盖

- `test/client-permissions.test.ts`：保留现有 strict Root RPC、source CAS、child/readonly/disconnect、accepted-but-unsynced、旧 connection 响应围栏；覆盖首载与自动 revalidation、保存与未完成读取竞争、相同 sessionId 换 owner 的确定性行为。
- `test/client-permission-config.test.ts`、`client-permission-capabilities.test.ts`：稀疏双层保存、精确命令参数、profile override 拒绝、无效 args、source 不确定、能力未知与断连；不能通过删弱安全/协议断言使测试通过。
- `test/client-deployment*.test.ts`、`deployment-permission-rules.test.ts`、`configuration-commit.test.ts`：保留 sparse values/Unset、原始草稿、CAS、身份更换、accepted/unconfirmed save、同源权限同步等行为。将只针对 drawer 结构的测试按新的导航要求更新；已失效、重复、仅锁内部表示的专用测试直接删除，不增加“旧 drawer 不存在”测试。
- 权限行为使用 `permission-managed-tools.test.ts` 与具体受影响的 native rule/managed-shell/command 测试；保留有效路径、批准、readonly、撤权、CAS 与协议拒绝，不能为了绕开未知 Host 缺陷降低安全预期。
- 测试断言可写性、RPC payload、持久化值、实际副作用、身份围栏、焦点与可访问状态，不锁说明文案、文档、版本、环境、元数据、文件全文或内部实现布局。

### 真实浏览器验收

复用 `test/client-deployment-core-browser.test.ts` 的原生 React/primitives/theme、Gateway/SettingsForms 及任务独占 bridge，扩展为实际配置页与权限 controller 的组合；基于 `scripts/profile-ui-harness-server.mjs` 的本地无登录服务。当前现成测试主要覆盖 DeploymentPage，不应声称已覆盖 PermissionsPanel 的后台刷新/Root RPC；该覆盖必须补齐。

使用已可用的 `DSMM_TEST_DSH_ENTRY`、`DSMM_TEST_PLAYWRIGHT_ENTRY` 和可选浏览器 executable 入口；缺失即报告浏览器覆盖不可用，不通过 npx 或其他方式安装。每次使用任务独占 empty context/profile，不读取用户 cookies/storage、不登录任何账户、不连接 live 用户应用；仅允许本次本地 harness 来源。原生认证生产 E2E 不在该 harness 的证明范围内。

在 **375 / 768 / 1280px** 留下截图并实际交互，至少覆盖：

- 首载延迟、多个后台刷新周期、后台刷新期间连续输入/焦点/保存；显式刷新、错误重试、稳定 status 与 `aria-busy`。
- 新 revision 冲突、保留 draft、明确丢弃并重载；offline/reconnect、readonly、unsynced、相同 sessionId owner 更换后的迟到响应。
- 无主会话仍能编辑合法 Global 配置，Root rules 正确不可用；profile 覆盖/原生 form 不可写时不触发 fallback Global 写。
- 分类与范围切换、无效数字/JSON/命令参数、空列表、Unset；中文与英文、长字段、200% zoom、明暗主题及 reduced-motion。
- 键盘 tab 导航、方向键/激活、字段标签/错误关联、确认离开和焦点返回；按钮 hover/focus/disabled/loading，不隐藏内容或以缩小字体换取布局通过。

截图与 trace 使用任务临时位置，不新增工作区证据报告。组件 harness 的布局结果不宣称证明原生完整 Settings 壳的响应式表现。清理仅关闭本任务 context/server 和精确拥有的临时资源；需终止进程时核验 PID 与启动身份。

### 集成检查与交付结论

实施结束由主协调执行必要的 DSMM typecheck/build 和相关非 LSP 测试；使用 `dsmm/package.json` 的实际脚本，并注意 `pnpm test` 运行 `.test.ts`，不能据此宣称独立 `.test.mjs` 或带条件跳过的浏览器测试已通过。受影响的 `.mjs` 验证使用已有允许入口；复用仍覆盖当前行为的有效证据，不重复无关 root 检查，LSP 保持跳过。

交付说明必须分别列出界面和 loading 行为、配置持久化/作用域、权限动态证据，以及未验证的 native/浏览器边界。资源交付以真实组件加载、控件交互、RPC 与重新读取持久化值证明，不以描述性字符串或文件 hash 证明。计划文件完成、编译通过、测试 skip 或成功日志均不能代替实际功能验收。缺少真实 Host 权限证据或精细恢复支持，不得写成已修复，也不成为普通配置/UI 交付的额外门禁。
