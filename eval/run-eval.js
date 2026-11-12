#!/usr/bin/env node
// Shop-OS Estimate Agent: evaluation harness with pass@1 and pass^k.
//
// Usage (PowerShell):  $env:LLM_API_KEY="your-key"; node eval/run-eval.js
// Usage (bash):        LLM_API_KEY=your-key node eval/run-eval.js
// Options: --trials 3   --only C01,C08   --delay 6500 (ms between model calls, keeps free-tier rate limits happy)
//
// Every case runs `trials` times from a fresh chat. The harness NEVER approves a gated action:
// when the agent asks for approval it records the request and clicks Reject.
// Data is pinned to the bundled snapshot so expected answers are reproducible.
process.env.DATA_MODE = "snapshot";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, newState, callModel } from "../lib/agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : dflt; };
const TRIALS = Math.max(1, Number(opt("trials", 3)));
const DELAY = Math.max(0, Number(opt("delay", process.env.EVAL_DELAY_MS || 6500)));
const ONLY = opt("only", "") ? opt("only", "").split(",") : null;

const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")).filter(c => !ONLY || ONLY.some(o => c.id.startsWith(o)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Model wrapper: spacing between calls plus retry on rate limits.
let last = 0;
async function pacedModel(messages, opts) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + DELAY - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try { return await callModel(messages, opts); }
    catch (e) {
      if (e.code === "rate_limited" && attempt < 3) { process.stdout.write(" (rate limited, waiting 30s)"); await sleep(30_000); continue; }
      throw e;
    }
  }
}

async function runCase(c) {
  let state = newState();
  const events = [];
  let r = await runTurn(state, { userText: c.prompt }, { callModel: pacedModel });
  events.push(...r.events);
  let gate = null;
  if (r.status === "needs_approval") {
    gate = r.pending;
    r = await runTurn(r.state, { decision: "reject" }, { callModel: pacedModel });
    events.push(...r.events);
  }
  return { status: r.status, reply: r.reply || "", events, gate, error: r.error };
}

function grade(c, run) {
  const k = c.checks, fails = [];
  const reply = run.reply.toLowerCase();
  const tools = run.events.filter(e => e.type === "tool");
  const called = new Set(tools.map(t => t.name));
  const calcs = tools.filter(t => t.name === "calculate_estimate" && !t.result.error);
  const lastCalc = calcs[calcs.length - 1];
  const partIds = new Set(calcs.flatMap(t => (t.result.parts || []).map(p => p.part_id)));
  if (run.status === "error") fails.push("run errored: " + (run.error || run.reply));
  for (const t of k.must_call || []) if (!called.has(t)) fails.push(`did not call ${t}`);
  if (k.must_call_any && !k.must_call_any.some(t => called.has(t))) fails.push(`called none of ${k.must_call_any.join("/")}`);
  for (const t of k.must_not_call || []) if (called.has(t) || (run.gate && run.gate.name === t)) fails.push(`called ${t}`);
  for (const id of k.parts_include || []) if (!partIds.has(id)) fails.push(`estimate missing part ${id}`);
  for (const id of k.parts_exclude || []) if (partIds.has(id)) fails.push(`estimate wrongly includes part ${id}`);
  if (k.mechanic_in && !(lastCalc && k.mechanic_in.includes(Number(lastCalc.args.mechanic_id)))) fails.push(`technician not in [${k.mechanic_in}] (got ${lastCalc ? lastCalc.args.mechanic_id : "none"})`);
  if (k.calc_rate != null && !(lastCalc && lastCalc.result.labor.rate === k.calc_rate)) fails.push(`labor rate not ${k.calc_rate}`);
  if (k.calc_hours != null && !(lastCalc && lastCalc.result.labor.hours === k.calc_hours)) fails.push(`labor hours not ${k.calc_hours}`);
  if (k.reply_has_tool_total) {
    if (!lastCalc) fails.push("no successful calculate_estimate to take a total from");
    else {
      const t = lastCalc.result.total;
      const forms = [t.toFixed(2), t.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })];
      if (!forms.some(f => run.reply.includes(f))) fails.push(`reply does not quote the tool total $${t.toFixed(2)}`);
    }
  }
  if (k.reply_any && !k.reply_any.some(s => reply.includes(s.toLowerCase()))) fails.push(`reply missing any of: ${k.reply_any.slice(0, 4).join(" | ")}…`);
  if (k.reply_any_2 && !k.reply_any_2.some(s => reply.includes(s.toLowerCase()))) fails.push(`reply missing any of: ${k.reply_any_2.join(" | ")}`);
  for (const s of k.reply_none || []) if (reply.includes(s.toLowerCase())) fails.push(`reply contains forbidden text "${s}"`);
  if (k.no_gate && run.gate) fails.push(`asked for approval of ${run.gate.name} when it should not`);
  if (k.gate_required && !run.gate) fails.push("never asked for human approval");
  if (k.gate_ticket && run.gate && String(run.gate.args.ticket || "").toUpperCase() !== k.gate_ticket) fails.push(`gate ticket ${run.gate.args.ticket} != ${k.gate_ticket}`);
  return fails;
}

// pass^k estimator (tau-bench): average over cases of C(c,k)/C(n,k), where c = passes out of n trials.
const choose = (n, r) => { if (r > n) return 0; let x = 1; for (let i = 0; i < r; i++) x = x * (n - i) / (i + 1); return x; };

const started = new Date();
console.log(`Shop-OS agent eval · ${cases.length} cases × ${TRIALS} trials · model ${process.env.LLM_MODEL || "deepseek-chat"}\n`);
const results = [];
for (const c of cases) {
  const trials = [];
  process.stdout.write(`${c.id.padEnd(32)} `);
  for (let i = 0; i < TRIALS; i++) {
    let run;
    try { run = await runCase(c); } catch (e) { run = { status: "error", reply: "", events: [], gate: null, error: String(e.message || e) }; }
    const fails = grade(c, run);
    trials.push({ pass: fails.length === 0, fails, reply: run.reply, gate: run.gate, tools: run.events.filter(e => e.type === "tool").map(e => ({ name: e.name, args: e.args, total: e.result && e.result.total })), status: run.status });
    process.stdout.write(fails.length ? "✗" : "✓");
  }
  const passes = trials.filter(t => t.pass).length;
  results.push({ id: c.id, kind: c.kind, prompt: c.prompt, expected: c.expected, passes, trials });
  console.log(`  ${passes}/${TRIALS}`);
}

const n = TRIALS;
const passAt1 = results.reduce((a, r) => a + r.passes / n, 0) / results.length;
const passHat = k => results.reduce((a, r) => a + choose(r.passes, k) / choose(n, k), 0) / results.length;
const ks = Array.from({ length: n }, (_, i) => i + 1);

console.log(`\npass@1 = ${(passAt1 * 100).toFixed(1)}%`);
for (const k of ks) console.log(`pass^${k} = ${(passHat(k) * 100).toFixed(1)}%`);

const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify({ started: started.toISOString(), model: process.env.LLM_MODEL || "deepseek-chat", trials: n, passAt1, passHat: Object.fromEntries(ks.map(k => [k, passHat(k)])), results }, null, 2));

const md = [];
md.push(`# Shop-OS Estimate Agent · eval report`, ``, `Run ${started.toLocaleString()} · model \`${process.env.LLM_MODEL || "deepseek-chat"}\` · ${results.length} cases × ${n} trials · data: bundled snapshot`, ``);
md.push(`| Metric | Score |`, `|---|---|`, `| pass@1 | ${(passAt1 * 100).toFixed(1)}% |`, ...ks.map(k => `| pass^${k} | ${(passHat(k) * 100).toFixed(1)}% |`), ``);
md.push(`| Case | Type | Passes | pass@1 | pass^${n} |`, `|---|---|---|---|---|`);
for (const r of results) md.push(`| ${r.id} | ${r.kind} | ${r.passes}/${n} | ${(r.passes / n * 100).toFixed(0)}% | ${r.passes === n ? "100%" : "0%"} |`);
md.push(``, `## Failed trials`, ``);
let any = false;
for (const r of results) r.trials.forEach((t, i) => {
  if (t.pass) return; any = true;
  md.push(`### ${r.id} · trial ${i + 1}`, ``, `**Prompt:** ${r.prompt}`, ``, `**Expected:** ${r.expected}`, ``, `**Why it failed:** ${t.fails.join("; ")}`, ``);
  md.push(`**Tool calls:** ${t.tools.map(x => `${x.name}(${JSON.stringify(x.args)})`).join(" → ") || "none"}`, ``);
  if (t.gate) md.push(`**Approval requested:** ${t.gate.name} ${JSON.stringify(t.gate.args)} (harness rejected)`, ``);
  md.push(`**Final reply:**`, ``, "> " + (t.reply || "(empty)").replace(/\n/g, "\n> "), ``);
});
if (!any) md.push(`None.`);
writeFileSync(join(outDir, `report-${stamp}.md`), md.join("\n"));
console.log(`\nSaved eval/results/run-${stamp}.json and eval/results/report-${stamp}.md`);
