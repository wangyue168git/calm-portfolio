# Interactive Brokers（IB）自动同步

用 IB 官方的 **Flex Web Service**：一个只读令牌 + 两个报表查询。看板定时拉报表，把新成交和持仓变化写进去。令牌只能读报表，**不能下单、不能出入金**。

整个配置都在 IB 网页后台完成，大约 10 分钟。

## 第 1 步：建「持仓」查询（活动 Flex 查询）

1. 登录 IB 网页后台（Client Portal），进入 **业绩与报表（Performance & Reports）→ Flex 查询（Flex Queries）**。
2. 在 **活动 Flex 查询（Activity Flex Query）** 一栏点 **+** 新建。
3. 查询名称随便填，比如 `calm-positions`。
4. **区块（Sections）** 里只勾 **未平仓头寸（Open Positions）**：
   - 选项（Options）选 **汇总（Summary）**，不要选逐批（Lot）；
   - 字段最省事的做法是点 **全选（Select All）**。只想勾必要字段的话，至少要有下表这些。
5. **交付配置（Delivery Configuration）**：
   - 格式（Format）：**XML**
   - 期间（Period）：**上一个营业日（Last Business Day）**
6. **常规配置（General Configuration）**：日期、时间格式保持默认即可（看板能识别 `yyyyMMdd`、`yyyyMMdd;HHmmss` 等常见格式）。
7. 保存，记下这个查询的 **查询编号（Query ID）**，一串数字。

| 界面上的字段（大致名称） | 报表里的属性名 | 用途 |
|---|---|---|
| Symbol | `symbol` | 代码 |
| Conid | `conid` | IB 合约编号，用来区分同名代码 |
| Asset Class | `assetCategory` | 只同步股票/ETF（STK） |
| Currency | `currency` | 币种 |
| Quantity | `position` | 持仓数量 |
| Cost Basis Price | `costBasisPrice` | 每股成本 |
| Level of Detail | `levelOfDetail` | 区分汇总/逐批 |

## 第 2 步：建「成交」查询（交易确认 Flex 查询）

1. 同一页面，在 **交易确认 Flex 查询（Trade Confirmation Flex Query）** 一栏点 **+**。
2. 名称比如 `calm-trades`。
3. 区块勾 **交易确认（Trade Confirmations）**，字段同样建议 **全选**。至少要有：

| 界面上的字段（大致名称） | 报表里的属性名 | 用途 |
|---|---|---|
| Symbol / Conid / Asset Class / Currency | 同上 | |
| Buy/Sell | `buySell` | 买卖方向 |
| Quantity | `quantity` | 成交数量 |
| Price | `tradePrice` 或 `price` | 成交价 |
| Commission | `ibCommission` 或 `commission` | 佣金（会摊进成本） |
| Trade ID（或 Exec ID） | `tradeID` / `execID` | 成交编号，用来去重 |
| Date/Time（或 Trade Date） | `dateTime` / `tradeDate` | 成交时间 |

4. 交付配置：格式 **XML**，期间 **今天（Today）**。
5. 保存，记下查询编号。

> 两个查询不必都建。只建持仓查询也能用（每天对一次账）；只建成交查询则只追加买卖记录。

## 第 3 步：生成 Flex Web Service 令牌

1. 在 Flex 查询页面找到 **Flex Web Service 配置（Flex Web Service Configuration）**，点进去。
2. 打开 **Flex Web Service 状态**。
3. 生成 **当前令牌（Current Token）**，有效期可以选，最长一年左右。
4. **强烈建议** 填 **IP 限制**，只允许你的服务器公网 IP。这样令牌泄露了别人也用不了。
5. 复制令牌，记下到期日。

## 第 4 步：填进 `.env` 并重启

```bash
IB_FLEX_TOKEN=你的令牌
IB_FLEX_POSITIONS_QUERY=持仓查询编号
IB_FLEX_CONFIRMS_QUERY=成交查询编号
IB_SYNC_ACCOUNT=IB              # 看板里对应的账户名，要先在页面上建好（币种 USD）
IB_FLEX_TOKEN_EXPIRES=2027-10-30 # 令牌到期日，到期前 30 天手机端会提醒
IB_SYNC_DRYRUN=1                # 先试运行：只记录会改什么，不写持仓；确认没问题再改成 0
```

重启后，手机端首页底部会出现「IB 同步 · 等待首次运行」，几分钟内变成「IB 已同步 hh:mm」。

## 同步规则

- **成交**：美股交易时段（含盘前盘后）每 10 分钟拉一次，新成交追加为买入/卖出记录，备注 `IB#成交编号`。你已经手动记过的不会重复记。
- **持仓**：北京时间周二到周六早上 9 点后拉一次，和**上次从 IB 拿到的数**比较，有变化才追加一条纠偏记录。IB 的日结报表有时 9 点还没出，这时会提示「报表未更新」，4 小时后再查。
- **第一次运行只记基线**，不改任何持仓。
- **你手动改过的数不会被改回去**：比较的是 IB 前后两次的数，不是看板当前的数。
- IB 里清仓了、看板里还有：不自动删，只在状态里提示。
- 同一只股票在 IB 之外还有一部分（比如别的平台），用 `IB_SYNC_EXTRA=代码:股数:成本` 告诉对账程序，见 `.env.example`。

## 常见问题

| 页面提示 | 原因和处理 |
|---|---|
| IB 令牌已过期（1012） | 到 Flex Web Service 配置里重新生成令牌，替换 `IB_FLEX_TOKEN`，并更新 `IB_FLEX_TOKEN_EXPIRES` |
| IP 不在令牌允许范围内（1013） | 服务器公网 IP 变了，或 IP 限制填错了 |
| 查询编号无效（1014） | 检查两个查询编号是否填反、是否复制完整 |
| 请求太频繁被限流（1018） | IB 限制约每秒 1 次、每小时有上限，看板会自动稍后重试，不用管 |
| 连接 IB 超时 | 国内部分网络解析 IB 域名有问题，看板已内置绕行；仍不行请检查服务器能否访问境外 |
