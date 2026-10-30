"use strict";
// 冷静期(可选, AI_COOLDOWN_HOURS > 0 时启用): 确认的 AI 建议先存为「待生效」, 到时间才写进 plan.json, 期间可以撤销。
const fs = require("fs");
const crypto = require("crypto");

function createPendingStore(file) {
  const load = () => { try { const a = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; } };
  const save = (list) => { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, file); };
  return {
    list: load,
    add({ proposals, reason, hours, now = new Date() }) {
      const item = { id: crypto.randomBytes(6).toString("hex"), createdAt: now.toISOString(), dueAt: new Date(now.getTime() + hours * 3600 * 1000).toISOString(), proposals, reason: String(reason || "").slice(0, 200) };
      const list = load(); list.push(item); save(list);
      return item;
    },
    cancel(id) {
      const list = load(); const next = list.filter((x) => x.id !== id);
      if (next.length === list.length) return false;
      save(next); return true;
    },
    // 取出到期的(并从队列里移除), 交给调用方去应用
    takeDue(now = new Date()) {
      const list = load();
      const due = list.filter((x) => new Date(x.dueAt) <= now);
      if (due.length) save(list.filter((x) => new Date(x.dueAt) > now));
      return due;
    },
  };
}

module.exports = { createPendingStore };
