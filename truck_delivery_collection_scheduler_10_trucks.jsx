import React, { useEffect, useMemo, useState } from "react";

// ===== Shared storage (optional, Supabase) =====
// Load at runtime to avoid build-time CDN rewrites.
let __sbCreateClientP: Promise<any> | null = null;
const getSbCreateClient = async () => {
  if (!__sbCreateClientP) {
    const u = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
    // Use dynamic import without Function/eval; prevent Vite from rewriting it
    __sbCreateClientP = import(/* @vite-ignore */ u).then((m: any) => m.createClient);
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
            <button className="px-3 py-2 rounded-lg bg-slate-800 text-white" onClick={autoSchedule}>Auto</button>
            <button className="px-3 py-2 rounded-lg bg-white border" onClick={() => setScheduled([])}>Clear</button>
            <button className="px-3 py-2 rounded-lg bg-white border" onClick={printSheets}>Print</button>
            <div className="flex items-center gap-2 pl-2 border-l ml-1">
              <label className="text-xs text-slate-600">Shared</label>
              <input type="checkbox" className="h-4 w-4" checked={sharedOn} onChange={(e) => setSharedOn(e.target.checked)} />
              <span className={`text-xs ${sharedOn ? (sharedInfo.connected ? "text-green-600" : "text-slate-500") : "text-slate-500"}`} title={sharedInfo.error || ""}>{sharedOn ? (sharedInfo.connected ? "online" : (sharedInfo.error ? "error" : "connecting…")) : "off"}</span>
            </div>
          </div>
        </header>

        <Card title="Settings">
          <div className="grid md:grid-cols-3 gap-3">
            <div><label className="block text-sm">Start</label><input type="time" className="mt-1 w-full border rounded px-2 py-1" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
            <div><label className="block text-sm">End</label><input type="time" className="mt-1 w-full border rounded px-2 py-1" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
            <div><label className="block text-sm">Gap (min)</label><input type="number" min={0} className="mt-1 w-full border rounded px-2 py-1" value={gap} onChange={(e) => setGap(Number(e.target.value))} /></div>
          </div>
        </Card>

        <Card title="Trucks" actions={<div className="flex items-center gap-2"><input type="number" min={0} className="border rounded px-2 py-1 w-24" value={fleetDesired} onChange={(e) => setFleetDesired(Number(e.target.value))} /><button className="px-2 py-1 rounded border" onClick={applyFleetDesired}>Set count</button><button className="px-2 py-1 rounded border" onClick={addTruck}>Add truck</button></div>}>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {trucks.map((t: any) => (
              <div key={t.id} className="border rounded p-3 flex items-center justify-between gap-3">
                <div className="grow min-w-0">
                  <input className="border rounded px-2 py-1 text-sm w-40" value={t.name} onChange={(e) => setTrucks((a: any[]) => a.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))} />
                  <div className="text-xs text-slate-600 truncate">ID: {t.id}</div>
                </div>
                <button className="text-rose-600 text-sm" onClick={() => removeTruckById(t.id)}>Remove</button>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid lg:grid-cols-2 gap-6">
          <Card title="Add Job" actions={<button form="addJob" type="submit" className="px-3 py-2 rounded-lg bg-slate-800 text-white">Add</button>}>
            <form id="addJob" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const type = String(f.get('type')); const job: any = { id: `J${Date.now()}`, client: String(f.get('client') || ''), type, day: String(f.get('day') || activeDay), earliest: String(f.get('earliest') || '07:00'), loadMins: type === 'Delivery' ? Number(f.get('loadMins') || 0) : 0, travelMins: Number(f.get('travelMins') || 0), onsiteMins: Number(f.get('onsiteMins') || 0), returnMins: Number(f.get('returnMins') || 0), offloadMins: type === 'Collection' ? Number(f.get('offloadMins') || 0) : 0, notes: String(f.get('notes') || ''), priority: Number(f.get('priority') || 3), assignedTruckId: null }; setJobs((j) => [...j, job]); (e.target as HTMLFormElement).reset(); setAddType('Delivery'); }} className="grid grid-cols-2 gap-3">
              <div><label className="block text-sm">Type</label><select name="type" className="mt-1 w-full border rounded px-2 py-1" value={addType} onChange={(e) => setAddType(e.target.value)}><option>Delivery</option><option>Collection</option></select></div>
              <div><label className="block text-sm">Day</label><select name="day" className="mt-1 w-full border rounded px-2 py-1" defaultValue={activeDay}>{DAYS.map((d) => (<option key={d} value={d}>{d}</option>))}</select></div>
              <div><label className="block text-sm">Earliest</label><input type="time" name="earliest" className="mt-1 w-full border rounded px-2 py-1" defaultValue={startTime} /></div>
              <div className="col-span-2"><label className="block text-sm">Client</label><input name="client" list="clientNames" className="mt-1 w-full border rounded px-2 py-1" placeholder="Type or pick a client" /><datalist id="clientNames">{clients.map((c: any) => (<option key={c.name} value={c.name} />))}</datalist></div>
              {addType === 'Delivery' ? (<div><label className="block text-sm">Load (min)</label><input type="number" name="loadMins" min={0} className="mt-1 w-full border rounded px-2 py-1" defaultValue={0} /></div>) : (<div><label className="block text-sm">Offload (min)</label><input type="number" name="offloadMins" min={0} className="mt-1 w-full border rounded px-2 py-1" defaultValue={0} /></div>)}
              <div><label className="block text-sm">Travel (min)</label><input type="number" name="travelMins" min={0} className="mt-1 w-full border rounded px-2 py-1" required /></div>
              <div><label className="block text-sm">On-site (min)</label><input type="number" name="onsiteMins" min={0} className="mt-1 w-full border rounded px-2 py-1" required /></div>
              <div><label className="block text-sm">Return (min)</label><input type="number" name="returnMins" min={0} className="mt-1 w-full border rounded px-2 py-1" defaultValue={0} /></div>
              <div><label className="block text-sm">Priority</label><input type="number" name="priority" min={1} max={5} defaultValue={3} className="mt-1 w-full border rounded px-2 py-1" /></div>
              <div className="col-span-2"><label className="block text-sm">Notes</label><input name="notes" className="mt-1 w-full border rounded px-2 py-1" placeholder="Gate code, forklift, etc." /></div>
            </form>
          </Card>

          <Card title="Client Directory">
            <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const name = String(f.get('clientName') || '').trim(); if (!name) return; const travel = Number(f.get('clientTravel') || 0), onsite = Number(f.get('clientOnsite') || 0), notes = String(f.get('clientNotes') || ''); setClients((prev: any[]) => { const i = prev.findIndex((c) => c.name.toLowerCase() === name.toLowerCase()); const def = { travelMins: travel, onsiteMins: onsite, notes }; if (i === -1) return [...prev, { name, defaults: def }]; const cp = [...prev]; cp[i] = { ...cp[i], defaults: def }; return cp; }); (e.target as HTMLFormElement).reset(); }} className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
              <div className="md:col-span-2"><label className="block text-sm">Client name</label><input name="clientName" className="mt-1 w-full border rounded px-2 py-1" required /></div>
              <div><label className="block text-sm">Travel (min)</label><input name="clientTravel" type="number" min={0} className="mt-1 w-full border rounded px-2 py-1" required /></div>
              <div><label className="block text-sm">On-site (min)</label><input name="clientOnsite" type="number" min={0} className="mt-1 w-full border rounded px-2 py-1" required /></div>
              <div className="md:col-span-2"><label className="block text-sm">Notes</label><input name="clientNotes" className="mt-1 w-full border rounded px-2 py-1" /></div>
              <div className="md:col-span-6 flex justify-end"><button type="submit" className="px-3 py-2 rounded-lg bg-white border">Save Defaults</button></div>
            </form>
            <ul className="space-y-2 max-h-64 overflow-auto">
              {clients.map((c: any) => (
                <li key={c.name} className="p-3 border rounded-lg">
                  {editingClient === c.name ? (
                    <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const newName = String(f.get('name') || c.name).trim() || c.name; const newDefs = { travelMins: Number(f.get('t') || c.defaults.travelMins), onsiteMins: Number(f.get('o') || c.defaults.onsiteMins), notes: String(f.get('n') || c.defaults.notes || '') }; setClients((prev: any[]) => prev.map((x) => (x.name === c.name ? { name: newName, defaults: newDefs } : x))); setJobs((prev: any[]) => prev.map((j) => (j.client === c.name ? { ...j, client: newName } : j))); setEditingClient(null); }} className="space-y-2">
                      <div className="flex items-center justify-between"><input name="name" defaultValue={c.name} className="border rounded px-2 py-1 text-sm w-64" /><div className="flex gap-2"><button type="submit" className="px-2 py-1 rounded bg-slate-800 text-white">Save</button><button type="button" className="px-2 py-1 rounded border" onClick={() => setEditingClient(null)}>Cancel</button><button type="button" className="px-2 py-1 rounded border text-rose-600" onClick={() => { const used = jobs.filter((j) => j.client === c.name).length; if (used > 0) { const repl = window.prompt(`Client \"${c.name}\" is used in ${used} job(s). Enter replacement, or blank to clear:`, ''); if (repl === null) return; setJobs((prev) => prev.map((j) => (j.client === c.name ? { ...j, client: repl } : j))); } setClients((prev) => prev.filter((x) => x.name !== c.name)); }}>Delete</button></div></div>
                      <div className="grid md:grid-cols-3 gap-2 text-sm"><div className="bg-slate-50 rounded p-2 border space-y-1"><div className="text-slate-600 text-xs">Defaults</div><div className="flex items-center gap-2"><span className="w-16">Travel</span><input name="t" type="number" defaultValue={c.defaults.travelMins} className="border rounded px-2 py-1 w-24" /></div><div className="flex items-center gap-2"><span className="w-16">On-site</span><input name="o" type="number" defaultValue={c.defaults.onsiteMins} className="border rounded px-2 py-1 w-24" /></div><input name="n" defaultValue={c.defaults.notes || ''} className="border rounded px-2 py-1 w-full" placeholder="Notes" /></div></div>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between"><div className="font-medium">{c.name}</div><div className="flex gap-2"><button type="button" className="px-2 py-1 rounded-lg bg-white border" onClick={() => setEditingClient(c.name)}>Edit</button><button type="button" className="px-2 py-1 rounded-lg border text-rose-600" onClick={() => { const used = jobs.filter((j) => j.client === c.name).length; if (used > 0) { const repl = window.prompt(`Client \"${c.name}\" is used in ${used} job(s). Enter replacement, or blank to clear:`, ''); if (repl === null) return; setJobs((prev) => prev.map((j) => (j.client === c.name ? { ...j, client: repl } : j))); } setClients((prev) => prev.filter((x) => x.name !== c.name)); }}>Delete</button></div></div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card title="Jobs">
          {jobs.length === 0 && <div className="text-slate-500">No jobs yet.</div>}
          <ul className="space-y-2">
            {jobs.filter((j: any) => j.day === activeDay).map((j: any) => (
              <li key={j.id} className="p-3 border rounded-lg">
                {editingJobId === j.id ? (
                  <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget as HTMLFormElement); const next: any = { ...j, client: String(f.get('client') || j.client), type: String(f.get('type') || j.type), day: String(f.get('day') || j.day), earliest: String(f.get('earliest') || j.earliest), loadMins: Number(f.get('loadMins') || j.loadMins || 0), offloadMins: Number(f.get('offloadMins') || j.offloadMins || 0), travelMins: Number(f.get('travelMins') || j.travelMins), onsiteMins: Number(f.get('onsiteMins') || j.onsiteMins), returnMins: Number(f.get('returnMins') || j.returnMins || 0), priority: Number(f.get('priority') || j.priority || 3), assignedTruckId: (String(f.get('assignedTruckId') || j.assignedTruckId || '') || null), notes: String(f.get('notes') || j.notes || '') }; setJobs((all) => all.map((x) => (x.id === j.id ? next : x))); setEditingJobId(null); }} className="grid md:grid-cols-6 gap-2">
                    <div className="md:col-span-2"><label className="block text-xs">Client</label><input name="client" defaultValue={j.client} list="clientNames" className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Type</label><select name="type" defaultValue={j.type} className="mt-1 w-full border rounded px-2 py-1"><option>Delivery</option><option>Collection</option></select></div>
                    <div><label className="block text-xs">Day</label><select name="day" defaultValue={j.day} className="mt-1 w-full border rounded px-2 py-1">{DAYS.map((d) => (<option key={d} value={d}>{d}</option>))}</select></div>
                    <div><label className="block text-xs">Earliest</label><input type="time" name="earliest" defaultValue={j.earliest} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Load (Delivery)</label><input type="number" name="loadMins" min={0} defaultValue={j.loadMins || 0} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Offload (Collection)</label><input type="number" name="offloadMins" min={0} defaultValue={j.offloadMins || 0} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Travel</label><input type="number" name="travelMins" min={0} defaultValue={j.travelMins} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">On-site</label><input type="number" name="onsiteMins" min={0} defaultValue={j.onsiteMins} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Return</label><input type="number" name="returnMins" min={0} defaultValue={j.returnMins || 0} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div><label className="block text-xs">Priority</label><input type="number" name="priority" min={1} max={5} defaultValue={j.priority || 3} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div className="md:col-span-2"><label className="block text-xs">Assign Truck</label><select name="assignedTruckId" defaultValue={j.assignedTruckId || ''} className="mt-1 w-full border rounded px-2 py-1"><option value="">— Unassigned —</option>{trucks.map((t: any) => (<option key={t.id} value={t.id}>{t.name} ({t.id})</option>))}</select></div>
                    <div className="md:col-span-6"><label className="block text-xs">Notes</label><input name="notes" defaultValue={j.notes || ''} className="mt-1 w-full border rounded px-2 py-1" /></div>
                    <div className="md:col-span-6 flex justify-end gap-2"><button className="px-2 py-1 rounded bg-slate-800 text-white" type="submit">Save</button><button className="px-2 py-1 rounded border" type="button" onClick={() => setEditingJobId(null)}>Cancel</button><button className="px-2 py-1 rounded border text-rose-600" type="button" onClick={() => { setJobs((all) => all.filter((x) => x.id !== j.id)); setScheduled((s) => s.filter((x) => x.jobId !== j.id)); }}>Delete</button></div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{j.client} · {j.type}</div>
                      <div className="text-xs text-slate-600">Earliest {j.earliest} · Travel {j.travelMins}m · On-site {j.onsiteMins}m · Return {j.returnMins || 0}m {j.type === 'Delivery' ? `· Load ${j.loadMins || 0}m` : ''}{j.type === 'Collection' ? ` · Offload ${j.offloadMins || 0}m` : ''}</div>
                    </div>
                    <div className="flex items-center gap-2"><span className="text-xs text-slate-600">Truck: {j.assignedTruckId || '—'}</span><button className="px-2 py-1 rounded-lg bg-white border" onClick={() => setEditingJobId(j.id)}>Edit</button></div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title={`Schedule (auto for ${activeDay})`}>
          {(() => {
            const total = endMin - startMin;
            const marks: number[] = [];
            for (let m = startMin; m <= endMin; m += 60) marks.push(m);
            const pct = (val: number) => (100 * (val - startMin)) / total;
            const unscheduled = scheduled.filter((s: any) => s.day === activeDay && (!s.truckId || s.startMin == null || s.endMin == null));
            const legend = [
              { k: 'Load', c: 'bg-amber-300' },
              { k: 'Travel', c: 'bg-sky-300' },
              { k: 'On-site', c: 'bg-green-300' },
              { k: 'Return', c: 'bg-indigo-300' },
              { k: 'Offload', c: 'bg-rose-300' },
            ];
            const segs = (j: any) => {
              const arr: { k: string; m: number; c: string }[] = [];
              if (j.type === 'Delivery' && (j.loadMins || 0) > 0) arr.push({ k: 'Load', m: j.loadMins || 0, c: 'bg-amber-300' });
              arr.push({ k: 'Travel', m: j.travelMins || 0, c: 'bg-sky-300' });
              arr.push({ k: 'On-site', m: j.onsiteMins || 0, c: 'bg-green-300' });
              if ((j.returnMins || 0) > 0) arr.push({ k: 'Return', m: j.returnMins || 0, c: 'bg-indigo-300' });
              if (j.type === 'Collection' && (j.offloadMins || 0) > 0) arr.push({ k: 'Offload', m: j.offloadMins || 0, c: 'bg-rose-300' });
              return arr.filter((x) => x.m > 0);
            };
            return (
              <div className="space-y-3">
                {/* Legend & timeline header */}
                <div className="flex items-center justify-between">
                  <div className="flex gap-3">{legend.map((l) => (<div key={l.k} className="flex items-center gap-1 text-xs"><span className={`inline-block w-3 h-3 rounded ${l.c}`}></span><span>{l.k}</span></div>))}</div>
                  <div className="relative h-6 flex-1 ml-4">
                    {marks.map((m) => (
                      <div key={m} className="absolute top-0 bottom-0 border-l border-slate-200"><div className="absolute -top-5 text-[10px] text-slate-600" style={{ left: 0, transform: 'translateX(-50%)' }}>{hhmm(m)}</div></div>
                    ))}
                    {/* position marks */}
                    {marks.map((m) => (
                      <div key={m+':pos'} className="absolute top-0 bottom-0 border-l border-slate-200" style={{ left: pct(m) + '%' }} />
                    ))}
                  </div>
                </div>

                {/* Per-truck rows with hour grid + blocks */}
                <div className="space-y-2">
                  {trucks.map((t: any) => {
                    const rows = scheduled
                      .filter((s: any) => s.day === activeDay && s.truckId === t.id && s.startMin != null && s.endMin != null)
                      .sort((a: any, b: any) => (a.startMin ?? 9e9) - (b.startMin ?? 9e9));
                    return (
                      <div key={t.id} className="border rounded p-2">
                        <div className="font-medium mb-1">{t.name}</div>
                        <div className="relative h-9 bg-slate-50 rounded">
                          {/* hour grid */}
                          {marks.map((m, i) => (
                            <div key={m+':grid'} className={`absolute top-0 bottom-0 ${i === 0 ? 'border-l' : ''} border-slate-200`} style={{ left: pct(m) + '%' }} />
                          ))}
                          {/* job blocks */}
                          {rows.map((s: any) => {
                            const j = jobById[s.jobId];
                            const left = Math.max(0, pct(s.startMin));
                            const width = Math.max(0.8, pct(s.endMin) - pct(s.startMin));
                            const parts = segs(j);
                            const dur = parts.reduce((a, b) => a + b.m, 0) || 1;
                            return (
                              <div key={s.jobId + ':' + s.startMin} className="absolute top-1 h-7 rounded border border-slate-400 overflow-hidden shadow-sm" style={{ left: left + '%', width: width + '%' }} title={`${j.client} · ${j.type} · ${hhmm(s.startMin)}–${hhmm(s.endMin)}`}>
                                <div className="h-full flex">
                                  {parts.map((p) => (
                                    <div key={p.k} className={`h-full ${p.c}`} style={{ width: (100 * p.m) / dur + '%' }} />
                                  ))}
                                </div>
                                <div className="absolute inset-0 px-1 text-[10px] flex items-center justify-between bg-black/10 text-slate-900">
                                  <span className="truncate max-w-[60%]">{j.client} · {j.type}</span>
                                  <span>{hhmm(s.startMin)}–{hhmm(s.endMin)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Unscheduled bucket */}
                {unscheduled.length > 0 && (
                  <div className="border rounded p-2">
                    <div className="font-medium mb-1">Unscheduled</div>
                    <ul className="text-sm space-y-1">
                      {unscheduled.map((s: any) => { const j = jobById[s.jobId]; return (
                        <li key={'u:'+s.jobId} className="flex items-center justify-between"><span>{j.client} · {j.type}</span><span className="text-slate-600">Earliest {j.earliest}</span></li>
                      ); })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </Card>
      </div>
    </div>
  );
}
