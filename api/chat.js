// POST /api/chat
// body: { state?: string, message?: string, decision?: "approve" | "reject" }
// The browser holds only a signed, opaque state token. It cannot edit history or forge tool results.
import { runTurn, openState, sealState, LIMITS } from "../lib/agent.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, limits: LIMITS, model: process.env.LLM_MODEL || "gemini-flash-latest", configured: !!process.env.LLM_API_KEY });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  let state;
  try { state = openState(body.state); }
  catch { return res.status(400).json({ error: "This chat session is invalid or expired. Start a new chat." }); }

  const input = body.decision === "approve" || body.decision === "reject"
    ? { decision: body.decision }
    : { userText: typeof body.message === "string" ? body.message : "" };

  const out = await runTurn(state, input);
  return res.status(200).json({
    state: sealState(out.state),
    status: out.status,
    reply: out.reply,
    events: out.events.map(e => e.type === "tool" ? { ...e, result: trim(e.result) } : e),
    pending: out.state.pending ? { name: out.state.pending.name, args: out.state.pending.args } : null,
    turns: out.state.turns,
    maxTurns: LIMITS.maxTurnsPerSession
  });
}

function trim(v) {
  const s = JSON.stringify(v);
  return s.length > 4000 ? { truncated: true, preview: s.slice(0, 4000) } : v;
}
