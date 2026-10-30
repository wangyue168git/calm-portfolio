# 长桥（Longbridge / LongPort）自动同步

用长桥官方 OpenAPI 的 Node SDK（npm 包 `longport`），只读查询**当前持仓**和**今日成交**。不需要额外运行任何网关程序。

> 看板只调用查询接口，不会下单；但长桥的令牌本身可能带交易权限，请妥善保管 `.env`，不要提交到任何仓库。

## 第 1 步：拿到三把钥匙

1. 用长桥账号登录 **长桥开放平台**（LongPort OpenAPI 开发者中心），按提示开通 OpenAPI。
2. 在个人中心 / 应用凭证里拿到：
   - **App Key**
   - **App Secret**
   - **Access Token**（有有效期，到期要重新生成；记下到期日）

具体菜单名称以长桥开放平台当前页面为准。

## 第 2 步：安装 SDK

SDK 带原生模块、体积较大，所以没有放进默认依赖，要用时单独装：

**直接用 Node.js 运行时**，在项目目录：

```bash
npm install longport
```

**用 Docker 时**，把 `docker-compose.yml` 里的 `EXTRA_PACKAGES` 改成 `longport`，然后：

```bash
docker compose build && docker compose up -d
```

（镜像基于 Debian slim；长桥 SDK 不支持 Alpine。）

## 第 3 步：填 `.env` 并重启

```bash
LONGBRIDGE_APP_KEY=...
LONGBRIDGE_APP_SECRET=...
LONGBRIDGE_ACCESS_TOKEN=...
LONGBRIDGE_TOKEN_EXPIRES=2027-01-30   # Access Token 到期日，到期前 30 天提醒
LONGBRIDGE_SYNC_ACCOUNT=长桥           # 看板里的账户名，要先在页面上建好
LONGBRIDGE_SYNC_DRYRUN=1              # 先试运行，确认没问题改成 0
```

### 美股、港股放在不同账户

看板里一个账户只有一个币种。如果你在长桥同时持有美股和港股，建议在看板建两个账户（比如「长桥美股」USD、「长桥港股」HKD），然后：

```bash
LONGBRIDGE_ACCOUNT_US=长桥美股
LONGBRIDGE_ACCOUNT_HK=长桥港股
LONGBRIDGE_ACCOUNT_CN=          # A 股通，不填就放进 LONGBRIDGE_SYNC_ACCOUNT
```

## 同步规则

和 IB 一样（见 [ib.md](ib.md) 的「同步规则」），区别是：

- 长桥的持仓是**实时**的：美股、港股、A 股任一市场开盘期间，每 10 分钟拉一次成交和持仓；休市时每 6 小时对一次账。
- 代码会自动转换：`AAPL.US` → `AAPL`，`700.HK` → `00700`，`600519.SH` → `600519`。
- 长桥成交里不含佣金，记录里的成交价不含费用；每天的持仓对账会把成本纠正成长桥给的成本价。
- 成交记录备注 `LB#成交编号`，持仓纠偏备注「长桥自动对账」。

## 常见问题

| 页面提示 | 处理 |
|---|---|
| 未安装长桥 SDK | 按第 2 步安装后重启 |
| 长桥令牌无效或已过期 | 到开放平台重新生成 Access Token，替换 `.env` 并更新到期日 |
| 找不到账户「…」 | 账户名要和看板里的完全一致，先在页面上建好 |
