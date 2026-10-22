# DSMM continuation、准入与测试契约修复

## 交付目标与范围

让受影响测试准确保护当前 DSH 原生恢复、DSMM live admission、退役撤权、角色委派、profile RPC 和不可变配置契约。原生消息被接收、历史被重建与 DSMM 授权是不同结果，测试分别观察它们。

- 实施范围为下述测试及确有必要的局部 fixture seam；现有生产实现无需为这些失败增加恢复门禁或放宽权限。保留 `src/native-admission.ts`、`src/role-policy.ts`、`src/profile-runtime.ts`、`src/profile-rpc.ts`、原生 Registry/Runtime 的现行权限边界。
- 只使用本仓库构建输入，保持 `@dsmm/dsmm`、版本和全部 DSH `0.2.1-rc.2` 依赖不变。不得安装、修改 dependency patches、Git 写入或发布。
- 不实现独立的 exact-tool-call 只读审批与系统临时目录需求，不修改其计划。不得增加全局历史 gate、持久化 grant、描述符授权 ledger 或另一套生命周期管理器。
- 不手改 `agent-presets/`、`prompts/deepwork.md` 或生成产物；本交付不需要角色资源变更。

## 必须保持的接口与安全契约

1. **原生恢复不等于 DSMM 准入。** 未被捕获的 retained Agent、orphan/subagent seed、native resume 可以存在并依原生规则运行；不得因此得到 `NativeAdmission` 的 live binding、captured invocation、祖先的 DSMM policy epoch/fallback 或 DSMM 委派权限。
2. **精确身份与相邻关系。** 合法原父可向其持久化 continuable child 发送消息，冷恢复保持 session ID、创建不同 Agent；foreign parent、伪造 sender、已失效对象不得获得该控制权。settled one-shot 不可通过 continuable send 复活。
3. **退役撤销旧 DSMM 授权。** owner 退役后，旧 exact root/child、旧 admission 与旧 DSMM 入口不能执行请求或工具、不能发布新的 DSMM 子委派。原生 provider 注销后按 DSH 规则重建的新对象不是旧 capture 的续用。
4. **受限角色只保证 live capture。** live child 的 readonly、tool allow/deny、depth、immutable profile 与 direct-parent 限制继续有效。原生重建不承诺恢复 DSMM 限制，不能将其成功宣称为安全的 DSMM 受限角色续跑，也不能从历史文本补授权。
5. **RPC 的校验落在 RPC 上。** `dsmmProfiles.describeSession/selectMode/selectSession` 保持 exact live ordinary-root、native browser peer、CAS、取消与 maintenance 校验；原生 Agent 创建成功不能成为 RPC 授权证据。普通原生 root 的全局 permission-settings 权限是另一个接口，不能用于放宽 child profile RPC。
6. **不可变配置行为。** A root 与其合法 live children 保持 A 的 route/guard/startup ceiling；切换后的新 root 使用 B。Git guard 关闭不等于允许真实 Git 操作，也不保证任意 native shell 参数或底层执行成功。

## 工作包 A：原生恢复与 DSMM 权限的独立断言

涉及 `test/host-core-integration.test.mjs`、`test/native-modules.test.ts`、`test/native-role-routing.test.ts`、`test/profile-rpc-session.test.ts`。保留对应 suite 中已有的合法路径、模块关闭、root eligibility、CAS 与越权负向覆盖，只替换错误的创建/工具失败观测点。

### Retained Agent

`host-core-integration.test.mjs` 的 retained case：允许 fixture 的原生 `read` 成功，同时检查调用前后 `dsmmNativeAdmission.owns(retained) === false`、`dsmmProfileRuntime.hasAdmission(retained) === false`、无 invocation。实际调用 DSMM role tool 或 provider，应不能创建角色子节点或进入 adapter。若调用原生 turn，验证正常原生输出与未获得 admission；不要继续用 `read.isError` 推断是否 enroll。

### Orphan、seed 与 policy 隔离

- `native-modules.test.ts` 的 `module-off-child-resume`：接收 native creation 返回的 Agent，断言没有 DSMM capture、没有 DSMM provider 创建权限。创建本身不启动请求，保留相应 counter 检查；明确释放 fixture handle，不再要求整个原生 create 返回 `UNAUTHORIZED`。
- `native-role-routing.test.ts` 的 configured child case：保留 live child 的完整 primary → fallback 与随后请求锁定断言。对随后由 persisted seed 创建的 Agent，检查未绑定 admission/invocation，拒绝 DSMM delegation。运行一个受控原生 turn，按该 Agent 的新增请求及 own events 检查没有恢复 DSMM retry/fallback 授权，而不是要求创建失败或 registry 只剩 parent。
- 同文件的 ancestor-policy seed case：保留真实祖先 fallback、伪造 role descriptor、`isSeeded` 与 `inheritedEventCount` 输入。创建可成功，但不能调用 DSMM role provider，不能新写自己的 DSMM role-policy epoch，新的实际请求使用原生 route 而非祖先 fallback/current deployment role route。比较创建后 event offset 与该 Agent 的 request；不得把继承的 `request/header`、祖先记录或父完成通知算作 child 新授权。
- 同时保留真实 DSMM 首次角色创建的 pending parent/provider/invocation、scope、composition、tool/depth ceiling 校验；上述 native seed 接受不授权直接调用 DSMM provider 的 prepare/start。

### RPC

`profile-rpc-session.test.ts` 的 native mode RPC case：将原生 orphan 创建拒绝断言改为实际创建 orphan，分别调用其 `describeSession`、`selectMode`，按现有 `refused("not-owned")` seam 断言拒绝；验证目标/其他合法 root 的 snapshot 与 mode events 未变化。后续合法 admitted reviewer 的 RPC 拒绝和原 root 开/关 mode、stale CAS 检查继续执行，不被前置假断言遮挡。无需修改 `core-permission-authority.ts` 或 RPC 授权实现。

**完成证据：** 正常 native 行为可执行，但 retained/orphan/seed 的 DSMM 权限与 profile RPC 仍拒绝；live role fallback 和 fresh-admission 安全检查不受影响。

## 工作包 B：continuable 生命周期与精确退役

涉及 `test/native-delegation.test.ts`、`test/native-role-invocation.test.ts`、`test/native-role-lifecycle.test.ts`、`test/native-policy-capture.test.ts`。使用现有 native fixture 与官方 persistence、send、interrupt、drain；不要模拟 native manager。

### 正常 cold continuation

三个 drain 后发送用例分别覆盖 service send、model-facing `send_message` 与 live 继承过滤器：

- 先保留 live child 上原有有效工作、filter、interrupt、容量与 foreign-parent 拒绝断言。
- 依据实际 `foldSubagentDescriptor(...).mode` 确认 continuable。`createAuxiliary(..., "one-shot", ...)` 的参数不是持久化 mode 证据，不能用它声称测试了 one-shot。
- drain 后等待原生持久化完成；原父发送应得到 accepted message ID，model-facing tool 应成功。取得新 resident，验证 ID 相同、对象不同、direct parent 正确，且无 DSMM admission/invocation。
- 等待新 Agent idle，检查该次消息及有用 assistant 输出/terminal outcome；accepted receipt 本身不是完成。保持输出确定，不执行任何真实写工具。
- `native-role-invocation.test.ts` 在等待恢复 turn 前释放/移除原有阻塞 `beforeStream` gate，避免把旧测试故意挂起的 adapter 带入新的完成断言。
- foreign parent 在冷状态发送仍拒绝，不创建 resident、不产生相应请求。不要放宽已有 live interrupt 与 adjacency 拒绝。
- live 过滤器的 `writes === 0` 等断言放在 live 阶段；冷恢复段不声称 readonly/tool/depth capture 得到保留。清理新的 resident，不能仅释放已 drain 的旧对象。

### 退役边界

`native-policy-capture.test.ts` 的 retired case 分别检验两个边界：

- 保留 owner dispose 后旧 child 被释放、旧 root 仍 resident 的检查。保存旧 admission/入口引用，验证旧 exact root 的 admission、原生 tool 经其旧 scoped guard、实际 turn 请求及 DSMM delegation 均拒绝；按旧 Agent 身份统计 adapter/tool body 没有新增执行。
- 若继续测试直接 native `subagents.sendMessage(root, oldChildId, ...)`，应接受 DSH 的合法 durable 重建：新对象无旧 capture，原生 turn 可完成。不能在这一步后再要求全局 adapter 总次数不变；不能给 native `sendMessage` 增加 DSMM 全局卸载门禁。

### Settled one-shot 负向契约

在 `native-role-lifecycle.test.ts` 增加一个真正持久化的 legacy/native one-shot case：用 fixture 自有 Session 创建具有正确 parent header、合法 one-shot descriptor 和 completed turn 的记录，经官方 persistence flush 并释放 resident；原父 `sendMessage` 应返回 `NOT_RESUMABLE`，无新 resident、无 adapter 调用。不要把真实 continuable 的 mode 改成 one-shot，也不要依赖 `createAuxiliary` 的旧参数模拟协议。

**完成证据：** 原父 continuable 冷恢复同 ID 并完成有用输出；foreign/settled one-shot 拒绝；旧 exact DSMM capture 退役后仍无法执行。已有 `native-retirement-boundary`、`native-core-lifecycle` 与 `native-runtime-contract` 的有效断言保留。

## 工作包 C：跨平台的 profile Git guard 测试

仅修改 `test/profile-runtime.test.ts` 的 native global A-to-B case，保留当前 dispatcher preset、profile selection、child route、blank rebind 和 startup-ceiling 场景。

- 在执行 A/B Git guard 断言前，分别取得两个 Agent 的有效工具 realm：`agentPresets.serviceFor(agent, "tools") ?? agent.ctx.tools`。
- 使用 `getTraceable(agent.ctx, tools).register(...)` 在各自 **Agent 层** 注册同名 `bash` 计数器 definition；参数要求 `command` 与 `description`，body 仅递增内存计数并返回结果，不启动 shell/subprocess、不执行 Git。
- 通过上述有效 realm 调用 tool，提供两者都合法、相同结构的参数。A 仍拒绝且 body 次数为 0；B 成功且 body 次数恰为 1。disposer 跟随 fixture Agent scope，必要时显式 `finally` 释放。
- 不仅补 `description` 后调用真实 shell：该 fixture 禁止外部 I/O；也不把 B 的期待改为失败、不关闭安全 guard、不根据平台 skip。
- 不修改共享 fixture 的默认 native preset 或全局 shell 注册策略。本次 seam 仅用于此配置隔离测试。

**完成证据：** Windows/Linux 都观察同一个受 DSMM guard 管理的计数器 body，排除 native 参数校验、平台 shell 遮蔽及外部 I/O 对配置断言的干扰。

## 实施顺序与验证

A、B、C 可按测试文件分开实施，无生产源码依赖。若共用小型 fixture seam，以是否确实消除重复为准，不建立通用授权断言框架。保持测试自身有效语义，不冻结描述文字、提示文案、内部文件布局或机器环境。

局部验证在 dsmm 根目录使用现有 source loader，例如：

```powershell
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/host-core-integration.test.ts test/native-modules.test.ts test/native-role-routing.test.ts test/profile-rpc-session.test.ts
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/native-delegation.test.ts test/native-role-invocation.test.ts test/native-role-lifecycle.test.ts test/native-policy-capture.test.ts
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-name-pattern='native global A-to-B' test/profile-runtime.test.ts
```

按各文件实际耗时给予足够 timeout；首次实现后的定向结果同时检查失败列表与计数，不能用进程提前终止代替完成。source-loader 测试不等于 package MAIN 构建交付证据；集成负责人统一运行所需 build/typecheck 与受影响 package MAIN 验证，并在 Windows/Linux 验证 shell case。全套只由任务负责人按最终集成需求安排一次，不在每个工作包重复。

验收包括所有原失败位置的修复、其后曾被遮挡的断言实际运行，以及 continuation/denial/RPC 的有效正负边界。任何剩余失败、超时或未执行的平台如实报告。受限角色跨恢复/重装的安全续跑仍不受保证；本交付不改变该限制。若出现可复现的 DSMM admission、角色或 RPC 越权，应停止对该断言的放宽并报告具体边界，不把原生成功直接解释成 DSMM 授权。
