# DSMM 单一命令模式白名单

## 目标与范围

`permissionControl.nativeCommands` 只接受 `commandPattern`。配置、持久化、运行时和表单使用同一合同；不接受、不迁移、不静默丢弃旧 `executable/subcommand/args` 形状，也不把旧规则自动转换为更宽授权。非法存量配置必须显式校验失败，不写回默认值或部分成功。默认仍关闭，新条目仍为 `ask + workspace-write`。

仅修改 DSMM 命令规则及对应有效测试、使用说明；保留其他工作树改动，不修改 Host、SDK、依赖、`node_modules`、已审 `DESIGN.md` 或其他计划，不安装软件，不研究或重写恢复架构。`PermissionShellIdentity.executable`、通用 shell permission rule 的 `match.executable` 和模式解析结果中的 executable 不属于删除范围。

## 唯一接口与安全合同

```ts
type NativeCommandMatch = {
  readonly tool: "bash" | "pwsh";
  readonly workingDirectory: string;
  readonly commandPattern: string;
};
```

`NativeCommandEntry` 的 `id/mode/sandboxMode` 及外围 `enabled/entries` 不变。match 只接受上述三个必填字段；旧字段、混用、缺字段、未知字段、空模式或非法语法均拒绝，包括 disabled 条目配置。Global/native 导入、保存、读回及运行时解析不得经 schema 字段剥离绕过拒绝。

```text
pattern     := executable BLANK subcommands [BLANK "*"]
subcommands := literal ("|" literal)*
BLANK       := 一个或多个 ASCII 空格或 tab
```

- `go build|test` 与 `go build|test *` 等价，`go test` 也允许零个或多个静态尾部 argv。`*` 仅为末尾独立 token；不支持字符 glob、正则、执行程序备选、跨 token 备选、固定尾参数或空子命令。
- literal 沿用 Unicode 字母/组合标记/数字及 `_ . / : = + % -`；executable 另允许 Windows 反斜杠。首尾 ASCII 空格/tab 可忽略，模式内引号、转义、含空白路径、其他空白和控制字符仍拒绝。保留每文本 32768 字符、最多 1024 条的限制，不扩 grammar。
- grammar 的 subcommands 是第二 argv 位置的字面量，不推断程序语义。单 token 调用不能表达；原先省略 subcommand 的规则不保证可等价表达。即使 `Write-Output owned` 在语法上可写为模式，也会允许更多尾参数，不能作为旧规则的等价迁移。
- 先完整调用现有 `literalCommand(command, dialect)`，成功后才匹配 executable 和第二 argv；保持解析器不变。实际 `go build|test`、管道、拼接、换行、重定向、替换、展开和 wrapper/interpreter 不获增强，走普通原生路径，而非一概禁止。已支持的静态引号参数仍按内容处理。
- executable/子命令逐字且区分大小写，不解析 PATH、basename 或别名；tool 与 Host 规范化后的有效 cwd 精确匹配，不隐含子目录授权。所有命中共同判定：不同 sandboxMode 为 `ambiguous`，相同 sandboxMode 中 `ask` 优先，不依赖条目顺序。
- 命中只是候选，不越过 native deny/never、绝对 read-only、角色/工具上限、当前 owner/registration/cancellation。保留现有 compose/run/nativeApproval、真实原生最终答复、批准调用身份绑定与一次消费；不得把批准借给修改参数的调用或后续调用，也不新增配置 epoch 撤销原生最终批准的门禁。
- 保留 Global/native 整数组替换、Unset 继承、当前写入 authority、CAS 和权威 reread；失败不重放、不改写另一层。UI 不增加创建 `danger-full-access` 的入口，来源已有值保持原展示限制。
- 任意静态尾参数仍允许程序自身能力，如 `go test -exec`、构建脚本和测试代码；不是参数安全或文件系统隔离证明，不添加猜测性黑名单。外部目录读写白名单不在本交付内，不能宣称 Host 新增路径授权。

## 实现与接口衔接

### 1. 配置到运行时闭合

后端负责 `src/permission-settings.ts` 的单一类型、严格 parser 和 browser-safe schema；`src/permission-native-command.ts` 删除 exact matcher 分支，沿用 `parseHostNativeCommands`、`literalCommand`、ask/ambiguous 汇总。`src/settings.ts` 的 sparse transport 必须保留完整 match 必填字段，核对 `DSMM_CONFIG_SCHEMA`、`DSMM_NATIVE_CONFIG_SCHEMA`、`deploymentEditorSchema` 和 `resolveDeployment`。`permission-remote`、`permission-rules`、`deployment-permission-rules` 仅适配确有字段假设的入口，不建立新设置源或审批算法。

完成证据：新模式通过真实 schema、序列化、两层覆盖和结果解码往返；旧格式/混用在解析与 Global/native 保存边界失败，未落盘、未发布提权候选；有效新配置不丢失显式字段或来源。

### 2. 单一表单与有效 fixture

前端基于唯一 match 接口继续 `src/client/NativeCommandEntries.tsx`：新增空 `commandPattern` 草稿，只保留模式输入和公共字段；删除 exact 输入、JSON args 编辑器及模式切换状态。保留模式 raw/invalid 状态、Save 锁定、修正、移除及 Unset 清理，不让隐藏旧字段阻塞或恢复。沿用 `DeploymentController`/`DeploymentFields.tsx` 的事务。同步 `permission-locales.ts` 中英文说明和 `docs/native-permissions.md` 的最终用法、无迁移及表达能力限制。

测试按有效需求调整，而非机械替换所有 executable：

| 受影响范围 | 最终覆盖 |
| --- | --- |
| `test/permission-native-command.test.ts`、`permission-control.test.ts`、`permission-command-pattern.test.ts` | fixture 改为模式；保留 literal 解析、tool/cwd/case、disabled、ask/ambiguous 和严格配置边界；交叠使用两个模式。删除 exact 固定 argv/顺序匹配、旧符号保持字面量等专属断言，保留 literalCommand 自身 argv 保真测试。 |
| `test/permission-managed-shell.test.ts` 的 `commandEntry`、`permission-regressions.test.ts`、`permission-managed-tools.test.ts` | 更新匹配 fixture 和对应实际调用，保持执行/审批计数、目标 sandbox、never、当前 owner、registration、取消和一次消费要求。 |
| `test/deployment-permission-rules.test.ts`、`client-permissions.test.ts` | 更新规则配置，保持真实持久化、Host cwd、整体覆盖和 RPC 解码行为。 |
| `test/client-permission-config.test.ts` | 两层添加/保存/读回/修改/Unset，非法模式草稿及修正，CAS 和只读/失效 authority；删除仅 exact 字段编辑和切换专属用例，混合用例保留有效事务覆盖。 |

特别处理三个无 subcommand fixture：`permission-regressions.test.ts` 的共享 entry、`permission-managed-shell.test.ts` 的 same-level ask、`permission-managed-tools.test.ts` 的 pre-Core managed shell。需要命中模式来验证安全边界的场景，改用受控执行 seam 中明确可表达的 `go test` 等调用并同步其规则；不得删掉这些安全测试或放宽 grammar 来使测试通过。测试不是用户配置迁移；真正无法表达的调用保持无模式增强。其他不属于 nativeCommands 的 `Write-Output`/shell rule 测试无需改动。

完成证据：真实组件 handler 到两层持久化的 round-trip，新接口仍保护原有权限与事务边界。新增旧格式拒绝测试属于输入安全合同；不添加旧组件消失测试、文档字符串锁或环境快照锁。

## 定向验证与隔离验收

worker 只跑其改动对应的轻量检查；main 汇总受影响证据。所有命令从 `dsmm/` 运行，不使用 `pnpm test`、测试文件通配符或 root 全套。

```powershell
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/permission-native-command.test.ts test/permission-control.test.ts test/permission-command-pattern.test.ts
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 --test-name-pattern='^command patterns:' test/client-permission-config.test.ts
```

调整过的表单用例统一纳入 `command patterns:`，保留其他事务用例。补跑上表其他文件中实际受影响的具名用例，以 `--test-name-pattern` 精确选择：managed shell 的模式 ask/allow、same-level、原生批准目标/不可转借；regressions 的当前身份撤销与 child never；managed tools 的 pre-Core；deployment 的 direct-file/whole-array、Host cwd；client 的结果解码。依赖共享 `commandEntry` 的有效用例一并覆盖；不得仅以类型检查代替它们的行为证据。

main 在实现汇合后集中执行：

```powershell
pnpm run typecheck
pnpm run build
pnpm exec tsc -p tsconfig.test.json --noEmit
```

不调用会再次 build 的 `typecheck:test`。build 后使用现有隔离 browser harness（`test/client-deployment-core-browser.test.ts` 的生产页面、Gateway、SettingsForms 路径）补充模式输入、非法草稿锁定、保存权威读回及 Unset 的实际操作；只用已存在并明确指定的 `DSMM_TEST_DSH_ENTRY`/`DSMM_TEST_PLAYWRIGHT_ENTRY`，不可用或 skip 必须报告为未验收，不安装补齐。handler 测试不冒充渲染浏览器验收，现有 harness 也不冒充登录 E2E。

真实 round-trip 使用独立临时 workspace、DSH_HOME/DSH_AGENTS_HOME、浏览器 profile 和仅本任务拥有的服务/端口，不触及日常用户配置。验证模式配置保存后的匹配调用进入原始 body、审批次数与 sandbox policy，以及不支持 shell 不获增强。受控 fixture 的 body 计数和 PowerShell argv 探针不能证明真实 confinement；复用现有隔离 Host 验收中仍覆盖当前行为的证据，只补缺失面，不重复整个验收。

严禁同 session ID 新 parent/旧 child descriptor 探针及变体、未筛恢复集、Cargo/LSP 验证。清理仅限本任务资源，终止进程核对 PID 与启动身份；临时诊断脚本、截图、报告不保留，结果在对话交接。未修改且仍适用的通过证据直接复用，相关失败不能忽略、压制或以旧证据覆盖。

## 完成与提交边界

唯一接口在配置、运行时、UI 和有效测试中一致；非法存量格式明确失败且不扩大授权；定向安全/事务回归、集中 typecheck/build/test types 和隔离 browser/round-trip 均有相应证据或明确阻塞。隔离验收完成后由 main 按用户授权提交本次约定范围，保留无关工作树内容，不单独提交计划；worker/planner 不执行 Git 写操作，提交授权不包含 push/tag/release。
