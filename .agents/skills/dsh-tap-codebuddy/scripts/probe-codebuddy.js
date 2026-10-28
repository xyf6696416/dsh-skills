#!/usr/bin/env node
// probe-codebuddy.js — 直接打本地 codebuddy 桥，区分「渠道级」还是「内容级」失败。
//
// 桥收到的就是 adapters 出站归一之后的形态，所以这个探针能证明「链路是否生效」，
// 而不只是「代码是否改对」。
//
// 用法：
//   node probe-codebuddy.js --text "hi"
//   node probe-codebuddy.js --system-file dump/system-plain.txt
//   node probe-codebuddy.js --from-session <session.v4.jsonl.zstd>   # 取会话原始 system + tools 全量回放
//   node probe-codebuddy.js --text "hi" --no-tools --model glm-5.3-flash --json
//
// 退出码：0 = 200/SSE；1 = 400/11128；2 = 其它非预期；3 = 环境问题
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BRIDGE = process.env.DSH_CODEBUDDY_BRIDGE || "http://127.0.0.1:3901/v2/chat/completions";
const DEFAULT_MODEL = process.env.DSH_CODEBUDDY_MODEL || "deepseek-v4.1-flash";

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer dsh-codebuddy-bridge",
  "X-IDE-Type": "CLI",
  "X-IDE-Name": "CLI",
  "X-IDE-Version": "2.133.1",
  "X-Product-Version": "2.133.1",
  "X-Requested-With": "XMLHttpRequest",
  "X-Private-Data": "false",
};

function parseArgs(argv) {
  const out = { tools: true, json: false, model: DEFAULT_MODEL, maxTokens: 32, user: "hi" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--text") out.text = next();
    else if (a === "--system-file") out.systemFile = next();
    else if (a === "--from-session") out.fromSession = next();
    else if (a === "--model") out.model = next();
    else if (a === "--user") out.user = next();
    else if (a === "--max-tokens") { out.maxTokens = Number(next()); out.maxTokensExplicit = true; }
    else if (a === "--no-tools") out.tools = false;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function readSession(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  const parts = [];
  for (const s of starts) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s)));
    } catch {
      /* 跳过坏帧 */
    }
  }
  const recs = [];
  for (const line of Buffer.concat(parts).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* 跳过残行 */
    }
  }
  const sys = recs.find((r) => r.type === "system/message");
  const users = recs.filter((r) => r.type === "user/message");
  const header = recs.find((r) => r.type === "request/header");
  const ctx = recs.find((r) => r.type === "request/context");
  return {
    system: sys?.data?.message ?? null,
    users: users.map((r) => r.data),
    tools: header?.data?.header?.tools ?? null,
    maxTokens: header?.data?.header?.config?.maxTokens,
    model: ctx?.data?.model,
    provider: ctx?.data?.provider,
  };
}

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("\n");
  return "";
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("用法: node probe-codebuddy.js [--text T | --system-file F | --from-session S] [--model M] [--no-tools] [--json]");
    process.exit(0);
  }

  let messages;
  let tools = args.tools ? undefined : null;
  let model = args.model;
  let maxTokens = args.maxTokens;

  if (args.fromSession) {
    const s = readSession(path.resolve(args.fromSession));
    if (!s.system) {
      console.error("会话里没有 system/message 记录");
      process.exit(3);
    }
    messages = [s.system, ...s.users];
    if (args.tools && s.tools) tools = s.tools;
    if (s.model) model = s.model;
    if (!args.maxTokensExplicit && s.maxTokens) maxTokens = s.maxTokens;
    console.error(`[probe] 全量回放 provider=${s.provider} model=${model} msgs=${messages.length} tools=${tools?.length ?? 0}`);
  } else if (args.systemFile) {
    const sys = fs.readFileSync(path.resolve(args.systemFile), "utf8");
    messages = [{ role: "system", content: sys }, { role: "user", content: args.user }];
  } else if (args.text) {
    messages = [{ role: "user", content: args.text }];
  } else {
    messages = [{ role: "user", content: "hi" }];
  }

  const body = { model, messages, stream: true, max_tokens: maxTokens };
  if (tools) body.tools = tools;

  const t0 = Date.now();
  let res;
  let text;
  try {
    res = await fetch(BRIDGE, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    text = await res.text();
  } catch (e) {
    const msg = `桥不可达或超时: ${e?.message ?? e}`;
    if (args.json) console.log(JSON.stringify({ ok: false, envError: msg }));
    else console.error(msg + `\n检查: netstat -ano | Select-String ":3901"\n桥地址: ${BRIDGE}`);
    process.exit(3);
  }

  const ms = Date.now() - t0;
  const code = (text.match(/"code"\s*:\s*(\d+)/) || [])[1] ?? null;
  const blocked11128 = text.includes("11128");
  const sse = text.includes("data:");
  const result = {
    bridge: BRIDGE,
    model,
    sentSystemLen: messages[0]?.role === "system" ? textOf(messages[0]).length : 0,
    sentTools: tools?.length ?? 0,
    httpStatus: res.status,
    gatewayCode: code,
    blocked11128,
    sse,
    ms,
    sample: text.slice(0, 300),
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`bridge  ${BRIDGE}`);
    console.log(`model   ${model}   tools=${result.sentTools}   systemLen=${result.sentSystemLen}`);
    console.log(`result  http=${res.status}  code=${code ?? "-"}  ${ms}ms  ${sse ? "sse" : "json"}`);
    if (blocked11128) console.log("判定    400/11128 —— 请求内容被通道校验拦下（走 SKILL.md 的二分流程）");
    else if (res.status === 200 && sse) console.log("判定    200 + SSE —— 正常");
    else console.log(`判定    非预期，首段: ${result.sample}`);
  }

  if (blocked11128) process.exit(1);
  if (res.status === 200 && sse) process.exit(0);
  process.exit(2);
}

main();
