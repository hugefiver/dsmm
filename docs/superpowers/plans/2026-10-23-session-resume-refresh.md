# 历史会话按当前 DSMM 配置重新装配

## 最终交付

合法历史根会话和原生可恢复 subagent 在 Host 再次启动、原生恢复或重新激活为新 Agent 时，使用当前安装的 DSMM 提示词/技能/角色定义，以及当前有效配置，重新建立模型路由、工具和策略。保留原 Session ID、消息历史、任务内容、真实 DSH 父子身份；不要求历史中存在旧 DSMM runtime capture，也不冻结旧 profile revision、路由锁或配置快照。

重新装配在本次原生 activation 发布完成前进行。一个已接纳的 live Agent 在其 residency 内保持一致，不因磁盘配置变化、普通新一轮消息或 retry 中途重装；释放后原生重新激活才取得新配置。配置禁用的角色/工具不恢复；不恢复旧单次提权、会话规则批准、失败重试预算或旧对象执行权。

范围仅为独立 `dsmm` 仓库，保持 `@dsmm/dsmm` 0.3.12、DSH 0.2.1-rc.2 和现有原生 ownership、sandbox、readonly、approval、RPC 边界。保护 Profile 已提交成果 `ea28471` 及未提交 RoleToolView、相关测试/文档。不访问或修改用户 Desktop/profiles/history，不安装、不联网同步、不执行 Git 写入或发布，不使用父仓库构建输入。不引入新认证凭证、通用恢复框架或全后端重写。

**宿主硬边界：仅修改已有 DSMM 实现并使用 DSH 公开扩展接口。不替换 DSH 组件、不 patch DSH 源码或 node_modules、不改依赖或 readonly Agent options、不反射 manager、不绕过能力校验，也不伪造模型查询结果来模拟缺失接口。现有 DSMM 自有 `DsmmNativeLlmRuntime`/owner 的内部修正属于本范围，但不得借此新建替代 DSH 组件。宿主缺口按现状披露，不以请求宿主补丁授权作为解决方向或其余 DSMM 修复的前置。**

## 原生入口及可用实现接缝

以下路径均来自项目内已安装依赖：

- **根恢复**：`dsh-api-session-controller/lib/types/index.js` 的 `resolveAgent` 或历史观察 `promote` → `resolveObservedAgent`；`lib/types/agent.js:371–435` 中 `resumeObserved` 解析当前 preset，`composeAgent` 安装 model selection 并挂载 composition，然后调用 `agents.resume`。
- **child 冷恢复**：`dsh-subagent/lib/types/manager.js:1171–1222` 的 `coldResume` 观察原生持久化，校验 exact parent/lineage，从 child **own suffix** 折叠 descriptor，要求 `mode === "continuable"`，再调用 `materialize`。此路径**不调用 provider.prepareContinuable**，不能只修改 `src/role-providers.ts` 来修复。
- **child 发布前 composition**：同文件 `733–804`，`materializeTracked` 通过 `agents.resume({ parentAgent, setup, signal })` 恢复；setup 调用 `applyChildComposition`，没有独立 preset 时跟随父当前 composition，有独立 preset 时由当前 registry 解析。原生 persona/toolFilter、sandbox/approval 历史边界仍归 DSH 所有。
- **共同事务边界**：`dsh-agent-loop/lib/index.js:1915–2012` 获取当前 persistence writer，执行 setup 后将精确 Session/Agent 插入 registry，再串行发布 `agent/created`；失败由 `initializeAgent` 取消、dispose scope、释放 writer。DSMM 在此回调中准备和安装，成功后才发布自己的 admission。
- **现有 DSMM 接缝**：`src/native-admission.ts` 的 `created/assert/guardExecution`，`src/profile-runtime.ts` 的配置准备/publication，`src/index.ts:145–161` 安装回调，`role-policy.ts` 的 child 绑定，`role-invocation.ts`/`model-routing.ts`/`role-routing.ts` 的路由，`role-subagents.ts` 的 Agent-scoped 工具和身份 prompt。

`subagent/start` 发生在原生 Agent 创建之后，不适合作为唯一恢复前置授权点。cold child 的原有父 catalog 可在 `agent/created` 中读取；manager 的 resident activation 则在 `agents.resume` 返回后才建立（`manager.js:787–818`）。因此 admission 不查询、不等待尚不存在的 resident activation，也不要求 `subagent/start` 已发出。利用创建时已建立的 exact registry ownership、own descriptor 与父 catalog，不另建 activation manager，也不以反射访问 DSH 私有 manager 或 monkey-patch 全局 resume 方法。

## 身份、角色和权限判据

### 共同当前 owner 判据

验证当前 DSMM owner ready/未退休；当前 Host 与 Agent 使用同一真实 registry 服务；`agents.get(id) === agent`、`sessions.get(id) === agent.session`，Agent/Session/header ID 一致，`scopeOf(agent.ctx) === agent`。当前 preset registry 必须识别实际 composition，必要服务必须来自本次有效 scope。捕获并在异步准备/安装后校验这些对象、scope parent、provider/工具服务身份和取消信号。

`source === "resume"` 只选择生命周期分支，旧 ID、profile epoch、preset/role 字符串和模型文本都不是授权。可信边界是当前 Host registry/factory、原生结构化持久化协议和当前部署，非任意拥有 Host 插件执行权/存储改写权者的认证系统。

### 根

普通 Host 根入口恢复且 `agents.roots()` 包含该对象，没有实际 runtime parent，且没有该会话自身的 subagent 身份，进入 root refresh。原生合法用户 fork/seed root 不能仅因有 `parentSession` 或 inherited prefix 被拒绝；区分持久化历史 lineage 与运行时子 ownership，检查 own suffix 而非祖先复制的 descriptor。`origin: subagent` 或 own continuable descriptor 的孤儿/被提升 child 不得通过无 runtime parent 冒充 root；须走原生父子恢复入口。

### Continuable child

1. 当前 registry 中有唯一 exact live parent，`isOwnedBy(child.id, parent)` 为真，header 的 parentSession 与该 parent 匹配；父当前 DSMM admission 已完成。父 catalog 中有该直接 child 的原生 continuable 记录；用现有 `subagents.listChildren`/原生 projection 读取，不从 assistant/tool result 文本拼接关系。
2. 用 `foldSubagentDescriptor(childOwnedSessionEvents(child.session))` 读取本 child 的原生 descriptor，验证 continuable mode 和匹配的 lineage。继承前缀中祖先的 descriptor 不提供 child 角色。
3. 对明确 DSMM provider 身份，用 `roleFromProviderName` 映射角色，再验证当前注册的 DSMM provider owner、当前角色是否启用以及父可委派范围。持久化 provider 是原生 child 身份输入，不自动恢复旧权限；最终权限重新计算。模型传入的 role/parent 字段、label、persona 或请求 header 的 model 均不能替代此判断。
4. 缺少旧 DSMM capture 不阻止上述合法 child 恢复。旧版 host-only sidecar 可提供与同一原生 child/parent 绑定的角色、profile ID 或 level 意图，但不是恢复旧 runtimePolicy/authorityCeiling 的凭证。对于原生 descriptor 未标识 DSMM 角色的旧会话，只有可验证的原生 own 独立角色选择或已有 host-only 身份记录才参与映射；证据冲突须明确报错，不猜角色。真正普通 native child 不强行变成 DSMM role child。
5. 新 child capture 绑定当前 exact parent/child、当前 admission、重新解析的 invocation 和当前有效过滤上限。保留原生 depth floor，重新应用当前 depth/角色可委派限制、父当前权限、原生 sandbox/approval/toolFilter 以及当前角色 readonly 限制。不恢复旧 DSMM 过滤快照，也不绕过 DSH 已施加的原生限制。

continuation 的 composition 分两种校验：继承 composition 要匹配父当前原生 scope generation；原生已验证的 own 独立 preset 则校验 child 自己的当前 registry 挂载、scope 和服务身份，不要求 preset 名或 scope parent 等于父。`role-policy.ts:bindChild/assertModuleAdmission` 中父子 preset 相等只用于现有新建 pending 的共享 composition 契约；为 continuation 保存其已验证 composition 种类及精确身份，后续 assert 按该种类校验。独立 preset 不能单独授予角色，也不能绕过父可委派范围、原生 toolFilter 或 readonly ceiling。

如果父仍是旧 residency，child 可以读取最新配置，但不能获得父当前实际可授予权限以外的能力；扩大父能力必须等父合法重新激活。祖先恢复按原生依赖顺序进行，不为 child 自动伪造缺席父。深层 child 只由已恢复的直接父激活。

原生 settled one-shot、external 或不支持 continuation 的身份继续由 DSH 拒绝；不伪造 continuable descriptor、不调用低层 resume 绕开原生不可复活协议。新进程中的新对象可以重新获权；同 ID 旧对象、旧 closure 和已退休 owner 永远不能复活。

## 最新有效配置：选择身份与内容分开

### Root 的选择语义

- 会话显式选定 named profile：保留其 **profile ID**，读取该 profile 当前合法正文，应用当前 deployment baseline；不以 `.revisions/<旧 revision>.jsonc` 为运行配置。
- 会话显式选择 deployment-baseline：使用当前 deployment baseline，不改为 global named default。
- 没有会话显式选择：使用**当前 global selection 的方案 ID及该方案最新正文**；若 global 选择 baseline，则用当前 baseline。不能由历史请求中的模型或旧 label 推测一个失踪的会话选择。
- 选定 ID 的最新文件不存在、不可读、非法或被不安全路径替换时，报告具体配置错误，不换任意默认，也不退回旧 snapshot。旧 immutable revision 已缺失但选择 ID 和当前正文有效，不能仅因此拒绝 refresh。

### Child 的选择语义

- 存在可信的 child 自身明确选择时，沿用其 profile ID/baseline 意图、读取最新内容；旧 host-only `profilePin` 只提取选择 ID，不沿用 revision 或 runtimePolicyCapture。
- 当前原生 DSMM child 没有单独选择记录时，沿用直接父的**选择来源**：父 session override 的同一 ID、父 baseline、或当前 global-default；在 child 本次 activation 解析最新内容，不复制父旧 settings 快照。若父处于 live residency，权限仍受父当前实际能力上限约束。
- profile、module、角色和 mode 分别处理：历史显式 `deepwork/mode` 是用户意图，当前 module-off 仍压过 mode-on；普通 root mode-off 不被默认开启。合法 role child 在没有自身显式 off 时按角色 activation 使用当前角色 prompt/配置；不能因为进程内 invocation 尚未重建而当作普通 child。

### 实现接口

将现有 store 的“读取选择身份”与“读取配置正文”分开：指针读取仅验证目录、session ID、指针版本/结构、路径安全和并发身份，返回 ID/baseline/选择 revision；当前正文由 `read(id)` 读取。旧 revision 是历史元数据，不是读取选择身份的依赖。具体接线顺序如下：

1. `ProfileStore.selection/sessionSelection` 提取共用的 pointer-only reader；`DsmmProfileRuntime.initialize` 的 `loadSelection` 链改用“global pointer → 当前 named 正文 → prepare”，避免 Host 在 root admission 之前就因旧 snapshot 不能解析而启动失败。root/child refresh 和只读 describe/getSession 使用相同选择身份语义。
2. `selectSession` 的初始 CAS/fence、`select` 的初始 CAS、`assertSelectionRevision` 仅比较 pointer observation，不调用会解释旧 snapshot 的 `selection/sessionSelection`。新选项正文仍须完整校验、事务安装后提交，真实外部指针变化仍冲突；不能为允许 refresh 而移除 CAS。
3. `readChildAdmission` 的恢复用途增加 metadata-only 路径：复用现有安全读取、envelope 完整性和 child/parent 身份校验，按支持的版本验证所需 role/profile ID/level 元数据；不调用 `parseChildAdmissionCapture` 来强制解释已退役的 runtimePolicyCapture、旧路由或权限快照。需要完整 capture 的其他既有契约保持独立，不能让它成为身份读取的隐含前置。
4. 有效原生 DSMM descriptor 无 sidecar 仍能恢复；选择元数据明确存在但不安全/身份冲突时应报告具体错误。旧运行字段不再受当前 schema 支持不等同于身份非法，不能因此将合法旧角色剥夺为 native。

复用 `prepare`/`resolveProfileSettings` 的有效设置构造和 startup mount 上限，分别提供 root/child activation candidate，产生新进程内 epoch。准备期间选择 ID、正文或 deployment 改变时失败为冲突，避免混合两份配置；无需文件内容/hash 锁或新持久化凭证。

`getSession`/session snapshot 必须分开表示持久化选择指针与本次实际采用的最新内容 revision；不能再要求新 admission epoch/revision 等于旧磁盘 snapshot 才认可恢复。可在现有 Agent-bound admission 中记录本次读取的选择 observation，沿用现有 CAS 字段，避免把合法刷新误报为外部冲突。保留 blank session 显式选择操作的事务行为，不自动重写或迁移用户 sidecar。后续磁盘编辑不会修改已发表的 live admission。

## 路由、提示词和工具重新装配

- 使用当前包的角色定义、prompt/skill 资源和有效设置，通过现有安装回调建立新 Agent-scoped 注册；不复用旧 prompt 字符串、旧 `ChildRuntimePolicyCapture`、旧 tool topology 或旧 provider 对象。
- 从已确认角色和本次有效 settings 调用 `resolveRoleInvocation`；旧 descriptor 的 `agentProvider/agentModel` 是 DSH 重建默认值，不应作为新的 `nativeOptions` 强行覆盖当前 DSMM 路由。旧 fallback/route-policy marker/attempt counters 不决定本次初始 route，新的 epoch/policy identity隔离历史运行状态。
- 可信记录中明确的 level 选择作为意图套用当前 level 配置；若旧 descriptor 未保存 level，不从 model 名/旧路由反推，使用当前 normal 配置。明确 level 已被当前配置移除时报告不可用，不偷偷恢复旧 route。历史一次调用的 route override 不重新当作现行配置。
- 原生明确的用户 `model/selection` 按现有用户选择优先级保留；它与 descriptor 重建默认值及旧 DSMM route lock 不同。本次有效 DSMM role primary/fallback 更新必须进入实际请求；普通 root 无 DSMM route 时使用当前原生选择/默认，不能把旧 request/header 推断为当前配置。检查 `model-routing.ts` 的 root 分支和 `host-llm.ts` 的 effort-source 分类，不能仅刷新展示字段。
- 当前 readonly、delegation targets、tool schema、role prompt 与实际调用必须来自同一新 capture。复用 `bindChild` 的安全校验，但将“新调用 pending”与“原生已验证 continuation”输入分开；不得为 continuation 制造虚假的 ToolExecution token/pending call。为当前父可见工具上限提供内部只读接缝，保留 native own-layer guard，不取消限制以让 schema 看起来完整。
- role/module 当前禁用时，拒绝该角色的激活并保留可读历史/明确不可用状态，不能静默执行无角色的宽权限 native child。普通非角色 root 在 module-off 时仍能按原生功能工作。

### 最终路由必须先于 LLM capture

DSMM 的请求所有者是 `host-llm.ts:bindRequestOwner`：它先 `await next()`，再 preflight，最后将返回的 config 对象写入 `calls/admitted/pending`；`prepareCall` 要求精确 proposal identity。`model-routing.ts:29–90` 与 `runtime-recovery.ts:182–219` 的路由变换不能在该 capture 返回之后另造 proposal。只在每次安装后重新 prepend binder 会依赖跨 scope 注册顺序，不能作为最终设计。

在已有 DSMM 接缝内按以下顺序实现：

1. 从 `registerModelRouting` 提取其现有请求路由 body 为本 Agent 的异步 prepare 函数，保留同一个 scope 的 model-selection observation、路由锁和 cleanup。`registerRuntimeRecovery` 同样提供其 request-phase recovery 变换，保留既有 request-error/stream/turn 监听和撤权逻辑。用现有模块中的 exact-Agent、scope-owned 绑定保存函数，不建通用事件总线或替代 runtime。
2. 对已由 `DsmmNativeLlmRuntime` 拥有的 Agent，这两个 DSMM 模块不再注册会在 `await next()` 后修改 proposal 的 `agent/request` hook。`src/index.ts` 的 Agent 安装负责绑定并清理该 Agent 的 prepare 函数。原生请求 waterfall 和其他只检查/透传的 DSMM guards 保留；现有明确 stock-only 集成若保留事件路径，也调用同一准备逻辑且只调用一次，不能用 stock 路径冒充产品验收。
3. `createDsmmRoleLlmOwner.preflight(frame, proposal)` 先用现有 `dsmmCoreLlmOwner.admit(frame)` 验证本次 exact admission/权限 owner，再调用上述 Agent prepare：先消费符合本次 frame/policy 的 recovery 变换，再执行 role/model selection、当前 route/fallback 决策，返回最终路由。重用现有 `takeAdmittedRecoveryRoute` 顺序，不重放历史 fallback。真正非 DSMM native 分支保持既有行为；已接纳角色缺少 routing 绑定是初始化错误，不能静默使用旧模型。
4. owner 对**最终路由**计算 effort source、model parameter projection，并执行当前模型解析/stock 或 generation 分支；每个 await 后复查 admission 和 signal。然后一次性返回 `{ admission, config, ... }`。不得在角色已选新模型前尝试解析旧 descriptor 模型，也不得把已返回的旧 preflight 结果换个对象继续用。
5. `bindRequestOwner` 此后才 snapshot 最终 config 并写入 `calls/admitted/pending`；原生 AgentLoop 将这一精确对象传给现有 `prepareCall`。capture 后的 DSMM hook 只透传，禁止再 `applyModelRoute`、clone 或修改参数。保持一次消费、同 signal、owner revocation 和 `INVALID_PREPARED_CALL` 检查，不放宽对象校验来掩盖顺序错误。

这一路径涉及 `model-routing.ts`、`runtime-recovery.ts`、`role-llm-runtime.ts`、`index.ts` 及必要的 `host-llm.ts` 内部接线；不改变 DSH waterfall、AgentLoop、模型 catalog 或能力检查。`llm-runtime.ts` 继续使用现有 `DsmmNativeLlmRuntime` 与 `createDsmmRoleLlmOwner`，不替换部署组件。

## Host 控制入口与已知限制

`src/role-control-rpc.ts` 的 `child` 和 `direct` 当前依赖 resident live child，合法 cold child 无法经 browser prompt 进入原生恢复。调整现有 prompt 路径：保留 exact browser peer、root parent admission、直接子 catalog、continuable mode、图片/content 校验及调用时 owner/cancellation fence；对合法 cold direct child 调用现有 `subagents.prompt`，让原生 manager 恢复并在 created 中完成相同 admission。describe/list 只读、不唤醒；冷 child 的 prompt availability 表示可尝试原生恢复，而非承诺模型已执行。interrupt 不唤醒 child，遵循原生 absent-target 行为。descendant 只读控制、foreign parent 拒绝等范围不放宽，不新增 RPC 方法。

明确宿主限制，不能用绕过来隐藏：

1. DSH coldResume 在 created 前使用 descriptor 的历史 agentOptions；`manager.js:1274–1284` 的图片预检在请求 routing 之前直接读取 `agent.options`。当旧模型无图片能力、已下线或无法解析，而新配置模型支持图片时，native continuation 仍可能先行拒绝。保留真实模型查询和该拒绝，不改 options、不替换组件、不 patch 宿主、不伪造 catalog 能力。文本 continuation 仍须经 DSMM 正确路由/capture 完成；图片限制不是其他恢复修复的前置阻塞，也不能宣称此图片场景已完整修复。若有对应测试，断言真实限制及清理结果，不期待虚假的图片成功。
2. DSH `applyChildComposition` 会重放原生 descriptor persona/toolFilter；这些不是可任意删除的 DSMM runtime snapshot。当前 DSMM role tool 不写 persona override，现行 continuation 可通过新 role prompt 装配。旧格式若把整段 DSMM 正文存进原生 persona，仅在可验证格式且已有公开接口允许管理 DSMM 自有注册时处理；DSH 自有注册无法通过这些接口更新时，披露该具体历史格式限制。独立旧 preset 当前无法解析同样明确报错，不新增替代 DSH 组件、不修改原生实现、不堆叠冲突 prompt、不移除原生 filter。
3. 只有消息文本/模型产出的 role 字符串，没有原生/host-owned 角色身份的历史，无法可靠恢复一个特定角色。缺的是身份而非 runtime capture；不得将所有“缺 capture”历史概括为不支持。合法 native DSMM descriptor 缺 capture 的场景必须成功。

## 原子安装、取消与撤权

在可信 root/child 开始准备时建立 exact-object lifecycle，保证准备失败的 retained reference 不降级为 `unknownAgent → native`。等待配置读取、模型解析、工具注册前后校验当前 owner、父 admission、registry、session、composition、provider 与 abort signal。只有完整安装成功后执行 `profiles.publish` 和 live binding。

失败由原生 factory rollback 与现有 Agent-scoped disposers 清理本次工具、prompt、guard、watcher、候选 capture，并释放 writer；不留下可执行半安装或污染共享 preset。父退休/被替换、child 取消或 DSMM owner replacement 使本次候选失效。成功后的同 ID 新对象不赋权旧对象；不按 ID 把旧调用转到新对象。

`CommandApprovals` 的 exact Agent/Session/tool/realm/owner 内存边界保持；新 activation 不加载旧批准。原生 sandbox 和 delegated approval-never 不被新 DSMM 配置取消。已运行的 Agent 只在现有权限系统明确要求的撤权边界停止，不将普通配置保存变成中途热切换。

## 实施波次与交付证据

### 一：统一 activation 配置解析

修改 `profile-store.ts`、`profile-runtime.ts`，必要时局部调整 `profile-types.ts`/`settings.ts` 的内部 observation 表达；先打通 pointer-only 的 Host startup、CAS 和 child metadata 读取，再形成按选择 ID 读取最新正文的 root/child candidate。保留存储安全与显式选择 CAS。用实际临时 store 验证 global/session 旧 revision 缺失、旧 snapshot 不再符合当前 schema 时 Host 仍能启动和完成合法选择；named 最新正文非法仍拒绝，真实 CAS 冲突仍拒绝，live admission 不随保存变化。

### 二：接通根和子原生恢复

先完成上述 DSMM request preparation → owner preflight → final capture 接线，用真实 DSMM LLM runtime 的小型请求检查证明新路由可以到达 adapter，再将 `native-admission.ts` 的 root/child candidate 接入完整安装。局部协同 `role-policy.ts`、`role-invocation.ts`、`role-routing.ts`、`session-scope.ts`：cold admission 可读原 catalog，不等待 resident activation；独立 continuation composition 与新 pending 的共享 composition 分别校验。同步接通 `role-control-rpc.ts` 的已有 cold prompt 路径。新创建 pending 协议不变，continuation 不冒充新创建；通过实际请求和权限拒绝验证，不只检查工具名称。

### 三：完整恢复验收与维护说明

扩展 `test/native-routing-fixture.ts` 的隔离 persistence/profile/home 共享能力，或新增小型专用 fixture；最外层测试持有临时目录，首个 Context 关闭不能删除下一 Context 要读的会话。使用项目内真实 Host controller、AgentLoop、SubagentRuntime、JSONL persistence 和确定性 adapter；无外部模型、真实 shell、用户文件或全局 DSH 安装路径。至少一条跨 Host 正向链使用实际 `DsmmNativeLlmRuntime` → `createDsmmRoleLlmOwner` → final capture/prepareCall → adapter，不以仅有原生 stock LlmRuntime 的 fixture 代替。

新增 `test/native-session-resume-refresh.test.ts`，覆盖以下有意义场景，不做角色×配置大矩阵：

- **跨 Host 完整链路**：A 中原生 root 选择 named profile、启用 mode，经真实 DSMM role tool 创建 continuable child，完成任务交互并保存父 catalog/child descriptor。关闭 A，在测试目录更新同一 named profile 的 route/策略/工具配置，令确定性 adapter 对旧 child 模型真实返回不可用、只接受新配置模型。B 经真正 `SessionController.resolveAgent`/历史 activation 恢复父，不手挂 standard；由父 `sendMessage` 或受验证 browser prompt 冷恢复**原 child ID**。检查消息和原任务仍在、exact 新父子 ownership、新角色 capture、当前 role prompt/schema；经过实际 DSMM LLM owner 的文本请求使用新 model/effort/策略并返回结果，没有 `INVALID_PREPARED_CALL`，不能只是父新建另一个 child。B 无旧 DSMM capture 仍成功，不伪造旧模型可用或 bypass preflight。保留既有伪造/重复消费 proposal 被拒绝的测试，并验证当前 fallback/recovery 变换也在最终 capture 前完成。
- **再次重新激活**：同一 Host 中释放 continuable child，更新当前合法配置，再经原生 continuation 恢复，取得新配置；仍 resident/running 的 sibling 不热切换。测试父的真实权限上限不被新 child 配置绕过。
- **功能和控制**：恢复后 root 的当前角色工具可实际委派；恢复的 role child 实际执行适合该角色的受允许工具/任务，readonly child 的 write/shell 被拒绝。browser cold prompt 能进入原生路径，foreign peer/parent 和非直接 descendant 控制仍拒绝，list 不唤醒。
- **最新选择与禁用**：session named ID 不被 global 默认替换；内容采用该 ID 最新正文而非旧 revision；current role/module/tool 禁用生效，显式 mode-off 保留。新配置允许的功能不因旧 DSMM capability snapshot 被无理由剥夺；原生安全限制仍生效。
- **身份和生命周期**：继承祖先 descriptor、伪 role/parent 文本、foreign registry、不匹配 catalog/lineage 不产生角色授权；原生合法 fork root 不被误判。settled one-shot 仍 NOT_RESUMABLE。受控安装失败、取消或父/owner replacement 不留可执行半安装；随后同 ID 合法恢复成功而旧对象仍撤权。
- **独立 composition**：合法 continuable child 使用原生 own 独立 preset 恢复，preset 与父不同仍能按当前角色配置执行；其原生独立 tools realm、父权限 ceiling 和 readonly 边界不变。验收发生在真实 cold resume，不能预先塞入 manager resident activation 让创建检查通过。
- **批准不继承**：A 中通过真实 approval 接口记住测试规则；B 同 ID 新 Agent 必须重新询问，拒绝后测试命令体不运行。不用真实命令执行来证明批准。

更新 `native-modules`、`native-role-invocation`、`native-role-lifecycle`、`native-role-routing`、`native-policy-capture` 及 profile/RPC 覆盖中与最终要求冲突的断言：合法 cold child 应有角色/最新配置，缺 capture 本身不拒绝；保留真实 ownership、one-shot、readonly、sandbox 和撤权负向。同步维护 `docs/profiles.md`、`docs/model-routing.md`、相关 runtime/permission 说明中的当前契约，先合并已有未提交文档改动，不改写为历史叙事。前端既有重写保持，只在真实数据接口受影响时最小同步，不另做 UI 重构。

实现者在 dsmm 根用 PowerShell 分别执行本地 build 和定向测试；集成完成由主协调者合并一次全局验证，复用仍有效证据：

```powershell
pnpm run build
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/native-session-resume-refresh.test.ts
pnpm run typecheck
pnpm run test:run
pnpm run check:roles
```

按修改接口补相关 child/profile/RPC 定向检查；需要测试 TS 类型检查时，在已有 build 后对 `tsconfig.test.json` noEmit，不重复 build。构建保持离线，不 sync/install。所有临时 scope、writer、child activation 和目录只按本测试 ownership 清理。

交付必须包含真实父恢复→原 child 恢复→角色任务实际执行的证据，最新配置与负向边界结果，以及精确未覆盖的 Host/历史格式限制。不得只以根工具恢复、compile 或成功日志宣称全部完成；未经允许不操作真实用户 Desktop，也不宣称已完成真实 Desktop 人工验证。
