# 显式选择 Fake-IP HTTP fetch

`@dsmm/dsmm/web-fetch-fakeip` 是独立 Cordis 插件，向原生 `ctx.web` 注册唯一 fetch provider ID `dsmm-http-fakeip`。它使用 rc.2 包根公开的 `new HttpFetchProvider(limits, resolver)`，不替换 WebRuntime，不注册 `http`，不改变 Search、工具审批、凭据或系统网络。只有用户主动挂载并选择该 provider 时才应启用；不要将它加入 DSMM 默认插件组合。原生 `http` 和 shell 的网络限制不因此得到修复。

## 集成与选择

DSMM 包必须具备以下依赖和发布入口，才能使用此插件：

- 运行依赖 `@deepseek-ai/dsh-web-fetch-http: 0.2.1-rc.2` 和 `ipaddr.js: ^2.5.0`。
- Host seam `@deepseek-ai/dsh-web: 0.2.1-rc.2`、`@deepseek-ai/dsh-http-proxy: 0.2.1-rc.2` 作为 peer 和开发依赖。保留现有 Cordis/timeout peers；不要另装一套 Host service。DSMM 与原生 HTTP provider 必须解析到 Host 实际使用的同一个 `dsh-http-proxy` 实例，否则预检读不到已安装的进程路由。
- 包 export `./web-fetch-fakeip`，types 指向 `./lib/web-fetch-fakeip.d.ts`，default 指向 `./lib/web-fetch-fakeip.js`。构建也需包含其内部 `web-fetch-address-policy.js`。包的 `files` 应包含本说明和来源许可证。

在用户所选原生 profile 的 patch 中显式挂载该入口，并修改原有 web service 的 `fetchProvider`（保留其真实 entry ID 和其他配置）：

```yaml
- id: web
  config:
    fetchProvider: dsmm-http-fakeip
- insert:
    - id: dsmm-http-fakeip
      name: '@dsmm/dsmm/web-fetch-fakeip'
      config: {}
```

这不是默认 bundle patch。若实际 web entry 不叫 `web`，使用该 profile 的实际 entry ID，不要新增第二个 web service。也可以通过原生 `DSH_WEB_FETCH_PROVIDER=dsmm-http-fakeip` 选择，但仍须显式挂载插件，并考虑原生 profile 配置的优先级。仅挂载而不选择是不安全的配置习惯：原生 WebRuntime 在只有一个可用 provider 时会自动选择它；存在多个 provider 且未选择时会报歧义。卸载插件会由原生 registry 撤销注册。

配置项为 `maxResponseBytes`（默认 5,000,000）、`maxBodyChars`（100,000）、`timeoutMs`（30,000）、`maxRedirects`（5）、`userAgent`（原生默认值）和 `denyCidrs`（空数组）。字节/字符/超时限制必须为正有限数，超时不超过 Node timer 范围；重定向上限必须为非负整数。

`denyCidrs` 只增加本地拒绝，例如 `['198.18.0.1/16', '8.8.8.0/24']`；主机位不扩大 CIDR，前一项等价于拒绝固定 `198.18.0.0/16`。mapped IPv6 和对应 IPv4 的拒绝相互覆盖。没有任意 allow-CIDR 配置：唯一例外固定为 `198.18.0.0/16`，不是 `/15`，不是其他私网。

## 地址与代理边界

- 系统 DNS 使用 `all: true, order: 'verbatim'`。完整答案必须非空，每项 family 和地址须有效；任一地址被拒绝即拒绝整个请求，不筛掉坏答案继续连接。
- 允许公网 unicast 和精确 Fake-IP `/16`；mapped IPv6 按内嵌 IPv4 判断。显式 deny 优先，loopback、私网、链路本地、`198.19.*` 及原生 transition/NAT64 特殊地址继续拒绝。
- IPv6 答案使用 RFC 7050 的 `ipv4only.arpa` 识别 RFC 6052 `/32 /40 /48 /56 /64 /96` 前缀，校验内嵌目的地址。发现失败、空答案或不能识别的发现答案均不放宽。内嵌 IPv4 不继承 Fake-IP 例外，显式 deny 同样生效。
- DNS 等待可以被取消；OS 中已经启动的 lookup 可能自行结束，但其结果不会被已取消请求使用。原生 provider 保持 deadline 的 timeout/caller-abort 分类。
- 入口通过公开 `proxyRouteFor()` 读取原生实际路由，不自行解释环境变量，不安装或修改代理。应走代理的 Fake-IP 或 mapped Fake-IP literal 在调用原生 provider **之前**拒绝（`WEB_FAKEIP_PROXY_UNSUPPORTED`），因为 rc.2 自带 literal 分类器会让它们跳过代理、意外直连。每次原生 resolver 调用再次预检；跳过 resolver 的代理分支不受该预检保护。
- 未配置额外 deny 的代理域名仍交给原生代理分支，由代理解析 DNS；本地 resolver 不会执行，**不承诺代理远端 DNS 满足本地地址策略**。这不是完整本地 SSRF/DNS 校验路径。需要这项保证时必须使用可控的代理策略或原生明确直连路由，不能把此插件视为修复远端 DNS。
- 配置 `denyCidrs` 时，域名若走代理就 fail closed，不隐式改直连。已知允许的 IPv4 literal 可走原生代理；其地址 deny 在入口执行。代理 IPv6 literal 保守拒绝（mapped 公网 IPv4 除外），避免代理分支跳过本地 NAT64 检查。
- 存在本地 deny，或请求目标是非 mapped IPv6 literal 时，重定向一律由原生零 hop 上限拒绝（`WEB_REDIRECT_BLOCKED`）。公开 resolver seam 不能检查后续跳转的代理分支，且进程路由可能在 DNS64 发现或响应期间变化；零跳限制确保本地 deny 和 IPv6 literal NAT64 检查不被跳过。无额外 deny 的域名、IPv4 和 mapped IPv4 literal 保留配置的原生同源重定向上限。

## 原生传输与验证范围

验证后的地址集合直接交给原生 transport，不伪造公网 DNS 答案，也不重写 URL。原生负责 pinned lookup、HTTP Host、TLS SNI、每次直连同源跳转的重新解析、跨 origin 拒绝、URL scheme/credentials、响应类型/字符集、字节/字符上限、非 2xx 结果、取消和 body/dispatcher 释放。此插件不另造 Undici transport。

定向检查（从 `dsmm` 目录，依赖集成后执行）：

```powershell
node --test --experimental-strip-types --import ./test/prompt-source-loader.mjs --test-concurrency=1 test/web-fetch-address-policy.test.ts test/web-fetch-fakeip.test.ts
```

地址测试注入 DNS，保护精确网段两端、混合答案、mapped IPv6、NAT64、deny 和取消。注册/预检测试通过原生 WebRuntime 和真实公开代理策略检查消费链，其中替换 native `fetch` 的用例仅证明委托/调用前拒绝，不证明网络连通。

动态路由回归使用已安装原生 provider、公开进程代理策略和禁止网络连接的 Undici MockAgent，检查 DNS64 期间切换代理后 IPv6 literal 重定向没有第二跳 dispatch，并检查其他允许目标保留同源重定向。该证据是路由/dispatch 行为验证，不是代理或 Fake-IP wire 连通证据。

原生 HTTP 集成用例使用**刻意注入 loopback 答案**连接任务自有本地服务器，检查 pinned hostname/Host、同源重解析、跨源拒绝、大小上限和非 2xx。该测试不是生产策略，不证明 Fake-IP 网段的真实路由。TLS SNI 和真实 `198.18/16` wire 连通需要已有隔离网络/TLS 能力的另行验收；没有这种证据时只能说明 resolver/委托实现，不能宣称 Fake-IP wire 或整个网络需求完成。不改系统路由、Clash、凭据或未知 shell 拒绝层来取得测试通过。

## 来源与许可

地址分类及 RFC 6052/7050 提取逻辑改编自 DeepSeek 官方 tag `dsh-v0.2.1-rc.2` 的 [`packages/web/web-fetch-http/src/network.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/web/web-fetch-http/src/network.ts)，通过公开 `ipaddr.js` 使用，不导入 SDK 私有路径。

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
