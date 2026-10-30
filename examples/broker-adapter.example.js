"use strict";
// 自定义券商适配器示例: 定时读取一个 CSV 持仓文件当作"券商持仓"。
// 适合: 你用别的办法(券商自带的定时导出、自己写的脚本、富途 OpenD 脚本……)把持仓写成 CSV, 看板自动对账。
//
// 用法:
//   1. 复制本文件到数据目录, 比如 data/brokers/csv-file.js(Docker 里就是 /data/brokers/csv-file.js)
//   2. .env 里加: BROKER_ADAPTERS=/data/brokers/csv-file.js
//                 CSVFILE_PATH=/data/broker-positions.csv      (要读的 CSV)
//                 CSVFILE_SYNC_ACCOUNT=我的券商                  (写进看板的哪个账户, 账户要先在页面上建好)
//   3. 重启。首次运行只记基线, 之后 CSV 里的股数/成本变了才会改看板。
//
// 适配器要返回的对象说明见 docs/brokers/custom.md。
const fs = require("fs");
const path = require("path");
// 复用看板自带的 CSV 解析: 在项目里直接运行时在上一级目录, 复制到别处(如 data/brokers/)后从运行目录找(Docker 里是 /app)
const csvLib = (() => {
  for (const p of [path.join(__dirname, "..", "csv-import"), path.join(process.cwd(), "csv-import"), "/app/csv-import"]) {
    try { return require(p); } catch {}
  }
  throw new Error("找不到 csv-import.js");
})();
const { parseCsv, detectColumns, extractRows } = csvLib;

exports.create = (env) => ({
  id: "csvfile",                // 小写字母开头; 状态文件 csvfile-sync-state.json
  label: "CSV 文件",             // 页面状态行显示的名字
  configured: !!env.CSVFILE_PATH,
  markets: ["us", "hk", "cn"],  // 这些市场开盘期间每 10 分钟检查一次
  positionsDaily: false,        // 实时型: 随时可读, 休市时每 6 小时读一次
  async fetchPositions() {
    const rows = parseCsv(fs.readFileSync(env.CSVFILE_PATH, "utf8"));
    const { headerRow, columns } = detectColumns(rows);
    if (columns.symbol < 0 || columns.qty < 0 || columns.cost < 0) throw new Error("CSV 里找不到 代码/数量/成本价 列");
    return { positions: extractRows(rows, headerRow, columns).map((r) => ({ symbol: r.symbol, name: r.name, qty: r.qty, cost: r.cost })) };
  },
  // 没有成交数据就不提供 fetchConfirms
});
