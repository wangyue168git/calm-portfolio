# 自己写券商适配器

内置的只有 IB 和长桥。别的券商只要能用代码拿到持仓（官方 API、本地网关、定时导出的文件……），就可以写一个**适配器**接进来。对账、去重、「手动修改不被覆盖」、页面状态提示这些都由看板处理，适配器只负责「拿数据」。

最简单的起点是 [`examples/broker-adapter.example.js`](../../examples/broker-adapter.example.js)：它定时读取一个 CSV 文件当作券商持仓，三十几行。

## 启用

```bash
# .env, 多个用逗号分隔; 相对路径按项目目录算, Docker 里建议放数据目录用绝对路径
BROKER_ADAPTERS=/data/brokers/my-broker.js
MYBROKER_SYNC_ACCOUNT=我的券商     # 写进看板的哪个账户(<ID 大写>_SYNC_ACCOUNT), 要先在页面上建好
MYBROKER_SYNC_DRYRUN=1            # 先试运行
```

加载失败（语法错误、缺 id、和内置券商重名）只会在日志里报错，不影响看板其他功能。

## 文件要导出什么

导出一个 `create(env)` 函数，返回适配器对象（也可以直接导出对象）：

```js
exports.create = (env) => ({
  id: "mybroker",           // 必填。小写字母开头, 只含小写字母/数字/-/_; 状态文件叫 mybroker-sync-state.json
  label: "我的券商",          // 页面状态行显示的名字
  configured: !!env.MYBROKER_TOKEN,   // 配置不全时返回 false, 整个同步不启用
  tokenExpires: env.MYBROKER_TOKEN_EXPIRES || "",   // 可选, YYYY-MM-DD, 到期前 30 天提醒
  markets: ["us", "hk"],    // 可选, 在哪些市场交易时段拉数据: us / hk / cn, 默认 ["us"]
  positionsDaily: false,    // 可选, true = 持仓是日结报表(每天北京时间 9 点后拉一次); false = 实时
  tag: "MB#",               // 可选, 成交记录备注前缀, 默认 "<label>#"
  reconNote: "我的券商对账",  // 可选, 持仓纠偏记录的备注

  // 二选一或都提供
  async fetchPositions() {
    return {
      positions: [
        { symbol: "AAPL", qty: 10, cost: 180.5, name: "苹果", market: "nasdaq" },
        { symbol: "00700", qty: 100, cost: 380, market: "hk", account: "港股账户" },
      ],
      statementDate: "",    // 可选, 日结报表的日期 YYYYMMDD; 和上次一样时会提示"报表未更新"并稍后再查
    };
  },
  async fetchConfirms() {
    return [
      { id: "T123", symbol: "AAPL", side: "buy", qty: 2, price: 181, commission: 1, date: new Date("2026-10-30T14:00:00Z") },
    ];
  },
});
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `symbol` | ✓ | 看板里的代码：美股如 `AAPL`，港股 5 位如 `00700`，A 股 6 位如 `600519` |
| `qty` / `cost` | ✓（持仓） | 股数、每股成本（账户币种） |
| `id` / `side` / `qty` / `price` / `date` | ✓（成交） | 成交编号（用来去重，必须稳定）、`buy`/`sell`、数量、价格、`Date` 对象 |
| `commission` | | 佣金，会摊进成本 |
| `key` | | 持仓的唯一标识，默认用 `symbol`；同一代码可能出现在多个子账户时才需要 |
| `account` | | 写进看板哪个账户，不填用 `<ID>_SYNC_ACCOUNT` |
| `market` | | 新建持仓时用：`nasdaq` / `nyse` / `hk` / `sh` / `sz`，默认 `nasdaq` |
| `name` | | 新建持仓时的名称 |

### 出错怎么报

直接 `throw new Error("说明")`，页面状态行会显示「我的券商 同步异常 ›」，点开能看到你的说明。

如果是要人处理的问题（令牌过期、没装依赖），给错误加 `err.hard = true`：重试间隔会拉长到 1 小时，避免反复请求。

## 原则

- **只读**：只调用查询接口，不要在适配器里下单、撤单、转账。
- **不要把密钥写进文件**：从 `env` 读，放 `.env`。
- 同一个券商的请求是串行的，不用自己处理并发；有频率限制的接口自己在 fetch 里加间隔。
