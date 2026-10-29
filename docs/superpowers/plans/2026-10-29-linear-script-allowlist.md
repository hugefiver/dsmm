# 线性脚本命令白名单

## 最终行为

设计重点是避免大模型常见的工具误用和操作范围误判，并提供基本权限控制，而不是严格阻断所有可能的越权方式。有限语法识别和风控检查应服务于这一目标，不扩展为完整 shell 安全分析器；保留本计划明确的权限边界及未识别输入回退行为。

在 `permissionControl.nativeCommands.enabled` 生效时，对有限可识别的线性脚本逐成分评估：**每个成分都没有适用的现有 DSMM 风控约束，或者命中字符串白名单，则为整次调用授权 `danger-full-access`。** 不要求至少一次白名单命中；字符串条目为空、全部成分均无风控匹配时也成立。

“无风控匹配”不是安全、只读或已知程序证明。静态可识别的未知程序、Git 未分类子命令、别名或解释器，只要现有规则没有约束，也满足此条件。不新增正向安全命令集合、不新增风险分类、不扩大既有分类器覆盖。**语法不能完整拆分**与**命令未被现有风险分类器识别**必须区分：前者整段回原路径，后者按现有规则的实际结果处理。

字符串白名单对 DSMM Git、方言安全、exact shell、outside-read、legacy 命令规则维持既有优先级；受控成分命中白名单仍可授权，包括 DSMM `deny`。原生或第三方 deny、native `approval.policy=never`、角色/工具权限上限、真实调用身份及取消不能越过。无精确执行关联的外层审批仍由 native 处理。

保留旧整句 `simpleCommandMatch`、legacy 对象格式及普通路径、默认关闭、一次调用授权与 native 最终答复合同。不改变 standing sandbox，不保存跨调用授权，不分次执行或改写原脚本。无法拆分、有未覆盖的受控成分或资格评估不可用时，不产生新授权，交回原流程，不新加 ask/deny。保持包名、版本、DSH `0.2.1-rc.2`、Host/原生执行器所有权、UI 和配置格式；不安装依赖，不提交。

## 有限语法

新增完整识别入口 `src/permission-linear-script.ts:parseLinearScript(command, dialect)`，返回带原文范围及 literal words 的只读成分序列，或 `undefined`。不构造完整 AST，不执行命令探测语义，不用宽松 `parseShellCommand` 的 words 重建“净化”后的输入。

- 成分沿用 `literalCommand(..., dialect, "simple")` 的静态 token、引号、Unicode、空参数规则。
- 分隔符支持引号外 `;`、LF/CRLF、`&&`、`||`、单个 `|`；检查所有链分支和管道级，不推测短路结果。允许首尾空行、末尾分号、分号后换行；链/管道必须具有两端成分，允许操作符后的普通换行。
- 支持引号外 POSIX 反斜杠紧接 LF，以及 token 边界处 PowerShell backtick 紧接 LF/CRLF 的续行；POSIX 反斜杠紧接 CRLF、PowerShell token 内转义换行整段回原路径，不依赖执行器的 CRLF 容错或将 PowerShell 换行视为 POSIX token 拼接。续行只影响解析视图，最终执行保留原文。引号中的 `;`、`|`、`&&` 不拆分，其他引号/转义行为保持现有 literal 合同。
- 控制流、函数、分组/代码块、展开/替换、glob、注释、here-doc/here-string、重定向、后台 `&`、PowerShell call operator/dot-sourcing、`--%`、智能引号、不支持的转义、未闭合引号、`;;`、悬空操作符和空脚本不获新增识别结果，继续原路径。
- 本次不扩展环境赋值或状态跟踪：`X=value command`、独立赋值、`$env:X = 'value'; command` 继续原路径。静态 `env ...`、`node -e '...'`、`bash -c '...'` 可作为普通 literal 成分；不递归解析解释器代码，也不把被包装命令的白名单继承给 wrapper。现有 Git 分类器自身支持的 `env` 解包仍照常参与风险检测。

先尝试旧整句匹配；新增评估面向具有上述连接/续行结构的脚本，不顺带改变旧未命中的普通单命令。保持 legacy `literalCommand`、`nativeCommandMatches` 和既有 Git tokenizer 的原合同。扫描随文本长度线性增长，不引入 parser 依赖或通用策略框架。

## 风控评估与规则归属

资格计算使用同一调用的实际 dialect、shell identity、tool/cwd 字段、当前规则 snapshot，以及实际 Agent 的有效 settings、scope、Deepwork 状态。只评估已有约束，不执行工具或递归调用 pre-execute。风控命中指已有 `ask`/`deny` 或不能自动采用的 legacy sandbox 歧义；`allow`/`inherit` 本身不是新增风险约束。下表均受既有 standing mode 语义约束：Full access 的 guard 仅贡献适用的 Git deny，不贡献方言安全或 Git ask；native rules 保留确定 blacklist 而非未知读取 deny，exact/legacy ask 不产生约束。

| 来源 | 对成分的评估及归属 |
| --- | --- |
| 自动 Git | 对每个成分原文调用 `src/shell-command.ts:evaluateGitCommand`，沿用 `src/guards.ts` 的 `isSafetyScopeActive`、`gitWriteGuard` 和 `gitWriteScope` 筛选。`off`/未激活 scope 无贡献；`high-risk` 仅保留现有 high-risk 动作；ask/deny 均使对应成分受控。所有动作共用原分类器，不复制动作表、不将 `reusable` 当授权条件。 |
| shell 方言安全 | 按现有 scope、`shellCommandSafety` 和 `classifyShellDialectViolation` 检查成分；只保留已有四类违规，不另加 shell 危险命令列表。已被有限语法排除的形式走原路径。 |
| exact shell rules | 对成分候选仍做完整字符串等值匹配：实际 shell executable、该成分原文和实际有效 cwd；只考虑未撤销规则。此投影仅用于新增脚本的资格计算，不修改普通路径 matcher。另按原规则检查整段原始 command：整段 ask/deny 命中覆盖所有成分，因而必须每个成分都命中字符串白名单才能覆盖该约束。不得拆开规则的 command、使用包含/前缀匹配，或以单个成分白名单覆盖整句规则。 |
| outside-read | 复用 `src/permission-native-rules.ts` 的实际 deny 判定及 `permission-shell.ts` 的能力/路径逻辑，分别评估成分和原整句。成分约束归该成分；整句因组合语义或未知路径产生的原有约束覆盖全部成分。保留 trusted capability、FS/co-location、standing mode 和未知事实处理；不把标准 Core 缺少 `readCapability` 改造成可信读取，也不凭缺事实新增规则之外的 deny。现有 outside-read ask 不贡献读取审批。 |
| legacy 对象条目 | 在成分候选上复用 `nativeCommandMatches` 的实际 tool、有效 cwd、静态匹配、ask 优先及 sandbox 歧义规则；整句仍按原 matcher 检查。ask/歧义是相应范围的约束，字符串白名单可覆盖；对象条目本身不当作字符串白名单或被转换、丢失条件。未获新增授权时完整走旧 legacy 流程。 |

成分候选的 command 取原文片段，只去除连接处 ASCII 空格/tab 和作为分隔符的换行，不从 words 重新序列化；成分 exact 匹配不剥除内部续行，也不将语义相近文本视为相等。整句匹配始终使用未经裁剪的原 command。全段匹配的规则只作为全段约束，不静默扩展成对子串的匹配。

`classifyPermissionShell` 的效果标签不是风险政策：`localWrites`/`destroys` 不自动贡献 ask/deny，`unknown` 不单独拒绝或放行，应使用调用它的既有规则判定。Git 空结果只表示无自动 Git 约束，仍须汇总其他适用规则。webSearch/webFetch 规则仍只覆盖对应原生工具，不推断 shell 网络访问。

仅使用现有入口实际具有的身份与规则适用范围。stock shell 没有 managed native-rule identity 时，不凭工具显示名伪造该 identity 或添加 managed-only 约束；保留现有 stock/managed 所有权边界。真正的资格评估失败与规则对未知事实已有的确定处理不同：不能吞掉 refresh/身份/FS评估错误并伪装成“无规则”。

对非空成分集合 `C`，最终条件为：对每个 `c`，`whitelisted(c) || constraints(c).length === 0`。原整段约束已归入其覆盖的所有成分。某成分有多个约束时，命中字符串白名单覆盖该成分上的全部 DSMM 约束；任一未覆盖约束使整段回原路径。无需新增用户决策。

## 实施波次与接口

### 1. 有限拆分及模式复用

实现上述 `parseLinearScript`；在 `src/permission-native-command.ts` 抽取必要的 literal words 前缀匹配供旧单句与新脚本共用。保持 `parseSimpleCommandPattern`、大小写、位置及 PowerShell executable `.exe` 等价规则，不改 legacy 模式语法。

在 `test/permission-linear-script.test.ts` 和 `test/permission-native-command.test.ts` 验证成分原文、完整 words、引号/操作符边界和失败回退。保留旧单句与 legacy 行为覆盖，不通过修改旧 matcher 的语义实现新入口。

### 2. 规则汇总与一次调用授权

涉及 `src/permission-controller.ts`、`src/guards.ts`、`src/permission-native-rules.ts`，按接线需要涉及 `src/core-permissions.ts`、`src/index.ts`。controller 负责在同一调用快照下汇总成分/整句约束；guard 与 native-rule 所有者提供最小的无执行副作用评估能力。复用既有 evaluator，尤其保留 Git scope、exact rule 交集和 outside-read 未知处理，不建立第二份设置源或猜测工具身份。

有效 guard 配置必须来自现有 `DsmmSettingsGetter` 与 scope controller，不能硬编码全局默认值。原有 hook 顺序包含多次 `simpleCommandAllowed` 探测，接线不能依赖“某个 hook 已先运行”或用 `simple` 状态跳过资格计算；测试两种注册顺序。必要的纯评估提取不改变普通路径结果。

只有完整资格成立后才调用已有 `PermissionControl.compose(..., true)` 创建本次授权。不得在检查部分成分时提前创建 binding；无需新增一套“脚本 deny 优先”分支。成功后沿用 simple 对 DSMM rules 的优先级与 native answerer/run 机制，不增加审批 UI、持久化或授权记忆。

保留 refresh 前捕获及 await 后校验真实 Agent/realm、owner、registration/body、arguments、token、callId、signal 和 cwd；全脚本决策不能转借给后续调用或替换参数。未来调用采用当前策略；不新增配置 epoch 门禁去否定实际 native 已批准的同次调用。

### 3. 调用验收与说明

扩展 `test/permission-simple-command.test.ts`、`permission-native-rules.test.ts`、`permission-managed-shell.test.ts`、`guards.test.ts`，复用 `permission-fixture.ts`。保留 `shell-command.test.ts`、`git-command-approval.test.ts` 对既有分类及记忆的回归，不为了新资格判断改变它们的政策。

复用 `test/native-readonly-shell.test.ts` / `native-readonly-shell-fixture.ts` 的隔离环境验证真实 stock/managed bash/pwsh、read-only 角色与原生权限。补充无害脚本/marker，不在项目仓库执行 Git 写操作。更新 `docs/native-permissions.md`、`docs/safety-guards.md` 的最终语法、逐成分授权及优先级，不声称任意命令安全或 OS confinement。

## 必需验收用例

- **完整拆分**：分号、LF/CRLF、链、管道、续行；引号内分隔符、空参数、Unicode、方言引号差异；后部受控命令不能被前面的普通命令或短路条件隐藏。不支持语法不仅 parser 失败，还须证明实际保持旧 native 路径。
- **零白名单命中**：enabled 且 entries 为空，无适用 DSMM 约束的 `echo one; echo two` 授予本次 full access；静态未知程序和未知 Git 子命令在没有其他约束时也按相同规则处理，不新建安全名单。关闭 nativeCommands 则无增强。
- **混合脚本**：白名单 `git commit` 下，`echo before; git commit -m owned; echo after` 在 Git ask/deny 下均可新增授权；换为未覆盖的 `git push` 则整段回原路径。覆盖 `all-writes/high-risk`、`ask/deny/off` 与 scope 开关的真实差异。
- **exact 规则**：针对成分 command 的 ask/deny 按等值投影识别，其成分命中白名单可覆盖；针对完整脚本的 ask/deny 需要所有成分白名单覆盖。相近字符串、不同 cwd/executable、撤销规则不匹配；一个成分获白名单不能覆盖另一成分或全段约束。普通单命令 exact 匹配不变。
- **outside-read 与 legacy**：覆盖实际 deny、已有未知事实 deny、无约束及评估失败；受约束范围全部在字符串白名单中仍能授权。legacy 的 tool/cwd、ask、allow、歧义不被转换或丢失；未获新增授权的调用继续原对象规则处理。
- **wrapper 与未知**：`env git push` 仍接受现有 Git 检测，白名单 `git push` 不自动匹配 wrapper；静态解释器不递归解析内部字符串。效果 `unknown` 在有/无既有 outside-read deny 时遵循不同的现有规则，不一律拒绝或安全化。
- **实际授权结果**：stock/managed 成功用例观察原脚本、body 只启动一次、本次 `danger-full-access`、无交互答复及 standing mode 未变。不能仅以 `isError: false` 证明增强，普通路径也可能成功。
- **不可跨越边界**：native/第三方 deny、never、read-only 角色、工具过滤、取消和失效身份阻止执行；无精确关联的 outer ask 保留 native 处理。并发共用 callId、后续未获准调用、其他 Agent/child、registration/body 替换、refresh 期间参数/owner 改变及 retirement 不得借用授权。失败不留下部分 binding，实际 native 已批准调用的最终性保持原合同。

## 验证与技术难点

局部只跑改动对应测试；主流程在 `dsmm/` 汇总以下检查，测试串行，不默认执行全诊断：

```powershell
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/permission-linear-script.test.ts test/permission-native-command.test.ts test/permission-simple-command.test.ts
pnpm run typecheck
pnpm run build
pnpm exec tsc -p tsconfig.test.json --noEmit
pnpm run test:module -- permissions
pnpm run test:integration -- native-runtime
```

主要技术难点是：有限词法不遗漏尾部成分；原文 exact 匹配与成分/整句约束归属；从真实 guard/native 所有者获取一致配置而不引入 hook 顺序依赖；复用 outside-read 异步判定且不混淆原有 unknown 结果与评估错误；一次调用授权在异步刷新和 registration 生命周期中的完整性。这些需要上述定向行为证据，不是新权限政策的理由。

真实 shell/Host 覆盖仅使用现有安装和明确 DSH anchor。缺失环境、skip 或 harness 未进入目标场景均报告为未覆盖，不能用 mock specs 或 typecheck 代替。观察真实顺序/管道输出、marker 及拒绝时未执行；清理仅限本任务资源。未变更 UI/配置格式/包交付，无需 browser/delivery 组或角色重新生成。保留工作树无关改动；完成以语法成功/回退、零白名单及混合授权、旧单句/legacy 兼容和原生权限边界的有效证据为准，不以单条成功日志为准。
