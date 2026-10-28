#!/usr/bin/env node
// dsh-session-dump.js — 从 DSH 会话文件还原真实请求现场。
//
// 会话文件是「多帧 zstd」（每帧独立压缩），zstdDecompressSync 只解第一帧，
// 流式解压遇第二帧报 "Unknown frame descriptor"。这里按 magic 28 B5 2F FD
// 逐帧解压再拼接。
//
// 用法：
//   node dsh-session-dump.js <session.v4.jsonl.zstd> [输出目录]
// 产出：
//   meta.json            会话头 + 记录类型统计
//   system.txt           system/message 全文（JSON）
//   system-plain.txt     system 纯文本
//   user-N.txt           各条 user 消息纯文本
//   user-msgs.json       各条 user 消息原始对象
//   request-header.json  出站 tools + config（model/maxTokens）
//   request-context.json provider/model/contextWindow
//   attempt.json         失败原文（网关 code/msg/requestId）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressFrames(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  if (starts.length === 0) throw new Error("no zstd frame found; is this really session.v4.jsonl.zstd?");
  const parts = [];
  let failed = 0;
  for (const s of starts) {
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(s));
      if (out && out.length) parts.push(out);
    } catch {
      failed += 1;
    }
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames: starts.length, failed };
}

function messageText(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? `[${p?.type ?? "?"}]`).join("\n");
  return "";
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("用法: node dsh-session-dump.js <session.v4.jsonl.zstd> [输出目录]");
    process.exit(2);
  }
  const abs = path.resolve(src);
  const outDir = path.resolve(process.argv[3] || path.join(path.dirname(abs), "dump"));
  fs.mkdirSync(outDir, { recursive: true });

  const { text, frames, failed } = decompressFrames(fs.readFileSync(abs));
  const lines = text.split("\n").filter(Boolean);
  const recs = [];
  for (const l of lines) {
    try {
      recs.push(JSON.parse(l));
    } catch {
      /* 跳过残行 */
    }
  }

  const counts = {};
  for (const r of recs) counts[r.type || "?"] = (counts[r.type || "?"] || 0) + 1;

  const head = recs.find((r) => r.type === "session") || null;
  // session 头字段直接在记录顶层（不在 data 里），两种形态都兼容
  const sessionInfo = head?.data ?? head ?? null;
  const sysRec = recs.find((r) => r.type === "system/message");
  const userRecs = recs.filter((r) => r.type === "user/message");
  const headerRec = recs.find((r) => r.type === "request/header");
  const ctxRec = recs.find((r) => r.type === "request/context");
  const attempts = recs.filter((r) => r.type === "assistant/attempt");

  const w = (name, content) => fs.writeFileSync(path.join(outDir, name), content, "utf8");

  w("meta.json", JSON.stringify({
    source: abs,
    frames,
    failedFrames: failed,
    decompressedChars: text.length,
    recordCounts: counts,
    session: sessionInfo,
  }, null, 2));

  if (sysRec) {
    w("system.txt", JSON.stringify(sysRec.data, null, 2));
    w("system-plain.txt", messageText(sysRec.data?.message));
  }
  w("user-msgs.json", JSON.stringify(userRecs.map((r) => r.data), null, 2));
  userRecs.forEach((r, idx) => w(`user-${idx}.txt`, messageText(r.data)));
  if (headerRec) w("request-header.json", JSON.stringify(headerRec.data, null, 2));
  if (ctxRec) w("request-context.json", JSON.stringify(ctxRec.data, null, 2));
  w("attempt.json", JSON.stringify(attempts.map((a) => a.data), null, 2));

  // 摘要
  console.log(`source : ${abs}`);
  console.log(`frames : ${frames} (failed ${failed})  chars=${text.length}  records=${recs.length}`);
  console.log(`session: ${sessionInfo?.id ?? "?"}  cwd=${sessionInfo?.cwd ?? "?"}  preset=${sessionInfo?.agentPreset ?? "?"}`);
  console.log(`records: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (ctxRec) console.log(`route  : provider=${ctxRec.data?.provider} model=${ctxRec.data?.model} ctx=${ctxRec.data?.contextWindow}`);
  if (sysRec) console.log(`system : ${messageText(sysRec.data?.message).length} chars`);
  if (headerRec) console.log(`tools  : ${headerRec.data?.header?.tools?.length ?? 0}  defs, maxTokens=${headerRec.data?.header?.config?.maxTokens}`);
  const fail = attempts
    .map((a) => a.data?.stream?.find((s) => s?.chunk?.type === "finish")?.chunk?.reason)
    .find((r) => r?.kind === "error");
  if (fail) console.log(`failure: ${fail.failure?.message ?? JSON.stringify(fail)}`);
  console.log(`output : ${outDir}`);
}

main();
