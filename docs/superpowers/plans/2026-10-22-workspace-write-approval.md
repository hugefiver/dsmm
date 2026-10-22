# Workspace-write 修改范围审批

## 交付目标与边界

DSMM 自动范围审批只针对实际 standing `workspace-write` 下、工作区与真实系统临时目录之外的修改。可信只读调用、工作区内部修改和系统临时目录修改不产生此项审批。系统 temp 指执行端实际系统临时目录，不得用会话私有 temp 代替，也不得以静默 `danger-full-access` 达成。

- `outsideReads: ask` 和 `outside-read` 条目的 `action: ask` 不再为可信原生只读调用产生审批；保留配置读取兼容性，不自动改写用户保存的规则。
- 显式 deny、原生 read-only、角色/工具/RPC 权限上限、取消与调用身份约束继续有效。新的范围放行不覆盖未知第三方 downstream ask，不自动批准显式原生权限升级。
- 默认模式由实际 `sandboxPolicy.resolve({ session })` 决定，不能使用工具参数、UI 标签或请求中的目标 mode 充当 standing authority。
- 保持 DSH `0.2.1-rc.2`、项目版本和依赖不变。不安装、不 Git 写、不访问用户报告中的 pixivbot。不处理其他测试修复任务拥有的 role/cold continuation/host root/RPC 合同。
- 完整交付包含真实文件修改及 shell 后端验证；仅消除 glob 弹窗不算完成。本计划的 Windows 宿主授权阻塞必须解除，不能隐去或将目标缩减为私有 temp。

## 现有接口与约束

`src/permission-native-rules.ts` 的可信只读 outside-read 判定在没有相关 deny 时继承下游决定，不因缺失路径或 co-location 事实生成 ask。有相关 deny 而缺乏必要事实时，保留当前模式下的 fail-closed 边界。生产装配不伪造 co-location 证明，独立下游审批仍然有效。

`src/permission-controller.ts` 目前只捕获 read/glob/grep/web 与 shell，没有 write/edit 修改绑定。`permission-fs.ts` 和 `permission-fs-search.ts` 是原生注册适配入口。`tools.guard()` 是审批后的单调拒绝阶段，不是审批来源，不能改成强制放行器。

固定 DSH 的公开能力：

- `FileSystem.resolve/contains/processPath/processPathFromHostPath`：由实际 backend 提供目标身份、包含关系与执行端路径。targetKey 保持不透明。
- `dsh-fs-local` 对缺失目标解析最近真实父目录；其本身不实施 sandbox，不能把挂载 local FS 当作已有隔离证明。
- `FileSystem.writeText/editText` 接受单次 `sandboxPolicy`。原生工具保留 `fs/write-intent`、`fs/edit-intent`、观察记录、版本保护与原子修改；不得另写一份 write/edit 实现来替代它们。
- `SandboxExecutionPolicy` 仅有 `mode/workspaceRoot/sessionId`；`SandboxProvider.confine(argv, policy, signal)` 返回约束后的 argv 和 enforcement/诊断信息，没有附加写根字段。
- `ShellSandboxInfo` 只提供 mode、denied、enforcement、runnerFailed；没有实际越界路径、文件操作回调、暂停后授权继续或可证明无副作用的重放能力。

## 实施波次

### 一、只读规则不再制造范围审批

修改 `permission-native-rules.ts`，在可信原生 read/glob/grep 及已有可信 readCapability 证明的 shell 读取分支中分离显式 deny 检查与 ask 生成。outside-read 的 ask 对这些调用不再生成 native approval，未知共址或路径事实也不能将 allow/inherit 升级为 ask。保留 deny 的现有约束及 fail-closed 语义，不为消除提示伪造 `coLocated: true`。不得把没有可信执行能力证明的任意 shell 命令划为只读。

保留注册 identity、原始 body、参数、agent、token、取消信号的绑定；不改变 downstream deny/cancel/未知 ask 的合成。shell 仅调整既有可信只读分支的 outside-read 问询，不改变独立命令规则和未知命令执行语义。

完成证据：在生产式无 co-location 的原生注册 fixture 中，allow、ask、inherit + outside-read ask 条目均不新增只读审批；已有可信能力的 shell 读取同样不新增 outside-read 审批。deny 仍拒绝，未知第三方 ask 仍到达原生审批。验证 body 调用和审批计数，不锁提示文案。

### 二、原生修改保留宿主链路，完整范围能力待解阻

当前实现保留 native write/edit 的 policy、intent、版本保护、观察记录、原子修改与显式升级流程，不新增 FS permit 或以单次更宽 mode 冒充精确目标隔离。`dsh-fs-local` 不执行 `sandboxPolicy`；`resolve/contains` 的检查不能单独消除检查后目录或 junction 改变的竞态。

完整目标要求实际挂载的执行 backend 同时证明工作区与系统 temp 范围放行、外部修改须批准，以及批准目标与实际修改目标一致。缺失目标须解析最近真实父目录；同前缀、`..`、链接跳转不能获得额外权限；拒绝与取消不得写入。保留原生 read-only、版本保护与原子发布。

在取得具备这些能力的 backend 及所需授权前，本项阻塞，不扩展新的 DSMM FS 安全框架。仅修改前置决策或传入 backend 不执行的 policy 不构成交付，也不作为只读修复的前置条件。

### 三、shell 保持真实约束，接入可支持完整 temp 的宿主

`permission-bash.ts`、`permission-pwsh.ts` 和 controller 的 shell seam 保留原生 tool/body、工作目录解析、取消、前后台 jobs 与 sandbox 执行。禁止自制任意 shell 解析器、命令名信任、按 cwd 放行、全局自动回答 approval 或将所有命令改为 full access。

普通命令直接在 workspace-write 的真实约束下运行，不先按未知效果一律询问。允许根必须是工作区与执行端系统 temp；外部修改由后端阻止。已有 DSH 可用流程是：受限运行返回 denial，调用方检查已完成效果，再显式请求原生一次升级审批。不得由 DSMM 自动重放命令，也不得把 stderr 猜测当作精确越界路径证明。若要求原调用在首次越界时暂停、审批后继续，当前接口没有该能力，需要另外授权宿主能力扩展。

Windows 完整 temp 放行受下节阻塞。Linux/macOS 同样按实际 runner 验证：Seatbelt 使用 `writableRoots()`；现有 bwrap 使用私有 `/tmp` 挂载，Landlock 固定 `/tmp` 与 workspace，不能据共享 helper 宣称所有后端都已支持宿主 `os.tmpdir()`。

完成证据：在批准的真实后端下，以实际写入目标验证 workspace/temp 零范围审批、外部非 temp 不在未批准情况下修改；至少包含“cwd 在工作区但目标在外部”和“cwd 在外部但目标在允许根”以及混合效果命令。结果必须保留原生 enforcement 精度，不能把 partial 报成 full。

## Windows 完整 temp：具体阻塞与最小授权选择

当前 `LocalSandboxProvider` 配置只有 runner override、失败特征和 probe timeout，没有 writableRoots 配置。其 Windows runner 仅携带一个 workspace 与一个私有 temp；standalone 模式也创建私有子目录，修改 TEMP/TMP 不等于授权整个系统 temp。

底层公开 `AclSandboxOptions.writableDirs` 确实支持多个根，`AclWriteGrant.add()` 和公开 runner 可支持自定义 provider 接入。无 init/spawn 的构造探针已确认 workspace + 系统 temp 两根可被接受；这不是执行或安全验证。

该路径不是无副作用开关：实际 grant 会修改真实目录及继承树的 capability allow ACE、Everyone 的 FILE_DELETE_CHILD deny、Low integrity label；默认 writableDirs 授权是 standing，dispose 不撤销。即使改用 revocable grant，公开 revoke 是合并移除/清理，不是保存并原样恢复任意既有安全描述符的事务。它还保留宿主注明的 Everyone/hard-link 等 partial 边界。

因此，在现有授权内不能静默对整个共享系统 temp 应用这些修改，也不能声称 stock 配置已能完成目标。主协调器必须解决以下一条路径，才能把第三波交付为完成：

1. **固定版本适配路径：**明确授权开发 DSMM 的 Windows sandbox provider/runner 适配，并明确批准系统 temp 整棵树的 DACL/完整性标签影响。实施前必须确定授权根、并发生命周期、既有 ACL/label 保护与恢复能力、失败回滚、不得在 live child 下撤销授权，以及对原生 partial 边界的验收。不允许直接把 temp 加入默认 standing writableDirs 后留置授权；现有公开撤销 API 不足以证明恢复时，继续阻塞而非猜测安全。
2. **宿主能力路径：**授权宿主提供带完整 temp 根且满足安全要求的执行 backend/接口；若需要新的依赖、安装或 DSH 修改，必须分别获得授权。当前计划不作这些变更。

缩减成私有 temp、改为 full access、把系统 temp 写入错误当作成功，均不满足本交付。若无法获准上述任何路径，应明确报告完整目标被阻塞，而不是仅以只读修复结案。

## 集成范围与验证

- 当前可实施源码范围为 `permission-native-rules.ts` 的可信只读 outside-read 决策及相应测试；不扩大 shell simple-command 授权。FS/backend、shell provider 与装配扩展受上述能力和授权阻塞控制。
- 文档更新 `docs/native-permissions.md`，描述最终只读 ask 与修改范围行为；不新增配置开关，不迁移用户规则，不改版本或依赖。
- 回归以 `permission-native-rules.test.ts`、`permission-fixture.ts` 的模式构建专用测试；修改 fixture 时不改变其他测试的默认语义。测试注入独立 temp 根，不能让真实 temp 下的 workspace/outside fixture 全部自动成为允许范围。
- 与另一测试修复任务的接口仅为现有角色/工具 eligibility、原生 approval、取消和执行身份保证。保留 guards.ts、role/RPC/current-guard 合同；发现冲突交给主协调器，不在本任务修复其实现。
- 工作者执行相关定向测试。主协调器集成后运行受影响 typecheck/build 与定向 native runtime 检查；复用仍有效证据，不重跑全套来掩盖已知失败。未涉及角色生成时不生成角色资源。
- Windows 的真实 ACL/runner 验证必须在获准且可恢复的专用环境进行；未授权之前只允许无变更能力探针，不对用户系统 temp 做 grant/init。临时文件与进程仅清理本任务拥有的精确资源。
- 最终验收同时报告只读误审批、真实 FS 修改、真实 shell/temp 能力以及未解除的宿主授权项。单元 mock、构造成功、typecheck 或原生 once acknowledgment 均不能替代实际效果证据。
