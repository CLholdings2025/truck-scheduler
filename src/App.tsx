import React, { useEffect, useMemo, useState } from "react";

// ===== Shared storage (optional, Supabase) =====
// Load at runtime to avoid build-time CDN rewrites.
let __sbCreateClientP: Promise<any> | null = null;
const getSbCreateClient = async () => {
  if (!__sbCreateClientP) {
    const u = "https:" + "//cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
    const di: any = Function("u", "return import(u)");
    __sbCreateClientP = di(u).then((m: any) => m.createClient);
  }
  return __sbCreateClientP;
};
const ENV = {
  SUPABASE_URL:
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SUPABASE_URL) ||
    (typeof window !== "undefined" && (window as any).ENV_SUPABASE_URL) ||
    "",
  SUPABASE_ANON:
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SUPABASE_ANON_KEY) ||
    (typeof window !== "undefined" && (window as any).ENV_SUPABASE_ANON_KEY) ||
    "",
};
const SHARED_DEFAULT = !!(ENV.SUPABASE_URL && ENV.SUPABASE_ANON);

// ===== Time helpers =====
const toMin = (t: string | number) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // 6-day week

// ===== Demo / defaults =====
const DEFAULT_TRUCKS = Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, name: `Truck ${i + 1}` }));

// ===== Storage helpers =====
const LS = { trucks: "ts_trucks", clients: "ts_clients", jobs: "ts_jobs", settings: "ts_settings" } as const;
const load = (k: string, f: any) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : f; } catch { return f; } };
const save = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ===== Scheduler (pure) =====
function computeAutoSchedule({ jobs, trucks, activeDay, startMin, endMin, bufferBetweenJobs }: { jobs: any[]; trucks: any[]; activeDay: string; startMin: number; endMin: number; bufferBetweenJobs: number; }) {
  const gap = bufferBetweenJobs ?? 0;
  const avail: Record<string, number> = Object.fromEntries(trucks.map((t) => [t.id, startMin]));
  const out: any[] = [];
  const dayJobs = jobs
    .filter((j) => j.day === activeDay)
    .sort((a, b) => a.priority - b.priority || toMin(a.earliest) - toMin(b.earliest) || (((b.type === "Delivery" ? b.loadMins || 0 : 0) + b.travelMins + b.onsiteMins + (b.returnMins || 0) + (b.type === "Collection" ? b.offloadMins || 0 : 0)) - ((a.type === "Delivery" ? a.loadMins || 0 : 0) + a.travelMins + a.onsiteMins + (a.returnMins || 0) + (a.type === "Collection" ? a.offloadMins || 0 : 0))));
  for (const j of dayJobs) {
    const earliest = Math.max(startMin, toMin(j.earliest));
    const dur = (j.type === "Delivery" ? j.loadMins || 0 : 0) + j.travelMins + j.onsiteMins + (j.returnMins || 0) + (j.type === "Collection" ? j.offloadMins || 0 : 0);
    const tryPlace = (t: any) => { const st = Math.max(avail[t.id], earliest); const en = st + dur; if (en <= endMin) { out.push({ jobId: j.id, truckId: t.id, startMin: st, endMin: en, day: activeDay }); avail[t.id] = en + gap; return true; } return false; };
    if (j.assignedTruckId) { const t = trucks.find((x) => x.id === j.assignedTruckId); if (!t || !tryPlace(t)) out.push({ jobId: j.id, truckId: null, startMin: null, endMin: null, day: activeDay }); continue; }
    let placed = false; for (const t of [...trucks].sort((a, b) => avail[a.id] - avail[b.id])) { if (tryPlace(t)) { placed = true; break; } } if (!placed) out.push({ jobId: j.id, truckId: null, startMin: null, endMin: null, day: activeDay });
  }
  return out;
}
const nextTruckId = (trucks: any[]) => `T${trucks.reduce((m, t) => Math.max(m, parseInt(String(t.id).slice(1)) || 0), 0) + 1}`;

// ===== App =====
export default function App() {
  // Core
  const [activeDay, setActiveDay] = useState(load(LS.settings, {}).activeDay ?? DAYS[0]);
  const [trucks, setTrucks] = useState(() => load(LS.trucks, DEFAULT_TRUCKS));
  const [startTime, setStartTime] = useState(load(LS.settings, {}).startTime ?? "07:00");
  const [endTime, setEndTime] = useState(load(LS.settings, {}).endTime ?? "18:00");
  const [gap, setGap] = useState(load(LS.settings, {}).gap ?? 10);
  const [fleetDesired, setFleetDesired] = useState<number>(Array.isArray(trucks) ? trucks.length : 0);

  // Shared storage
  const [sharedOn, setSharedOn] = useState(SHARED_DEFAULT);
  const [sharedInfo, setSharedInfo] = useState<{ connected: boolean; lastSync: Date | null; error: string | null }>({ connected: false, lastSync: null, error: null });
  const [supabase, setSupabase] = useState<any>(null);
  const clientId = useMemo(() => Math.random().toString(36).slice(2), []);

  // Clients & Jobs
  const [clients, setClients] = useState<any[]>(() => load(LS.clients, []));
  const [editingClient, setEditingClient] = useState<string | null>(null);
  const [jobs, setJobs] = useState<any[]>(() => load(LS.jobs, []));
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [addType, setAddType] = useState("Delivery");
  const [scheduled, setScheduled] = useState<any[]>([]);

  // Derived
  const startMin = toMin(startTime), endMin = toMin(endTime);
  const jobById = useMemo(() => Object.fromEntries(jobs.map((j: any) => [j.id, j])), [jobs]);

  // Effects: schedule + persist
  const autoSchedule = () => setScheduled((prev) => [
    ...prev.filter((s) => s.day !== activeDay),
    ...computeAutoSchedule({ jobs, trucks, activeDay, startMin, endMin, bufferBetweenJobs: gap }),
  ]);
  const truckIdsKey = useMemo(() => (Array.isArray(trucks) ? trucks : []).map((t: any) => t.id).join(","), [trucks]);
  useEffect(() => { autoSchedule(); }, [jobs, activeDay, startTime, endTime, gap, truckIdsKey]);
  useEffect(() => { save(LS.trucks, trucks); }, [trucks]);
  useEffect(() => { save(LS.clients, clients); }, [clients]);
  useEffect(() => { save(LS.jobs, jobs); }, [jobs]);
  useEffect(() => { save(LS.settings, { startTime, endTime, gap, activeDay }); }, [startTime, endTime, gap, activeDay]);

  // Shared storage connect
  useEffect(() => {
    let channel: any; let alive = true;
    (async () => {
      if (!sharedOn) { setSupabase(null); setSharedInfo((s) => ({ ...s, connected: false })); return; }
      try {
        const createClient = await getSbCreateClient();
        const sb = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON);
        setSupabase(sb);
        const { data, error } = await sb.from("app_state").select("data").eq("id", "shared").single();
        if (error && (error.code === "PGRST116" || (error.message || "").toLowerCase().includes("row"))) { await sb.from("app_state").upsert({ id: "shared", data: {} }); }
        const incoming = (data && (data as any).data) || {};
        if (incoming.trucks) setTrucks(incoming.trucks);
        if (incoming.clients) setClients(incoming.clients);
        if (incoming.jobs) setJobs(incoming.jobs);
        if (incoming.settings) { const s = incoming.settings; if (s.startTime) setStartTime(s.startTime); if (s.endTime) setEndTime(s.endTime); if (typeof s.gap === "number") setGap(s.gap); if (s.activeDay) setActiveDay(s.activeDay); }
        setSharedInfo({ connected: true, lastSync: new Date(), error: null });
        channel = sb.channel("state").on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_state", filter: "id=eq.shared" }, (payload: any) => {
          if (!alive) return; const d = payload.new?.data; if (!d || d._meta?.clientId === clientId) return;
          if (d.trucks) setTrucks(d.trucks); if (d.clients) setClients(d.clients); if (d.jobs) setJobs(d.jobs);
          if (d.settings) { const s = d.settings; if (s.startTime) setStartTime(s.startTime); if (s.endTime) setEndTime(s.endTime); if (typeof s.gap === "number") setGap(s.gap); if (s.activeDay) setActiveDay(s.activeDay); }
          setSharedInfo((s) => ({ ...s, lastSync: new Date() }));
        }).subscribe();
      } catch (e: any) {
        setSharedInfo({ connected: false, lastSync: null, error: String(e?.message || e) });
      }
    })();
    return () => { alive = false; if (channel && supabase) { try { supabase.removeChannel(channel); } catch {} } };
  }, [sharedOn]);

  // Shared save (debounced)
  useEffect(() => { if (!supabase || !sharedOn) return; const h = setTimeout(async () => { try { await supabase.from("app_state").upsert({ id: "shared", data: { trucks, clients, jobs, settings: { startTime, endTime, gap, activeDay }, _meta: { clientId, ts: Date.now() } } }); setSharedInfo((s) => ({ ...s, lastSync: new Date(), error: null })); } catch (e: any) { setSharedInfo((s) => ({ ...s, error: String(e?.message || e) })); } }, 600); return () => clearTimeout(h); }, [trucks, clients, jobs, startTime, endTime, gap, activeDay, supabase, sharedOn]);

  // Fleet edit
  const addTruck = () => { const id = nextTruckId(trucks); setTrucks((a: any[]) => [...a, { id, name: `Truck ${id.replace(/^T/, "")}` }]); setFleetDesired((v) => v + 1); };
  const removeTruckById = (id: string) => { setTrucks((a: any[]) => a.filter((t) => t.id !== id)); setJobs((js: any[]) => js.map((j) => (j.assignedTruckId === id ? { ...j, assignedTruckId: null } : j))); setScheduled((s: any[]) => s.filter((x) => x.truckId !== id)); setFleetDesired((v) => Math.max(0, v - 1)); };
  const applyFleetDesired = () => {
    let n = Number(fleetDesired) || 0; if (n < 0) n = 0; if (n === trucks.length) return;
    if (n > trucks.length) { setTrucks((a: any[]) => { let arr = [...a]; for (let k = 0; k < n - a.length; k++) { const id = nextTruckId(arr); arr = [...arr, { id, name: `Truck ${id.replace(/^T/, "")}` }]; } return arr; }); }
    else { const removeIds = [...trucks].sort((a: any, b: any) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1))).slice(-(trucks.length - n)).map((t: any) => t.id); setTrucks((a: any[]) => a.filter((t) => !removeIds.includes(t.id))); setJobs((js: any[]) => js.map((j) => (removeIds.includes(j.assignedTruckId) ? { ...j, assignedTruckId: null } : j))); setScheduled((s: any[]) => s.filter((x) => !removeIds.includes(x.truckId))); }
  };

  // Print run sheets
  const printSheets = () => {
    const byId: Record<string, any> = Object.fromEntries(jobs.map((j: any) => [j.id, j]));
    const groups: Record<string, any[]> = {};
    for (const s of scheduled.filter((x) => x.day === activeDay)) { const j = byId[s.jobId]; const t = s.truckId || "Unassigned"; (groups[t] ??= []).push({ ...s, job: j }); }
    Object.values(groups).forEach((a: any) => a.sort((x: any, y: any) => (x.startMin ?? 9e9) - (y.startMin ?? 9e9)));
    const w = window.open("", "runsheets"); if (!w) return;
    const css = `<style>body{font-family:system-ui;margin:24px;color:#0f172a}h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:16px 0 8px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #cbd5e1;padding:6px 8px;font-size:12px}.muted{color:#64748b}.pb{page-break-after:always}</style>`;
    let html = `${css}<h1>Driver Run Sheets</h1><div class="muted">${activeDay} · ${startTime}–${endTime} · ${new Date().toLocaleString()}</div>`;
    for (const [k, a] of Object.entries(groups)) { html += `<h2>${k}</h2><table><thead><tr><th>#</th><th>Client</th><th>Type</th><th>Start</th><th>End</th><th>Load</th><th>Travel</th><th>On-site</th><th>Return</th><th>Offload</th><th>Notes</th></tr></thead><tbody>`; (a as any[]).forEach((s: any, i: number) => { html += `<tr><td>${i + 1}</td><td>${s.job.client}</td><td>${s.job.type}</td><td>${s.startMin == null ? "—" : hhmm(s.startMin)}</td><td>${s.endMin == null ? "—" : hhmm(s.endMin)}</td><td>${s.job.loadMins || 0}m</td><td>${s.job.travelMins}m</td><td>${s.job.onsiteMins}m</td><td>${s.job.returnMins || 0}m</td><td>${s.job.offloadMins || 0}m</td><td>${(s.job.notes || "").replace(/</g, "&lt;")}</td></tr>`; }); html += `</tbody></table><div class="pb"></div>`; }
    w.document.write(html); w.document.close(); w.print();
  };

  // Minimal self-tests
  useEffect(() => {
    try {
      console.assert(DAYS.length === 6 && DAYS[0] === "Mon" && DAYS[5] === "Sat", "6-day week");
      console.assert(toMin("07:30") === 450 && hhmm(450) === "07:30", "time helpers");
      const t = [{ id: "T1", name: "T1" }, { id: "T2", name: "T2" }];
      const j1 = [{ id: "J", client: "C", type: "Delivery", day: "Mon", earliest: "07:00", loadMins: 10, travelMins: 20, onsiteMins: 30, returnMins: 20, offloadMins: 0, priority: 1 }];
      const s1 = computeAutoSchedule({ jobs: j1 as any, trucks: t as any, activeDay: "Mon", startMin: 420, endMin: 1080, bufferBetweenJobs: 0 });
      console.assert(s1[0].endMin - s1[0].startMin === 80, "duration calc");
      const j2 = [{ id: "J2", client: "C2", type: "Collection", day: "Mon", earliest: "07:00", travelMins: 10, onsiteMins: 10, returnMins: 10, offloadMins: 5, priority: 1, assignedTruckId: "T2" }];
      const s2 = computeAutoSchedule({ jobs: j2 as any, trucks: t as any, activeDay: "Mon", startMin: 420, endMin: 1080, bufferBetweenJobs: 0 });
      console.assert(s2[0].truckId === "T2", "respects assignedTruckId");
    } catch (e) { console.error("self-tests", e); }
  }, []);

  // UI atom
  const Card = ({ title, children, actions }: { title: string; children: any; actions?: any }) => (
    <section className="bg-white rounded-xl p-4 shadow-sm border mb-6">
      <div className="flex items-center justify-between mb-3"><h2 className="text-lg font-semibold">{title}</h2>{actions}</div>
      {children}
    </section>
  );

  // ===== Render =====
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-6xl mx-auto p-4 md:p-6">
        <header className="flex items-center justify-between gap-4 mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">Truck Scheduler</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center gap-1 bg-white border rounded-lg p-1">
              {DAYS.map((d) => (
                <button key={d} className={`px-2 py-1 rounded-md text-sm ${activeDay === d ? "bg-slate-800 text-white" : "hover:bg-slate-100"}`} onClick={() => setActiveDay(d)}>{d}</button>
              ))}
            </div>
               <button
      className="px-3 py-2 rounded-lg bg-slate-800 text-white"
      onClick={autoSchedule}
    >
      Auto
    </button>

    <button
      className="px-3 py-2 rounded-lg bg-white border"
      onClick={() => setScheduled([])}
    >
      Clear
    </button>

    <button
      className="px-3 py-2 rounded-lg bg-white border"
      onClick={printSheets}
    >
      Print
    </button>

    <div className="flex items-center gap-2 pl-2 border-l ml-1">
      <label className="text-xs text-slate-600">Shared</label>
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={sharedOn}
        onChange={(e) => setSharedOn(e.target.checked)}
      />
      <span
        className={`text-xs ${
          sharedOn
            ? sharedInfo.connected
              ? "text-green-600"
              : "text-slate-500"
            : "text-slate-500"
        }`}
      >
        {sharedOn ? (sharedInfo.connected ? "online" : "connecting…") : "off"}
      </span>
    </div>
  </div>
</header>
</div></div></div></div></div></div></div></div></div></div></div>
