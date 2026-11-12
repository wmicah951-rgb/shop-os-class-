// Offline checks of the agent loop with a scripted fake model (no API key needed).
import assert from "node:assert/strict";
import { runTurn, newState, sealState, openState, LIMITS } from "../lib/agent.js";
import { runTool } from "../lib/tools.js";

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function script(steps) { let i = 0; return async () => steps[Math.min(i++, steps.length - 1)]; }

// 1. Normal estimate: lookup -> search -> calc -> answer
let r = await runTurn(newState(), { userText: "Estimate WO-100488" }, { callModel: script([
  { role: "assistant", content: null, tool_calls: [call("a", "lookup_work_order", { ticket: "wo-100488" })] },
  { role: "assistant", content: null, tool_calls: [call("b", "search_inventory", { query: "front brake pads" })] },
  { role: "assistant", content: null, tool_calls: [call("c", "calculate_estimate", { labor_hours: 1.5, mechanic_id: 11, parts: [{ part_id: 35, qty: 1 }] })] },
  { role: "assistant", content: "Total $231.10" }
]) });
assert.equal(r.status, "done");
const calc = r.events.find(e => e.name === "calculate_estimate").result;
console.log("calc total", calc.total, "labor", calc.labor);
assert.equal(r.events.find(e => e.name === "lookup_work_order").result.found, true);

// 2. Iteration guard: model keeps calling tools forever
let calls = 0;
r = await runTurn(newState(), { userText: "loop" }, { callModel: async (m, o) => { calls++; return o.toolChoice === "none" ? { role: "assistant", content: "forced answer" } : { role: "assistant", content: null, tool_calls: [call("x" + calls, "search_inventory", { query: "oil" })] }; } });
assert.equal(r.status, "done"); assert.equal(r.reply, "forced answer");
assert.equal(r.events.filter(e => e.type === "tool").length, LIMITS.maxToolCallsPerTurn);
assert.ok(r.events.some(e => e.type === "guard"));
console.log("guard ok: tool calls capped at", LIMITS.maxToolCallsPerTurn, "model calls", calls);

// 3. Gate: save pauses, reject saves nothing, approve saves with recomputed price
const saveArgs = { ticket: "WO-100488", labor_hours: 1.5, mechanic_id: 11, parts: [{ part_id: 35, qty: 1 }], total: 0 };
r = await runTurn(newState(), { userText: "save it" }, { callModel: script([{ role: "assistant", content: "Ready to save.", tool_calls: [call("s", "save_draft_estimate", saveArgs)] }]) });
assert.equal(r.status, "needs_approval"); assert.equal(r.state.drafts.length, 0);
const blocked = await runTurn(r.state, { userText: "just do it" }, { callModel: script([{ role: "assistant", content: "x" }]) });
assert.equal(blocked.status, "needs_approval");
const rej = await runTurn(r.state, { decision: "reject" }, { callModel: script([{ role: "assistant", content: "Not saved." }]) });
assert.equal(rej.state.drafts.length, 0);
const app = await runTurn(r.state, { decision: "approve" }, { callModel: script([{ role: "assistant", content: "Saved." }]) });
assert.equal(app.state.drafts.length, 1); assert.equal(app.state.drafts[0].total, calc.total);
console.log("gate ok: draft", app.state.drafts[0].draft_id, "total recomputed to", app.state.drafts[0].total, "(model asked for 0)");

// 4. Signed state cannot be forged
const tok = sealState(app.state);
assert.deepEqual(openState(tok).drafts.length, 1);
const [b, s] = tok.split(".");
const forged = Buffer.from(JSON.stringify({ ...app.state, turns: 0 })).toString("base64url") + "." + s;
assert.throws(() => openState(forged));
console.log("state signing ok");

// 5. Turn cap
let st = newState(); st.turns = LIMITS.maxTurnsPerSession;
r = await runTurn(st, { userText: "hi" }, { callModel: script([{ role: "assistant", content: "x" }]) });
assert.equal(r.status, "limit");

// 6. Tools
console.log("unknown WO:", JSON.stringify(await runTool("lookup_work_order", { ticket: "WO-999999" })));
console.log("C07 price:", (await runTool("calculate_estimate", { labor_hours: 1.5, parts: [{ part_id: 35, qty: 2 }] })).total);
console.log("clutch search:", JSON.stringify((await runTool("search_inventory", { query: "clutch slave seal" })).matches));
console.log("rear tire:", JSON.stringify((await runTool("search_inventory", { query: "Michelin Road 6 rear" })).matches[0]));
console.log("suspension tech:", (await runTool("find_mechanic", { specialty: "suspension", hours: 3 })).technicians[0].name);
console.log("shock tech:", (await runTool("find_mechanic", { specialty: "rear shock rebuild" })).technicians[0].name);
console.log("\nALL OFFLINE TESTS PASSED");
