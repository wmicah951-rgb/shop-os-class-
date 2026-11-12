// The agent's tools. Every tool except save_draft_estimate is read-only.
// save_draft_estimate is GATED: the agent loop pauses and a human must click Approve before it runs.
import { getShopData } from "./shopdata.js";

const round2 = n => Math.round(n * 100) / 100;

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "lookup_work_order",
      description: "Look up a Shop-OS work order by ticket number (e.g. WO-100488). Returns vehicle, customer-reported symptoms and status. Customer contact details are never returned.",
      parameters: { type: "object", properties: { ticket: { type: "string", description: "Work order number, e.g. WO-100488" } }, required: ["ticket"] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_inventory",
      description: "Search the shop's parts inventory by keyword (name, category or part number). Returns matching parts with part_id, stock on hand and unit cost.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "check_stock",
      description: "Check whether the shop has enough of specific parts. Returns on-hand quantity and any shortfall per line.",
      parameters: {
        type: "object",
        properties: { items: { type: "array", items: { type: "object", properties: { part_id: { type: "integer" }, qty: { type: "integer" } }, required: ["part_id", "qty"] } } },
        required: ["items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_mechanic",
      description: "Find technicians for a kind of work (e.g. brakes, engine, electrical, tires, suspension, service). Returns technicians ranked by specialty match and open hours this week, with their labor rates.",
      parameters: { type: "object", properties: { specialty: { type: "string" }, hours: { type: "number" } }, required: ["specialty"] }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate_estimate",
      description: "Price a job from shop data. The ONLY source of prices. Uses the technician's labor rate if mechanic_id is given, otherwise the shop rate. Returns line items, subtotal, tax and total.",
      parameters: {
        type: "object",
        properties: {
          labor_hours: { type: "number" },
          mechanic_id: { type: "integer" },
          parts: { type: "array", items: { type: "object", properties: { part_id: { type: "integer" }, qty: { type: "integer" } }, required: ["part_id", "qty"] } }
        },
        required: ["labor_hours", "parts"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_draft_estimate",
      description: "Save a draft estimate for a work order. REQUIRES HUMAN APPROVAL: a person must click Approve in the chat before it runs. Only call this when the user explicitly asks to save. The price is recalculated by the system from parts and labor; you cannot set it.",
      parameters: {
        type: "object",
        properties: {
          ticket: { type: "string" },
          labor_hours: { type: "number" },
          mechanic_id: { type: "integer" },
          parts: { type: "array", items: { type: "object", properties: { part_id: { type: "integer" }, qty: { type: "integer" } }, required: ["part_id", "qty"] } },
          note: { type: "string", description: "Short note for the service advisor" }
        },
        required: ["ticket", "labor_hours", "parts"]
      }
    }
  }
];

export const GATED_TOOLS = new Set(["save_draft_estimate"]);

function price(data, { labor_hours, mechanic_id, parts }) {
  const hours = Math.min(Math.max(0, Number(labor_hours) || 0), 40);
  const mech = data.mechanics.find(m => m.id === Number(mechanic_id));
  const rate = mech ? mech.laborRate : data.settings.laborRate;
  const lines = [], problems = [];
  for (const it of Array.isArray(parts) ? parts.slice(0, 20) : []) {
    const p = data.inventory.find(x => x.id === Number(it.part_id));
    const qty = Math.min(Math.max(1, Math.round(Number(it.qty) || 1)), 50);
    if (!p) { problems.push(`unknown part_id ${it.part_id}`); continue; }
    lines.push({ part_id: p.id, name: p.name, qty, unit_cost: p.unitCost, line_total: round2(p.unitCost * qty), in_stock: p.quantity >= qty });
  }
  const parts_total = round2(lines.reduce((a, l) => a + l.line_total, 0));
  const labor_total = round2(hours * rate);
  const subtotal = round2(parts_total + labor_total);
  const tax = round2(subtotal * data.settings.taxRate);
  return {
    labor: { hours, rate, mechanic: mech ? mech.name : "shop rate", total: labor_total },
    parts: lines, parts_total, subtotal, tax_rate: data.settings.taxRate, tax, total: round2(subtotal + tax), problems
  };
}

const RUNNERS = {
  async lookup_work_order({ ticket }, data) {
    const t = String(ticket || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!t) throw new Error("ticket is required");
    const j = data.jobs.find(x => x.ticket.toUpperCase() === t);
    if (!j) return { found: false, ticket: t, note: "No work order with that number exists in Shop-OS." };
    return { found: true, ...j };
  },
  async search_inventory({ query }, data) {
    const words = String(query || "").toLowerCase().split(/[^a-z0-9/]+/).filter(w => w.length > 1);
    if (!words.length) throw new Error("query is required");
    const hits = data.inventory
      .map(p => { const hay = `${p.name} ${p.category} ${p.partNumber}`.toLowerCase(); return { p, s: words.filter(w => hay.includes(w)).length }; })
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8);
    if (!hits.length) return { matches: [], note: "No parts matched. Categories stocked: " + [...new Set(data.inventory.map(p => p.category))].join(", ") + ". A part that is not stocked must be special ordered." };
    return { matches: hits.map(({ p }) => ({ part_id: p.id, name: p.name, part_number: p.partNumber, category: p.category, in_stock: p.quantity, unit_cost: p.unitCost })) };
  },
  async check_stock({ items }, data) {
    if (!Array.isArray(items) || !items.length) throw new Error("items must be a non-empty list of {part_id, qty}");
    return {
      lines: items.slice(0, 20).map(it => {
        const p = data.inventory.find(x => x.id === Number(it.part_id));
        const qty = Math.max(1, Math.round(Number(it.qty) || 1));
        if (!p) return { part_id: it.part_id, error: "unknown part_id" };
        return { part_id: p.id, name: p.name, requested: qty, on_hand: p.quantity, enough: p.quantity >= qty, shortfall: Math.max(0, qty - p.quantity) };
      })
    };
  },
  async find_mechanic({ specialty, hours }, data) {
    const SYNONYMS = {
      suspension: /shock|fork|suspension|spring|damper|steering|bearing|shimmy|wobble/,
      brakes: /brake|pad|rotor|caliper|abs line|stopping/,
      engine: /engine|clutch|transmission|gearbox|piston|valve|slip|rebuild engine/,
      electrical: /electric|diagnos|abs|sensor|ignition|plug|coil|misfire|wiring|battery|stall|injector|tps/,
      service: /service|oil|tire|tyre|chain|sprocket|fluid|filter|maintenance|drivetrain/,
      tires: /tire|tyre|wheel/
    };
    const kw = String(specialty || "").toLowerCase();
    const hrs = Number(hours) || 0;
    const wanted = Object.entries(SYNONYMS).filter(([, re]) => re.test(kw)).map(([k]) => k);
    const ranked = data.mechanics.map(m => {
      const spec = m.specialty.toLowerCase();
      const words = spec.split(/[^a-z]+/).filter(w => w.length > 2);
      const direct = !!kw && words.some(w => kw.includes(w) || w.includes(kw));
      const viaSynonym = wanted.some(k => spec.includes(k.slice(0, 6)) || SYNONYMS[k].test(spec));
      return { m, match: direct || viaSynonym, score: (direct ? 2 : 0) + wanted.filter(k => spec.includes(k.slice(0, 6))).length };
    }).sort((a, b) => (b.score - a.score) || (b.match - a.match) || (b.m.availableHours - a.m.availableHours));
    return { technicians: ranked.map(({ m, match }) => ({ mechanic_id: m.id, name: m.name, specialty: m.specialty, labor_rate: m.laborRate, open_hours_this_week: m.availableHours, specialty_match: match, has_capacity: m.availableHours >= hrs })) };
  },
  async calculate_estimate(args, data) {
    return price(data, args);
  },
  async save_draft_estimate(args, data, ctx) {
    const t = String(args.ticket || "").trim().toUpperCase();
    const job = data.jobs.find(x => x.ticket.toUpperCase() === t);
    if (!job) throw new Error("Unknown work order. Nothing was saved.");
    const priced = price(data, args); // price is recomputed here; the model cannot set it
    const draft = {
      draft_id: "DRAFT-" + Math.random().toString(36).slice(2, 7).toUpperCase(),
      ticket: job.ticket, vehicle: job.vehicle, total: priced.total, labor: priced.labor, parts: priced.parts,
      note: String(args.note || "").slice(0, 300), saved_at: new Date().toISOString()
    };
    if (ctx && Array.isArray(ctx.drafts)) ctx.drafts.push(draft);
    return { saved: true, where: "sandbox: this chat session only. Nothing was written to the real Shop-OS database.", ...draft };
  }
};

export async function runTool(name, args, ctx = {}) {
  const fn = RUNNERS[name];
  if (!fn) return { error: `Unknown tool "${name}".` };
  const base = await getShopData();
  // Sandbox work orders a visitor opened in this chat (held in their signed state, never in Shop-OS).
  const data = ctx && Array.isArray(ctx.jobs) && ctx.jobs.length ? { ...base, jobs: [...base.jobs, ...ctx.jobs] } : base;
  try {
    const out = await fn(args || {}, data, ctx);
    return { ...out, data_source: data.source };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
