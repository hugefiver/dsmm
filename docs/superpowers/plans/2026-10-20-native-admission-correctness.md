# DSMM 原生准入与生命周期正确性修复

## 目标与边界

辅助角色共享父 Agent 的 native standing composition，由可信、精确绑定到活 Agent 的 invocation 决定角色。合法空白会话配置选择与角色委派正常运行；child 首次请求具有完整自身 persona 和正确 Deepwork 状态。DSMM 活对象和自身入口校验 current owner、readonly、tool/depth ceiling，不把历史 metadata 当作当前 DSMM 授权。

- 仅修改相关 DSMM runtime 与行为测试，不修改公共 API、native preset 权威、权限上限或 native 生命周期协议。
- UI/client、`client-permissions` 的失败、全局配置/权限 UI 重设计及尚未真实复现的 workspace 审批问题不属于本交付；本修复不能作为它们已解决的证据。
- 遵循 `DESIGN.md` 的产品优先级，使用正常 DSH 扩展点；不要求 SDK admission broker、owner slot 或新 caller permit，不要求其他插件迁移。

## 接口与所有权

| 边界 | 有效契约与修改位置 |
| --- | --- |
| 空白配置事务 | `src/native-admission.ts` 的 `beginBlank().prepare/assertCurrent/close` 使用既有 admission、provider、composition 与 maintenance/CAS 边界；不改变 `profile-store` 的事务协议。 |
| 子角色准入 | `reserve → prepare → created → policy.bindChild → install → publish` 保留精确 parent、provider、pending call、scope、depth、tool filter 与 immutable admission 校验。`src/preset-registry.ts` 仍只注册可选 root dispatcher composition。 |
| 角色与提示 | `src/role-policy.ts::bindChild` 在 install 前绑定 invocation；`src/role-subagents.ts::registerHeadlessRoleTools` 的 identity reconcile 调用 `src/role-identity.ts::registerRoleHarnessIdentity`。提示注册及 disposer 归确切 child Agent 所有，不写共享 preset realm。 |
| Mode | `src/state.ts::DeepworkModeController` 消费 `src/role-invocation.ts::capturedRoleInvocation` 的进程内 Agent 绑定；持久化 session 文本、角色字符串或 descriptor 均不是授权来源。mode 是行为选择，不替代 admission/permission 守卫。 |
| 生命周期 | `NativeAdmission` 管理 DSMM 自身 pending/live/activation 状态；owner 或精确 parent 失效后，旧 DSMM 回调和入口不能继续使用旧绑定。取消、释放与回滚沿用原生生命周期，不向全局 native 恢复附加 DSMM 门禁。 |

## 工作包 A：合法准入与活对象生命周期

主要文件：`src/native-admission.ts`；测试：`test/session-profile-runtime.test.ts`、`test/native-policy-capture.test.ts`、`test/native-retirement-boundary.test.ts`，必要时复用 `test/native-role-lifecycle.test.ts` 的现有 seam。

### 空白配置选择

移除 `beginBlank().prepare` 将 delegation target 传给 `agentPresets.resolve(role)` 的无效校验。继续校验当前 standing composition、root role、provider 精确身份与 `depthLimit` capability、已配置 primary/fallback/level 模型可用性、权限与 startup ceiling。不得为 auxiliary role 新增可选 preset，也不得绕过失败恢复。

验收：合法 A/B/default 选择影响首次 prompt 和委派 route，但不改变 native root 模型或 future default；不可用模型、缺失/替换 provider、取消和 composition/owner 变化仍拒绝。保留安装故障恢复、queued first prompt、stale choice、rename/operator 回滚与 durable observation failure 的有效测试，验证 admission、持久状态及真实首次请求，而不是删掉 activation 测试。

### current owner 与首次创建

DSMM 角色首次创建保留有效 pending、精确 parent/provider/composition、scope、readonly、tool filter、depth 和 immutable admission 校验。异步创建与 install 返回后重新确认当前 owner 和 parent；拒绝或取消沿用 native rollback/disposal，不发布有效 DSMM admission，不进入对应 adapter 或 tool body。旧 owner 回调不能借同名 provider、相同 session ID 或替代 Agent 复用旧 invocation。普通非角色委派保留原生合法行为。

验收使用 DSMM 自身入口与活对象的实际创建、请求和副作用，覆盖 owner/parent 失效及 install 失败；新的合法 root/child 仍可工作。对象身份与当前准入是校验依据，历史 descriptor、角色文本和 profile selection epoch 不是执行授权。

### 原生恢复与能力限制

DSH 历史加载、读取、promotion、显式/声明式恢复及 provider 注销后的 durable 恢复遵循原生契约。DSH 创建不同 Agent、恢复并发出请求本身不是违规证据；DSMM 不通过阻断历史恢复实现卸载撤权，不将自身校验扩展为全 registry 门禁。

已观察到 DSMM 受限角色续跑可能丢失 DSMM 限制。当前 Host 下不保证恢复自动保有原 DSMM 角色资格、readonly/tool/depth capture 或安全续跑；依赖这些限制的精细角色恢复延后到有合适宿主支持时，不以历史 metadata 补授权。正常原生恢复仍按 DSH 自身授权运行，不能标作已验证的 DSMM 受限续跑。该能力限制不阻塞空白配置选择、首次 persona/mode 修正或配置/UI 保存，也不承诺跨卸载、重装或重启的全局撤权。

## 工作包 B：首次角色提示与 Deepwork 行为

主要文件：`src/role-identity.ts`、`src/role-subagents.ts`、`src/state.ts`；测试：`test/native-role-persona.test.ts`、`test/native-delegation.test.ts`、`test/state.test.ts`。

### 完整 child persona

沿 `bindChild → install → reconcileIdentity` 的初始化链，在首次 system prompt assembly 前，为已准入 child 在正确 systemPrompt service 的 Agent 层注册完整角色 persona，局部遮蔽继承的 `deployment:persona-prefix`；继续注册相应 `harness:identity`。完整内容采用现有 `DSMM_ROLES` persona 生成结果，包括角色职责、locale、host contract 与 terminal 内容。

保持 root 原生 persona 与共享 composition 不变；复用 identity reconcile 的 disposer，在角色/realm 变化、安装失败和 Agent disposal 时释放所有本次注册。不要等到 `createAuxiliary` 返回后再修提示：fixture 返回时首次 assembly 已发生。

验收读取 adapter 实际请求，包含创建时自动排队的首个 child turn：有/无额外原生 Persona 插件时，reviewer 请求具有完整 reviewer persona，不含父 orchestrator persona；父随后请求保持原身份，兄弟 Agent 不受污染。测试可比对角色语义标识与实际组装内容，不冻结整个提示文件或文案快照。

### admitted child mode

让 `DeepworkModeController.active` 的默认状态识别可信 captured invocation；无需改变 child native preset 或制造 mode 事件。模块准入仍为前置条件，显式最新 `deepwork/mode=false` 始终覆盖默认，普通 root、minimal preset 和未准入对象保留原语义。`describe` 的 active 与 revision/CAS 所消费的有效状态须保持一致；若引入新的状态输入，应纳入既有一致性边界，不新增公共配置字段。

行为验收以 admitted role、parent lineage、实际 persona 和 mode 为依据，不要求 child selected preset 等于角色 ID。

验收：普通 `standard` root、`defaultActive:false`、显式开启 Deepwork 后，零继承事件的合法 coding child 在存活阶段 mode 与 workflow 均 active；显式 off 仍关闭相应行为。`deny` 与无可用审批的 `ask` 两例都保持 shell body 次数为 0、tool result 为拒绝，foreground child 正常释放。角色文本或持久历史不能激活未准入 child；captured invocation 本身不恢复已退役 Agent 的执行权。

## 工作包 C：修正测试输入与观测边界

主要文件：`test/native-delegation.test.ts`、`test/native-policy-capture.test.ts`、`test/native-route-strategies.test.ts`；仅在必要时调整共享 `test/native-routing-fixture.ts` 的观测 seam。

- 对要求读取实际文件内容的 delegation 与 policy-capture 用例启用已有 `nativeFs:true` fixture 路径。保留临时文件读取、child result 向父传播、read-only/Git ceiling 行为验证；不得将预期改成默认 stub 返回的工具名，也不改变全体 fixture 的默认 FS 行为。隔离 mock shell，禁止真实写命令执行。
- 路由用例按 native call purpose 区分 agent 请求与 compaction 辅助请求，结合 `request/header` 与 `assistant/attempt` 检查 route。`UNKNOWN_MODEL` 允许 primary → backup；`NO_ADAPTER`、`SERVER`、`AUTH`、`QUOTA` 不允许跳转；`CONTEXT_WINDOW_EXCEEDED` 的 primary compaction call 不是新 fallback/agent attempt，不禁用 native compaction 来满足调用次数。
- 只删除失效的内部表示锁或真正冗余测试；这些文件中的读传播、权限负向、错误分类与不擅自 hopping 的行为覆盖继续有效，不能整份删除。

## 行为验收

完成证据是合法配置选择、首次 child persona/mode、显式 off 和父子权限上限的实际行为，以及 DSMM 活对象失效时旧入口不能继续使用其授权。profile CAS、安装失败回滚、请求/结果传播、错误分类与 native compaction 保持原有契约。不得以内部表示、描述文本快照或单独编译通过替代行为证据。

原生正常恢复的兼容性与 DSMM 受限恢复的未保证范围分别说明。相关局部测试与必要集成检查按受影响行为选择，复用仍有效的证据；未执行或未覆盖的行为不得报告通过。配置/UI 的验收不依赖新增 SDK 协议或全局恢复撤权保证。
