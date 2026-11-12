// Shop data access for the agent's tools.
// Snapshot mode (default): the bundled export of the Shop-OS demo database (Oct 22 2026, test rows removed).
// Live mode (DATA_MODE=live + SHOP_OS_EMAIL/SHOP_OS_PASSWORD): read-only GET calls to the deployed Shop-OS API,
// with a fallback to the snapshot if the API is unreachable. No customer names, emails or phones ever leave this module.

export const SNAPSHOT = {
  takenAt: "2026-10-22",
  settings: { shopName: "Shop OS Demo", laborRate: 110, taxRate: 0.085, diagnosticRate: 95, minConfidence: 0.65 },
  inventory: [
    [33, "Motul 7100 10W-40 (1L)", "MOT-7100-1040", "Fluids", 24, 16.5],
    [34, "K&N Air Filter Universal", "KN-AIR-UNIV", "Filters", 5, 62],
    [35, "EBC HH Brake Pads (front)", "EBC-FA630HH", "Brakes", 12, 48],
    [36, "DID 525 X-Ring Chain", "DID-525VX3-120", "Drivetrain", 3, 162],
    [37, "NGK Iridium IX Spark Plug", "NGK-CR9EIX", "Ignition", 38, 12.2],
    [38, "Michelin Road 6 Front 120/70-17", "MICH-R6-12070", "Tires", 6, 189],
    [39, "Michelin Road 6 Rear 180/55-17", "MICH-R6-18055", "Tires", 4, 224],
    [40, "Galfer Brake Fluid DOT 4 (500ml)", "GAL-DOT4-500", "Fluids", 2, 11.4],
    [41, "EBC Rear Brake Pads", "EBC-FA181HH", "Brakes", 8, 44],
    [42, "Castrol Power 1 4T 10W-50 (1L)", "CAS-POW-1050", "Fluids", 16, 14],
    [43, "RK 530 GXW X-Ring Chain", "RK-530GXW-116", "Drivetrain", 2, 178],
    [44, "OEM Oil Filter (Honda)", "HON-15410-MFJ-D01", "Filters", 10, 9.5],
    [45, "Pirelli Angel GT2 Front 120/70-17", "PIR-ANG-GT2-F", "Tires", 3, 175],
    [46, "WD-40 Specialist Chain Lubricant (400ml)", "WD-CHAIN-400", "Lubricants", 14, 8.5],
    [47, "Dunlop Sportmax D214 Rear 190/55-17", "DUN-D214-19055", "Tires", 1, 198],
    [48, "Race Tech Gold Valve Rebuild Kit", "RT-FMGV-S2401", "Suspension", 1, 298]
  ].map(([id, name, partNumber, category, quantity, unitCost]) => ({ id, name, partNumber, category, quantity, unitCost })),
  mechanics: [
    { id: 9, name: "Marco Reyes", specialty: "Engine & Transmission", laborRate: 115, availableHours: 30.5 },
    { id: 10, name: "Dani Park", specialty: "Electrical & Diagnostics", laborRate: 120, availableHours: 33 },
    { id: 11, name: "Jules Okafor", specialty: "Suspension & Brakes", laborRate: 110, availableHours: 30 },
    { id: 12, name: "Sam Whitlock", specialty: "General Service & Tires", laborRate: 100, availableHours: 36 }
  ],
  jobs: [
    ["WO-100482", "2022 Ducati Monster 937", "Intermittent stall at idle once warm. Check fuel injectors and TPS.", "In Progress"],
    ["WO-100483", "2019 Yamaha MT-09", "Front end shimmy at 60mph. Likely steering head bearings or worn front tire.", "Awaiting Approval"],
    ["WO-100484", "2024 Honda Africa Twin", "ABS warning light on dash. DTC pulled: rear wheel speed sensor open circuit.", "Waiting on Parts"],
    ["WO-100485", "2017 Harley-Davidson Street Bob", "Annual service: oil, primary fluid, tires, brake pads.", "Ready for Pickup"],
    ["WO-100486", "2023 BMW R 1250 GS", "Customer reports clutch slip under hard acceleration in 4th and 5th.", "Awaiting Approval"],
    ["WO-100487", "2021 Kawasaki KLR 650", "Rear shock leaking. Replace OEM with Race Tech Gold valve rebuild.", "In Progress"],
    ["WO-100488", "2020 Can-Am Outlander 650", "Front brake squeal and reduced stopping power. Pads worn to 2mm.", "Parts Ordered"],
    ["WO-100489", "2016 KTM 690 Duke", "Engine running rough, misfires at 4000rpm. Coils and plugs suspected.", "Work Complete"],
    ["WO-100490", "2022 Suzuki V-Strom 1050", "Chain and sprocket worn. Customer wants full drivetrain replacement.", "Parts Arrived"],
    ["WO-644142", "2026 KTM 450 SX-F", "While riding the clutch suddenly went completely limp with no resistance. Fluid around the slave cylinder area. Owner made a gasket from a cereal box and put it back together. Bled the clutch and got pressure back but tiny bubbles keep appearing every time the lever is pulled. Rides okay cold but once hot the clutch gets soft again and eventually loses pressure.", "Awaiting Approval"],
    ["WO-873037", "2022 Honda CBR 650R", "Brake squeal at low speed", "Awaiting Approval"]
  ].map(([ticket, vehicle, symptoms, status]) => ({ ticket, vehicle, symptoms, status }))
};

const TEST_ROW = /smoke test|bulk |receive test/i;
let cache = null; // { at, data }
let token = null;

function liveEnabled() {
  return process.env.DATA_MODE === "live" && process.env.SHOP_OS_EMAIL && process.env.SHOP_OS_PASSWORD;
}

async function api(path) {
  const base = (process.env.SHOP_OS_URL || "https://shop21-zeta.vercel.app").replace(/\/$/, "");
  if (!token) {
    const r = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.SHOP_OS_EMAIL, password: process.env.SHOP_OS_PASSWORD }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error("Shop-OS login failed");
    token = j.token;
  }
  const r = await fetch(base + path, { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) { token = null; throw new Error("Shop-OS session expired"); }
  if (!r.ok) throw new Error(`Shop-OS ${path} returned ${r.status}`);
  return r.json();
}

async function loadLive() {
  // GET only. The agent never writes to Shop-OS.
  const [inv, mech, jobs, settings] = await Promise.all([api("/api/inventory"), api("/api/mechanics"), api("/api/jobs"), api("/api/settings")]);
  return {
    source: "live",
    settings: {
      shopName: settings.shopName || SNAPSHOT.settings.shopName,
      laborRate: Number(settings.defaultLaborRate) || SNAPSHOT.settings.laborRate,
      taxRate: Number(settings.defaultTaxRate) || SNAPSHOT.settings.taxRate,
      diagnosticRate: Number(settings.diagnosticRate) || SNAPSHOT.settings.diagnosticRate,
      minConfidence: Number(settings.aiMinConfidence) || SNAPSHOT.settings.minConfidence
    },
    inventory: inv.filter(p => !TEST_ROW.test(p.name)).map(p => ({ id: p.id, name: p.name, partNumber: p.partNumber || "", category: p.category || "", quantity: Number(p.quantity) || 0, unitCost: Number(p.unitCost) || 0 })),
    mechanics: mech.filter(m => m.active !== false).map(m => ({ id: m.id, name: m.name, specialty: m.specialty, laborRate: Number(m.laborRate) || SNAPSHOT.settings.laborRate, availableHours: Number(m.availableHoursThisWeek) || 0 })),
    // Customer name, email and phone are dropped here on purpose.
    jobs: jobs.filter(j => !/smoke/i.test(j.clientName || "")).map(j => ({ ticket: j.ticketNumber, vehicle: `${j.vehicleYear} ${j.vehicleMake} ${j.vehicleModel}`, symptoms: j.symptomNotes || "", status: j.statusLabel || j.status }))
  };
}

export async function getShopData() {
  if (!liveEnabled()) return { source: "snapshot", ...SNAPSHOT };
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  try {
    const data = await loadLive();
    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { source: "snapshot (live API unavailable)", ...SNAPSHOT };
  }
}
