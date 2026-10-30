// 资产归类 —— 前后端共用的唯一实现(server.js require, m.html 以 <script> 引入)。
// 新增指数类标的: 改下面两份白名单; 个人分组(警戒/其他)写在 plan.json 的 groups 里, 不改代码。

// 纳斯达克100 系(美股 ETF / A股场内 ETF / 场外联接基金)
const NASDAQ_SYMBOLS = ['513100', 'QQQ', 'QQQM', 'QQQI', 'SCHG', 'TQQQ',
                        '161126', '000055', '270042', '016452', '021000', '019441'];
// 标普500 系
const SP500_SYMBOLS = ['513650', '513500', 'VOO', 'SPLG', 'SPY', 'IVV', '161125'];

// 个人分组, 由 plan.json 的 groups 配置注入(见 configureGroups):
//   warning = 警戒仓(主题/单赛道仓, 不加仓不抄底)
//   other   = 非决策持仓(如券商赠股), 归入"其他"
let WARNING_SYMBOLS = [];
let OTHER_SYMBOLS = [];
function configureGroups(groups) {
    const up = (a) => (Array.isArray(a) ? a : []).map((s) => String(s).toUpperCase());
    WARNING_SYMBOLS = up(groups && groups.warning);
    OTHER_SYMBOLS = up(groups && groups.other);
}

function isOtherHolding(holding) {
    return OTHER_SYMBOLS.includes(String(holding.symbol || '').toUpperCase());
}

// A股场内基金代码段: 沪市5开头 / 深市1开头(股票是60/68/00/30开头, 不会误伤)
function isCnExchangeFund(holding) {
    const symbol = String(holding.symbol || '');
    return (holding.market === 'sh' && symbol[0] === '5') || (holding.market === 'sz' && symbol[0] === '1');
}

// 警戒判定: A股主动基金(场外, market=fund) + 场内行业/主题 ETF, 且不在指数白名单里; 外加 groups.warning 显式指定。
// 思路是"白名单才是指数": 不在白名单里的 A 股基金/ETF 大多是主题或赛道仓, 默认归警戒更稳妥; 想转正就加白名单。
function isWarningHolding(holding) {
    const symbol = String(holding.symbol || '').toUpperCase();
    if (WARNING_SYMBOLS.includes(symbol)) return true;
    const isCnFund = holding.market === 'fund' || isCnExchangeFund(holding);
    return isCnFund && classifyAllocationBucket(holding) === null;
}

// 饼图聚合组: 与持仓列表分组语义对齐。
// 传入 weightPct(该持仓占总资产%)时: 个股占比 <5% 聚成"观察仓", ≥5% 各自单列; 不传则个股一律单列。
// rule = plan.json channels.symbols[该代码](可不传)。设了「看占比」规则(band)的个股 = 打算建仓, 不论占比都算个股组; 没规则或一直封仓的才按 <5% 进观察仓。
function classifyPieGroup(holding, weightPct, rule) {
    if (holding.market === 'crypto') return '加密资产';
    const bucket = classifyAllocationBucket(holding);
    if (bucket) return bucket;                                    // 纳指指数类 / 标普
    if (isWarningHolding(holding) || isOtherHolding(holding)) return '其他';
    if (weightPct != null && weightPct < 5 && !(rule && rule.type === 'band')) return '观察仓';   // 小仓个股(且没设建仓规则) → 观察仓
    return holding.name || holding.symbol || '未命名';
}

// 资产配置桶(粗): 纳指指数类 / 标普 / 加密资产, 不匹配返回 null(调用方回退到持仓名)
function classifyAllocationBucket(holding) {
    const symbol = String(holding.symbol || '').toUpperCase();
    const text = `${holding.name || ''} ${symbol}`;
    if (holding.market === 'crypto') return '加密资产';
    if (NASDAQ_SYMBOLS.includes(symbol) || /纳指|纳斯达克|NASDAQ/i.test(text)) return '纳指指数类';
    if (SP500_SYMBOLS.includes(symbol) || /标普|S&P|SP500|500 ETF/i.test(text)) return '标普';
    return null;
}

// 穿透桶(细, server.js buildLookThrough 用): 必有归属
function classifyLookThroughBucket(holding) {
    const symbol = String(holding.symbol || '').toUpperCase();
    const text = `${holding.name || ''} ${symbol}`;
    const market = holding.market;
    if (holding.__isCash) return '现金';
    if (market === 'crypto') return '加密资产';
    if (isWarningHolding(holding)) return '其他';
    if (NASDAQ_SYMBOLS.includes(symbol) || symbol === 'VUG' || /纳指|纳斯达克|NASDAQ|Growth/i.test(text)) return '纳指/成长';
    if (SP500_SYMBOLS.includes(symbol) || symbol === 'VTI' || /标普|S&P|SP500|500 ETF/i.test(text)) return '标普宽基';
    if (market === 'nasdaq' || market === 'nyse') return '美股个股';
    if (market === 'sh' || market === 'sz' || market === 'hk') return '中国/港股资产';
    return '其他';
}

// 宽基指数兜底归组: holding 没填 category 时按白名单推断(场外指数基金常缺 category)
function deriveCategory(holding) {
    if (holding.category) return holding.category;
    const symbol = String(holding.symbol || '').toUpperCase();
    if (NASDAQ_SYMBOLS.includes(symbol) || SP500_SYMBOLS.includes(symbol)) return '指数';
    return null;
}

// 收益曲线取样: 按时间等距取桶到 ≤n 点(桶内取最后一点=收盘)。
// 历史快照是分层降采样的(越近越密), 按索引隔点取样会把近期拉宽、把老数据压扁, 所以按时间取桶。
function sampleByTime(points, n) {
    if (!Array.isArray(points) || points.length <= n) return points;
    const t = p => new Date(p.t).getTime();
    const t0 = t(points[0]), t1 = t(points[points.length - 1]);
    if (!(t1 > t0)) return points.slice(-n);
    const bucket = (t1 - t0) / n;
    const out = [];
    let last = -1;
    for (const p of points) {
        const b = Math.min(n - 1, Math.floor((t(p) - t0) / bucket));
        if (b !== last) { out.push(p); last = b; }
        else out[out.length - 1] = p;
    }
    return out;
}

// 收益曲线的交易日视图：周末不显示，每个交易日只保留最后一个快照。
// 美股周五收盘/盘后落在北京时间周六早晨，需归回纽约周五，不能被周末过滤吞掉。
// 原始历史仍完整保留，避免影响风险计算和加密资产的实际估值。
function tradingDaySnapshots(points) {
    const byDay = new Map();
    for (const point of points || []) {
        const ts = new Date(point && point.t).getTime();
        if (!Number.isFinite(ts)) continue;
        // 中国没有夏令时，用 UTC+8 得到稳定的北京时间日历日。
        const china = new Date(ts + 8 * 3600000);
        let weekday = china.getUTCDay();
        let day = china.toISOString().slice(0, 10);
        if (weekday === 6) {
            const nyParts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            }).formatToParts(new Date(ts));
            const ny = Object.fromEntries(nyParts.map((p) => [p.type, p.value]));
            const nyMinute = Number(ny.hour) * 60 + Number(ny.minute);
            // 美股延长交易截至纽约时间 20:00；留 5 分钟轮询缓冲接住最后报价。
            if (ny.weekday === 'Fri' && nyMinute <= 20 * 60 + 5) {
                china.setUTCDate(china.getUTCDate() - 1);
                day = china.toISOString().slice(0, 10);
                weekday = china.getUTCDay();
            }
        }
        if (weekday === 0 || weekday === 6) continue;
        const previous = byDay.get(day);
        if (!previous || new Date(previous.t).getTime() <= ts) byDay.set(day, point);
    }
    return [...byDay.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
}

// ===== 持仓通道签(可加/封仓)评估: plan.json.channels 的唯一判断实现 =====
// cfg = plan.json.channels; sym = 标的代码;
// input = { weightPct(占比%), stockPct(个股桶占比%), offshoreCNY(境外托管市值), usdCny(美元汇率, 美元线时必传),
//           price(现价), iopv(上交所参考净值, 可空), iopvTime(可空), shares(持股数, 有 targetShares 时用) }
// store = { get(key), set(key, val) } 用于迟滞记忆(浏览器传 localStorage 包装; 测试传 Map 包装); 可不传
// 返回 { st:'open'|'seal', label, why, type, needsIopv(premium 型且没给 iopv 时为 true, 供前端决定是否兜底拉取) }; 现金请在调用前排除
function evaluateChannel(cfg, sym, input, store) {
    cfg = cfg || {};
    const c = (cfg.symbols || {})[sym];
    const type = c ? c.type : (cfg.default || 'seal');
    const labels = cfg.labels || {};
    const get = (k) => (store && typeof store.get === 'function') ? store.get(k) : null;
    const set = (k, v) => { if (store && typeof store.set === 'function') { try { store.set(k, v); } catch (e) {} } };
    const fmtWan = (v) => (Math.round(v / 10000)).toString();
    let st = 'seal', why = c ? (c.why || '') : '未列入任何通道', needsIopv = false;
    const w = Number(input && input.weightPct) || 0;
    if (type === 'open') {
        st = 'open';
    } else if (type === 'offshore') {
        // 境外托管目标: 优先用美元线(offshoreTargetUSD/offshoreRestartUSD), 兼容旧的人民币线(*CNY)
        const usdMode = Number(cfg.offshoreTargetUSD) > 0;
        const fx = Number(input && input.usdCny) || 0;
        const curCNY = Number(input && input.offshoreCNY) || 0;
        const cur = usdMode ? (fx > 0 ? curCNY / fx : 0) : curCNY;
        const tgt = usdMode ? Number(cfg.offshoreTargetUSD) : (Number(cfg.offshoreTargetCNY) || Infinity);
        const re = usdMode ? (Number(cfg.offshoreRestartUSD) || tgt) : (Number(cfg.offshoreRestartCNY) || tgt);
        const key = `chState_${sym}_${usdMode ? 'USD' : ''}${tgt}_${re}`, last = get(key);
        if (usdMode && !(fx > 0)) st = last || 'open';                                          // 没汇率: 保持上次
        else if (cur >= tgt) st = 'seal'; else if (cur < re || !last) st = 'open'; else st = last;   // 目标↔重启线之间保持上次
        set(key, st);
        const fw = usdMode ? (v) => String(Math.round(v / 1000) / 10) : fmtWan, cs = usdMode ? '$' : '¥';
        why = `境外托管 ${cs}${fw(cur)}万 / ${cs}${fw(tgt)}万 · ` + ((c && c.why) || '');
    } else if (type === 'band') {
        const cap = Number(cfg.stockBucketCapPct) || 40;
        const stockPct = Number(input && input.stockPct) || 0;
        const key = `chState_${sym}_${c.openBelowPct}_${c.sealAtPct}`, last = get(key);
        if (stockPct >= cap) st = 'seal';
        else if (w < c.openBelowPct) st = 'open';
        else if (w >= c.sealAtPct) st = 'seal';
        else st = last || c.hystInitial || 'seal';                 // 迟滞区间保持上次; 无历史用 hystInitial
        set(key, st);
        // 股数目标: 买够即封仓, 与占比闸门任一触发都封; 股数只表示"买够没", 不影响迟滞记忆
        const tgtSh = Number(c.targetShares) || 0, sh = Number(input && input.shares) || 0;
        const reached = tgtSh > 0 && sh >= tgtSh - 1e-6;
        if (reached) st = 'seal';
        const inHyst = stockPct < cap && w >= c.openBelowPct && w < c.sealAtPct;
        const gate = stockPct >= cap ? `个股合计 ${stockPct.toFixed(1)}% ≥ ${cap}% 上限`
            : inHyst ? `占比 ${w.toFixed(1)}%，在 ${c.openBelowPct}–${c.sealAtPct}% 之间，保持${st === 'open' ? '可加' : '封仓'}`
            : st === 'open' ? `占比 ${w.toFixed(1)}% < ${c.openBelowPct}%`
            : (c.openBelowPct < c.sealAtPct ? `占比 ${w.toFixed(1)}%，未到 ${c.openBelowPct}%` : `占比 ${w.toFixed(1)}% ≥ ${c.sealAtPct}%`);
        const shTxt = tgtSh > 0 ? (reached ? `已买够 ${+sh.toFixed(4)}/${tgtSh} 股 · ` : `${+sh.toFixed(4)}/${tgtSh} 股，还差 ${+(tgtSh - sh).toFixed(2)} 股 · `) : '';
        why = shTxt + gate + ' · ' + (c.why || '');
    } else if (type === 'premium') {
        const px = Number(input && input.price) || 0, iopv = Number(input && input.iopv) || 0;
        if (!(iopv > 0)) needsIopv = true;
        if (!(iopv > 0) || !(px > 0)) { st = 'seal'; why = '参考净值暂时取不到，按封仓 · ' + (c.why || ''); }
        else {
            const prem = (px / iopv - 1) * 100;
            st = prem <= c.maxPremiumPct ? 'open' : 'seal';
            const tm = input && input.iopvTime ? `，${input.iopvTime}` : '';
            why = `溢价 ${prem.toFixed(1)}% ${st === 'open' ? '≤' : '>'} ${c.maxPremiumPct}%（价 ${px.toFixed(3)} / 参考净值 ${iopv.toFixed(4)}${tm}）· ` + (c.why || '');
        }
    }
    return { st, why, type, needsIopv, label: labels[st] || (st === 'open' ? '可加' : '封仓') };
}

// 浏览器当普通 <script> 引入(函数挂全局); Node 端 server.js require 使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NASDAQ_SYMBOLS, SP500_SYMBOLS, configureGroups, isCnExchangeFund, isWarningHolding, isOtherHolding, classifyPieGroup, classifyAllocationBucket, classifyLookThroughBucket, deriveCategory, sampleByTime, tradingDaySnapshots, evaluateChannel };
}
