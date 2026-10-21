# DSMM 命令白名单：本次 full access

## 最终合同

执行只有两个分支：

- **simple 字符串白名单命中：**跳过 DSMM 命令策略层，包括 Git guard、outside-read、general shell rules 的 ask 与 deny，以及同时命中的 legacy 命令限制；为该次实际命令自动批准 `danger-full-access`，无需交互批准。
- **simple 未命中：**完整保留原执行流程，包括 legacy 对象的 ask/allow、sandbox target、ambiguous、native approval 和一次消费语义。

full access 允许该命令访问 OS 所允许的外部路径，不是仅免提示或仍受 DSMM outside-read deny 限制。授权覆盖该命令及其执行的程序；只对当前工具调用有效，不改 session/全局 sandbox 默认，不向下一调用或另一个 Agent 转借。模型显式请求 full access 也在此次授权之内。

不扩大非命令策略资格：真实当前工具调用、current owner、工具注册/生命周期、取消、角色工具资格、readonly/tool filter 继续使用现有检查。配置写入 authority/CAS 不变。不新增身份框架、配置 epoch 门禁、持久授权票据或第二套 simple token 状态机。

仅修改 DSMM；不改 Host/SDK/provider/start/第三方协议、用户 profile、`node_modules`、根项目或 Cargo/LSP，不安装、不做 Git 写操作、不运行恢复探针，不等待无关 upstream。

## 配置与 UI

沿用字符串列表与严格 `string | NativeCommandEntry` schema：默认关闭、数组整体覆盖、空数组与 unset 区分、legacy 无损保存。simple 保留完整字面 token 前缀、尾部 argv、PowerShell 命令 token 可选 `.exe`、显式解释器字面 argv，以及外层复合/动态语法不命中的规则。stock `bash/sh/zsh`、`pwsh/powershell` 的工具名/dialect/command 字段约定不变。

新建只有命令字符串和添加/删除，无 sandbox 控件。legacy 只读摘要及删除、顶部 scope、Global 默认/profile 继承、错误/草稿/readonly/CAS/权威读回等现有界面工作继续，不重新划分前端波次。提示只需清楚说明：白名单命令每次执行自动获 full access；这是外部路径与程序执行授权，不只是免询问。

## 最小内部决定

simple 可以直接归一成**本次内部 allow + `danger-full-access` 决定**。无需生成带虚构 id/tool/cwd 的 legacy entry，不写回配置，不扩大 legacy 格式。

在 `src/permission-control.ts` 将现有执行代码实际需要的 `mode/sandboxMode` 与 legacy 配置对象解耦，例如内部使用 `Pick<NativeCommandEntry, "mode" | "sandboxMode">`，并用一个 `source: "simple" | "legacy"` 区分优先级。legacy matcher 继续返回原对象，simple 返回 `{ mode: "allow", sandboxMode: "danger-full-access" }`。复用现有 `Binding`、`exec.token`、request WeakMap、`approvedTarget`、`run`、native request consume 和 `finish`，不另建 simple grant Map。

simple 的内部 target 固定 full access，优先于 legacy 与模型较窄请求；legacy 分支保持原 `officialMode/target` 计算。pure readonly/role/tool 资格检查仍先于 simple 授权，不借用会跳过这些资格检查的 standing-full-access 分支。

## 接线

### 命令策略入口

在 `permission-controller.ts` 计算同次 simple 决定，供 `guards.ts` 与 `permission-native-rules.ts` 复用。资格检查后、命令 ask/deny 计算前命中即进入 full-access 决定；不要先触发 outside-read/classification deny 再尝试救回。`guards.ts` 仅绕过其命令策略分支，不绕过 role admission 或非命令资格检查。

mixed 列表中 simple 一旦命中，不再把 legacy ask、ambiguous 或较窄 sandbox 合入本次决定。只有未命中 simple 才执行原 legacy matcher/compose。无需改通用 rules 的持久格式或删除其正常执行路径。

### 原生批准与 managed 执行

`PermissionControl.compose` 为 simple 的已绑定普通 pre-execute ask 使用现有私有 `request(binding, request, service, true)`，而不是直接调用未登记的 `approval.request`；仍接受原 service 的最终 outcome。随后复用 `run` 和已有 full-access target 一次消费。managed shell 可继续由现有 shell façade 将已批准 target 应用到本次 executor spec。

simple 必须得到原生 approval service 的批准结果，不能仅设置 mode 后直接执行。DSMM 自动 answerer 只回答绑定的当前请求；不按 reason 文本或工具名独自授权，不把所有 `ctx.approval` 请求放开。调用结束/拒绝/异常/取消沿现有 finish/revoke 清理，不增加 session 记忆。

### 默认 stock shell

stock 原 body 只会因显式 sandbox escalation 向 native approval 请求批准，单纯在 DSMM 中写 `approvedTarget` 不会改变它的 sandbox。必须接上实际 body，不能以 managed fixture 代替。

最小适配是复用现有 `registerShell` 的薄 execute wrapper 形式，通过公开 `tools.get/register` 为默认 stock bash/pwsh 的实际 definition 接入 `PermissionControl.run`。保留原 definition 的 schema/output/presenter 和原 execute body；未命中直接委托原 body。适配必须留在原有工具可见性层级，不能通过 Agent-local 同名注册绕过 global tool filter；用公开 disposer 和现有 registration 生命周期释放，不修改 Host composition 或第三方工具源码。只包装一次，不能把自己的 wrapper 当作新 stock definition 反复注册。

stock wrapper 在 simple 命中时传给原 body 一个本次有效参数副本：原 command/workdir/其他参数不变，仅把官方 escalation 参数归一到 `sandbox_permissions: "danger-full-access"` 并提供真实的白名单授权 justification。原始 frozen arguments 仍是 runtime binding 的检查对象；副本仅用于本次原 body，不写回配置或模型调用，不用 `Reflect.set` 改 readonly `ToolExecution.arguments`。已有 `run` 把该次 body 放在当前 Binding 的 AsyncLocalStorage 作用域，并使用其取消信号。

原 stock body 向原生 `approval.request` 发出的 escalation 在 `answerer` 中利用这个既有执行作用域、完整调用核对及一次消费接缝得到自动批准。将 managed `nativeApproval` 中可复用的校验/consume 部分小幅提取即可；stock 请求已进入原 service，不能递归再次调用 service。不得新建另一个执行关联系统。若已有 pre-execute 批准，同次 body 的 full-access 请求只消费对应 target；若没有，当前 simple allow 决定自动回答本次实际 escalation。

standing policy 已经是 full access 时不制造无意义的“再次升级”；沿原生有效 policy 执行。实际 executor 不提供官方升级能力时，不能把 answerer 成功当作 full access 已生效，应报告该 composition 的实际能力限制，不安装 executor 或改 Host。stock 接线需用真实注册与过滤行为验证：若公开注册无法保留原层级/注销语义，交接该具体缺口，不用额外覆盖层掩盖。

## 原生 API 的实际限制

- rc2 `ApprovalService.decide` 先处理取消和 session policy `never`，再调用 answerer。因此 **`never` 会拒绝需要批准的调用，DSMM answerer 无法覆盖**。保留原生结果并如实说明；不修改 policy、仿造 service 或增加自己的 never 门禁。
- ToolRuntime 将最终 pre-execute ask 转成 request 时没有公开 token/arguments/用途字段。DSMM 自己组合的 ask 可以通过现有 request 对象绑定自动批准；stock body 请求可以通过上述 `run` 作用域绑定。任意外层扩展重建的、丢失来源关联的 ask 不因此获得可证明的绑定。若实际部署存在这种额外批准且要求同样无提示，需要指出具体调用点供决定；不能仅凭 callId/name 全局匹配授权，也不能把这一扩展情况误报成 stock 原生 escalation 不可实现。
- “批准 full access”必须由实际 executor policy 体现。原生服务返回成功、DSMM target 字段或日志都不能单独证明已执行于该 mode。

## 验收与交接

扩展现有 `permission-simple-command.test.ts`、`permission-managed-shell.test.ts`、`permission-regressions.test.ts` 和相应 fixture 的相关用例，不新建权限测试框架：

1. 保存 simple 后，managed 与未改 Host composition 的 stock NativeBash/NativePwsh 都执行真实原 body；native service 产生真实批准结果、交互 answerer 不被调用，executor 收到 `danger-full-access`。覆盖模型未设置与已设置官方 escalation 参数。
2. simple 命中时 Git/outside-read/general shell 的 ask **和 deny** 均不阻挡命令；mixed legacy ask/ambiguous/较窄 target 也不阻挡。simple 未命中时同样策略与 legacy 行为完整保留。
3. 首次命中执行后，下一次未命中仍采用原 standing sandbox；session/default policy 未改变。不同 arguments、call/token、Agent/owner 或注册不能复用批准；取消/readonly/tool filter 仍拒绝，body 不执行。
4. native `never` 真实拒绝、缺失/拒绝的 approval outcome 不被伪造为成功。普通 pre-execute 与 body escalation 都出现时无交互重复提示，target 不能被后续请求转借。
5. stock wrapper 保留原 schema/output、注册可见性与过滤；未命中不改变参数或执行结果，dispose/工具替换不能继续执行旧 body。真实 native body + 受控 executor 能证明接线和 policy；不能冒充 OS confinement 证据。
6. 配置/parser/UI 复用仍有效的证据；更新已变更的 simple 权限期望，不保留相冲突的 DSMM deny/legacy ask/不自动升级断言。legacy-only 合同测试保留。

实现范围主要是 `permission-control.ts`、`permission-controller.ts`、`permission-native-rules.ts`、`guards.ts` 及直接相关测试/权限说明。规划阶段不实现、不跑测试、不派工作流；后续仅从 `dsmm/` 运行选定行为用例与协调者安排的相关检查，不运行恢复集或根 Cargo/LSP。
