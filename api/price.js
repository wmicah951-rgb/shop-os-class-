// POST /api/price · re-price an estimate the user edited in the ticket.
// Same pricing function the agent's calculate_estimate tool uses, so unit prices, labor rates and tax
// always come from shop data. The browser can only choose parts, quantities, hours and a technician.
import { getShopData } from "../lib/shopdata.js";
import { price } from "../lib/tools.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const data = await getShopData();
  const parts = Array.isArray(body.parts) ? body.parts.slice(0, 20).map(p => ({ part_id: Number(p.part_id), qty: Number(p.qty) })) : [];
  const out = price(data, { labor_hours: Number(body.labor_hours) || 0, mechanic_id: body.mechanic_id, parts });
  return res.status(200).json(out);
}
