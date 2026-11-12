// GET /api/shop · read-only view of the shop data the agent's tools use (no customer contact details).
import { getShopData } from "../lib/shopdata.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  const d = await getShopData();
  res.setHeader("Cache-Control", "public, max-age=60");
  return res.status(200).json({ source: d.source, takenAt: d.takenAt, settings: d.settings, jobs: d.jobs, inventory: d.inventory, mechanics: d.mechanics });
}
