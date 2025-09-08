import React, { useEffect, useMemo, useRef, useState } from "react";

/** =======================================
 * Helpers & constants
 * ======================================= */
type ID = string;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
type DayKey = typeof DAYS[number];

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const pad2 = (n: number) => (n < 10 ? "0" + n : "" + n);
const toMin = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return clamp(parseInt(m[1]) * 60 + parseInt(m[2]), 0, 24 * 60);
};
const toHHMM = (min: number) => {
  const m = clamp(Math.round(min), 0, 24 * 60 - 1);
  return `${pad2((m / 60) | 0)}:${pad2(m % 60)}`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

/** =======================================
 * Local storage
 * ======================================= */
const LS = {
  trucks: "ts_trucks",
  clients: "ts_clients",
  jobs: "ts_jobs",
  scheduled: "ts_scheduled",
  settings: "ts_settings",
};
const load = <T,>(k: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (k: string, v: any) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

/** =======================================
 * Data models
 * ======================================= */
type Truck = { id: ID; name: string };
type Client = {
  id: ID;
  name: string;
  notes?: string;
  defaultTravelMin?: number;  // labeled below
  defaultOnsiteMin?: number;  // labeled below
};

type JobType = "Delivery" | "Collection";
type Job = {
  id: ID;
  type: JobType;
  title: string;
  clientId: ID | null;

  // Durations (minutes)
  loadMin: number;         // Delivery: depot loading; Collection: off-site loading
  travelMin: number;       // Travel to site
  onsiteMin: number;       // Delivery: offload; Collection: on-site loading
  returnTravelMin: number; // Collection: travel back to depot (Delivery often 0)

  earliest?: string; // HH:MM (soft)
  latest?: string;   // HH:MM (soft)

  truckId?: ID | null; // preferred truck (optional)
  notes?: string;
};

type ScheduledRow = {
  id: ID;
  day: DayKey;
  jobId: ID;
  truckId: ID;
  startMin: number;
  endMin: number;
};

type Settings = {
  startTime: string;
  endTime: string;
  gap: number;
  bufferBetweenJobs: number;
  activeDay: DayKey;
};

const DEFAULT_SETTINGS: Settings = {
  startTime: "07:00",
  endTime: "18:00",
  gap: 15,
  bufferBetweenJobs: 10,
  activeDay: "Mon",
};

/** =======================================
 * Supabase via CDN (reads keys from public/env.js)
 * ======================================= */
declare global {
  interface Window {
    ENV_SUPABASE_URL?: string;
    ENV_SUPABASE_ANON_KEY?: string;
  }
}
const ENV = {
  SUPABASE_URL:
    (typeof window !== "undefined" && (window as any).ENV_SUPABASE_URL) || "",
  SUPABASE_ANON:
    (typeof window !== "undefined" && (window as any).ENV_SUPABASE_ANON_KEY) || "",
};

let __sbCreateClientP: Promise<any> | null = null;
const getSbCreateClient = async () => {
  if (!__sbCreateClientP) {
    const u = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
    __sbCreateClientP = import(/* @vite-ignore */ u).then((m: any) => m.createClient);
  }
  return __sbCreateClientP;
};

/** =======================================
 * App
 * ======================================= */
export default function App() {
  // Core state
  const [trucks, setTrucks] = useState<Truck[]>(
    load<Truck[]>(LS.trucks, Array.from({ length: 10 }, (_, i) => ({ id: uid(), name: `Truck ${i + 1}` })))
  );
  const [clients, setClients] = useState<Client[]>(load<Client[]>(LS.clients, []));
  const [jobs, setJobs] = useState<Job[]>(load<Job[]>(LS.jobs, []));
  const [scheduled, setScheduled] = useState<ScheduledRow[]>(load<ScheduledRow[]>(LS.scheduled, []));
  const [settings, setSettings] = useState<Settings>(load<Settings>(LS.settings, DEFAULT_SETTINGS));
  const { startTime, endTime, gap, bufferBetweenJobs, activeDay } = settings;

  // Derived
  const startMin = toMin(startTime);
  const endMin = toMin(endTime);

  const jobById = useMemo(() => Object.fromEntries(jobs.map((j) => [j.id, j])), [jobs]);
  const clientById = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c])), [clients]);
  const truckById = useMemo(() => Object.fromEntries(trucks.map((t) => [t.id, t])), [trucks]);

  // Persist locally
  useEffect(() => save(LS.trucks, trucks), [trucks]);
  useEffect(() => save(LS.clients, clients), [clients]);
  useEffect(() => save(LS.jobs, jobs), [jobs]);
  useEffect(() => save(LS.scheduled, scheduled), [scheduled]);
  useEffect(() => save(LS.settings, settings), [settings]);

  // Guard: delete orphan schedule rows when jobs change (prevents j.type crash)
  useEffect(() => {
    setScheduled((s) => s.filter((x) => jobs.some((j) => j.id === x.jobId)));
  }, [jobs]);

  /** ============ Shared (Supabase) ============ */
  const [sharedOn, setSharedOn] = useState(false);
  const [sharedInfo, setSharedInfo] = useState<{ connected: boolean; lastSync: Date | null; error: string | null }>({
    connected: false, lastSync: null, error: null
  });
  const [supabase, setSupabase] = useState<any>(null);
  const saveDebounce = useRef<number | null>(null);

  useEffect(() => {
    let channel: any;
    let alive = true;

    (async () => {
      if (!sharedOn) {
        setSupabase(null);
        setSharedInfo({ connected: false, lastSync: null, error: null });
        return;
      }
      try {
        if (!ENV.SUPABASE_URL || !ENV.SUPABASE_ANON) throw new Error("Missing Supabase URL or anon key (env.js)");
        const createClient = await getSbCreateClient();
        const sb = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_ANON);
        setSupabase(sb);
        setSharedInfo({ connected: true, lastSync: new Date(), error: null });

        // Ensure row exists & read it
        await sb.from("app_state").upsert({ id: "shared", data: {} }).eq("id", "shared");
        const { data, error } = await sb.from("app_state").select("data").eq("id", "shared").maybeSingle();
        if (error) console.warn("initial select error:", error);
        const incoming: any = (data as any)?.data || {};
        if (incoming.trucks) setTrucks(incoming.trucks);
        if (incoming.clients) setClients(incoming.clients);
        if (incoming.jobs) setJobs(incoming.jobs);
        if (incoming.scheduled) setScheduled(incoming.scheduled);
        if (incoming.settings) setSettings((s) => ({ ...s, ...incoming.settings }));

        // Realtime updates
        channel = sb
          .channel("state")
          .on(
            "postgres_changes",
            { event: "UPDATE", schema: "public", table: "app_state", filter: "id=eq.shared" },
            (payload: any) => {
              if (!alive) return;
              const d = (payload.new && (payload.new as any).data) || {};
              if (d.trucks) setTrucks(d.trucks);
              if (d.clients) setClients(d.clients);
              if (d.jobs) setJobs(d.jobs);
              if (d.scheduled) setScheduled(d.scheduled);
              if (d.settings) setSettings((s) => ({ ...s, ...d.settings }));
              setSharedInfo((s) => ({ ...s, lastSync: new Date() }));
            }
          )
          .subscribe();
      } catch (e: any) {
        setSharedInfo({ connected: false, lastSync: null, error: String(e?.message || e) });
        console.error("shared connect error:", e);
      }
    })();

    return () => {
      alive = false;
      if (channel && supabase) {
        try { supabase.removeChannel(channel); } catch {}
      }
    };
  }, [sharedOn]); // eslint-disable-line

  // Debounced shared save
  useEffect(() => {
    if (!sharedOn || !supabase || !sharedInfo.connected) return;
    if (saveDebounce.current) window.clearTimeout(saveDebounce.current);
    saveDebounce.current = window.setTimeout(async () => {
      try {
        const data = { trucks, clients, jobs, scheduled, settings };
        const { error } = await supabase.from("app_state").update({ data }).eq("id", "shared");
        if (error) throw error;
        setSharedInfo((s) => ({ ...s, lastSync: new Date(), error: null }));
      } catch (e: any) {
        setSharedInfo((s) => ({ ...s, error: String(e?.message || e) }));
      }
    }, 350);
  }, [sharedOn, supabase, sharedInfo.connected, trucks, clients, jobs, scheduled, settings]);

  /** =======================================
   * UI actions
   * ======================================= */
  // Trucks
  const addTruck = () => setTrucks((t) => [...t, { id: uid(), name: `Truck ${t.length + 1}` }]);
  const removeTruck = (id: ID) => {
    setTrucks((t) => t.filter((x) => x.id !== id));
    setScheduled((s) => s.filter((r) => r.truckId !== id));
  };

  // Clients
  const addClient = () => setClients((c) => [...c, { id: uid(), name: "New client", defaultTravelMin: 30, defaultOnsiteMin: 30 }]);
  const updateClient = (id: ID, patch: Partial<Client>) =>
    setClients((c) => c.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeClient = (id: ID) => {
    setClients((c) => c.filter((x) => x.id !== id));
    setJobs((j) => j.map((x) => (x.clientId === id ? { ...x, clientId: null } : x)));
  };

  // Jobs
  const addJob = (type: JobType) =>
    setJobs((j) => [
      ...j,
      {
        id: uid(),
        type,
        title: `${type} Job`,
        clientId: clients[0]?.id ?? null,
        loadMin: 30,
        travelMin: 30,
        onsiteMin: 30,
        returnTravelMin: type === "Collection" ? 30 : 0,
        notes: "",
      },
    ]);
  const updateJob = (id: ID, patch: Partial<Job>) =>
    setJobs((j) => j.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeJob = (id: ID) => {
    setJobs((j) => j.filter((x) => x.id !== id));
    setScheduled((s) => s.filter((r) => r.jobId !== id));
  };

  // Place on schedule
  const placeOnSchedule = (jobId: ID, truckId: ID, day: DayKey, start: number, end: number) => {
    setScheduled((s) => [
      ...s.filter((r) => !(r.jobId === jobId && r.day === day)),
      { id: uid(), jobId, truckId, day, startMin: start, endMin: end },
    ]);
  };

  // When the client is changed on a job, apply client defaults for travel & on-site
  const onJobClientChange = (jobId: ID, newClientId: string) => {
    const client = clientById[newClientId];
    setJobs((j) =>
      j.map((x) =>
        x.id === jobId
          ? {
              ...x,
              clientId: newClientId || null,
              travelMin: client?.defaultTravelMin ?? x.travelMin,
              onsiteMin: client?.defaultOnsiteMin ?? x.onsiteMin,
            }
          : x
      )
    );
  };

  // Durations
const jobDuration = (j: Job) => {
  if (!j) return 0;
  if (j.type === "Delivery") {
    // Delivery: depot Load + Travel to site + Offload + optional Return
    return j.loadMin + j.travelMin + j.onsiteMin + (j.returnTravelMin || 0);
  }
  // Collection: Off-site Load + Travel to site + On-site load + Return
  return j.loadMin + j.travelMin + j.onsiteMin + (j.returnTravelMin || 0);
};



  // Save button: place a single job at earliest available slot today
  const earliestSlotOnTruck = (truckId: ID, dur: number) => {
    const existing = scheduled
      .filter((s) => s.day === activeDay && s.truckId === truckId && jobById[s.jobId])
      .sort((a, b) => a.startMin - b.startMin);

    const snap = (m: number) => Math.ceil(m / gap) * gap;
    let cur = toMin(settings.startTime);
    const dayEnd = toMin(settings.endTime);

    const fitsAt = (st: number) => {
      const en = st + dur;
      for (const r of existing) if (en > r.startMin && st < r.endMin) return false;
      return en <= dayEnd;
    };

    while (cur + dur <= dayEnd) {
      cur = snap(cur);
      if (fitsAt(cur)) return cur;
      cur += gap;
    }
    return null;
  };

  const saveJobToSchedule = (jobId: ID) => {
    const j = jobById[jobId];
    if (!j) return;
    const dur = jobDuration(j);

    const candidateTrucks = j.truckId ? [j.truckId] : trucks.map((t) => t.id);
    let best: { truckId: ID; start: number } | null = null;

    for (const tid of candidateTrucks) {
      const st = earliestSlotOnTruck(tid, dur);
      if (st != null && (best == null || st < best.start)) best = { truckId: tid, start: st };
    }
    if (best) {
      placeOnSchedule(jobId, best.truckId, activeDay, best.start, best.start + dur);
    } else {
      alert("No free slot within the day window. Try adjusting times or buffer.");
    }
  };

  // Segments (classic colors)
type Segment = { label: string; color: string; minutes: number };
const segmentsFor = (j: Job): Segment[] => {
  if (!j) return [];
  if (j.type === "Delivery") {
    return [
      { label: "Load",    color: "bg-sky-500",     minutes: j.loadMin },
      { label: "Travel",  color: "bg-blue-500",    minutes: j.travelMin },
      { label: "Offload", color: "bg-emerald-500", minutes: j.onsiteMin },
      { label: "Return",  color: "bg-indigo-400",  minutes: j.returnTravelMin || 0 },
    ].filter(seg => seg.minutes > 0);
  } else {
    return [
      { label: "Off-site load", color: "bg-rose-500",   minutes: j.loadMin },
      { label: "Travel",        color: "bg-orange-500", minutes: j.travelMin },
      { label: "On-site",       color: "bg-amber-500",  minutes: j.onsiteMin },
      { label: "Return",        color: "bg-orange-400", minutes: j.returnTravelMin || 0 },
    ].filter(seg => seg.minutes > 0);
  }
};



  // Simple greedy autoscheduler
  const autoSchedule = () => {
    const byTruck: Record<ID, Job[]> = {};
    for (const t of trucks) byTruck[t.id] = [];
    const unslotted: Job[] = [];
    for (const j of jobs) {
      if (j.truckId && byTruck[j.truckId]) byTruck[j.truckId].push(j);
      else unslotted.push(j);
    }
    let nextStartPerTruck: Record<ID, number> = {};
    for (const t of trucks) nextStartPerTruck[t.id] = startMin;

    const snap = (m: number) => Math.ceil(m / gap) * gap;
    const place = (j: Job, truckId: ID) => {
      const dur = jobDuration(j);
      let st = snap(nextStartPerTruck[truckId]);
      const en = st + dur;
      if (en <= endMin) {
        placeOnSchedule(j.id, truckId, activeDay, st, en);
        nextStartPerTruck[truckId] = en + bufferBetweenJobs;
        return true;
      }
      return false;
    };

    for (const t of trucks) for (const j of byTruck[t.id]) place(j, t.id);
    for (const j of unslotted) {
      let ok = false;
      for (const t of trucks) { if (place(j, t.id)) { ok = true; break; } }
      if (!ok) { /* remains unscheduled */ }
    }
  };

  // Hour ticks
  const marks = useMemo(() => {
    const res: { m: number; label: string }[] = [];
    let m = startMin - (startMin % 60);
    for (; m <= endMin; m += 60) res.push({ m, label: toHHMM(m) });
    return res;
  }, [startMin, endMin]);

  /** =======================================
   * UI
   * ======================================= */
  return (
    <div className="min-h-screen p-4 text-slate-900">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Truck Delivery &amp; Collection Scheduler</h1>
        <div className="flex items-center gap-2 ml-auto">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sharedOn} onChange={(e) => setSharedOn(e.target.checked)} />
            Shared:
            <span
              className={`text-xs ${sharedOn ? (sharedInfo.connected ? "text-green-600" : "text-slate-500") : "text-slate-500"}`}
              title={sharedInfo.error || ""}
            >
              {sharedOn ? (sharedInfo.connected ? "online" : sharedInfo.error ? "error" : "connecting…") : "off"}
            </span>
          </label>
          <div className="text-xs text-slate-500">
            {sharedInfo.lastSync ? `synced ${sharedInfo.lastSync.toLocaleTimeString()}` : ""}
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="grid md:grid-cols-3 gap-4">
        <div className="p-3 rounded-lg border bg-white">
          <div className="font-medium mb-2">Day &amp; Time</div>
          <div className="flex flex-wrap gap-2 mb-2">
            {DAYS.map((d) => (
              <button
                key={d}
                onClick={() => setSettings((s) => ({ ...s, activeDay: d }))}
                className={`px-2 py-1 rounded border ${activeDay === d ? "bg-slate-900 text-white" : "bg-white"}`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center mb-2">
            <label className="text-sm">Start</label>
            <input
              className="border rounded px-2 py-1 w-24"
              defaultValue={startTime}
              onBlur={(e) => setSettings((s) => ({ ...s, startTime: e.target.value }))}
              placeholder="07:00"
            />
            <label className="text-sm">End</label>
            <input
              className="border rounded px-2 py-1 w-24"
              defaultValue={endTime}
              onBlur={(e) => setSettings((s) => ({ ...s, endTime: e.target.value }))}
              placeholder="18:00"
            />
          </div>
          <div className="flex gap-3 items-center">
            <label className="text-sm">Gap (min)</label>
            <input
              type="number"
              className="border rounded px-2 py-1 w-20"
              value={gap}
              onChange={(e) => setSettings((s) => ({ ...s, gap: parseInt(e.target.value || "0") }))}
              min={5}
              step={5}
            />
            <label className="text-sm">Buffer (min)</label>
            <input
              type="number"
              className="border rounded px-2 py-1 w-24"
              value={bufferBetweenJobs}
              onChange={(e) => setSettings((s) => ({ ...s, bufferBetweenJobs: parseInt(e.target.value || "0") }))}
              min={0}
              step={5}
            />
            <button className="ml-auto px-3 py-1 rounded bg-slate-900 text-white" onClick={autoSchedule}>Auto</button>
          </div>
        </div>

        {/* Trucks */}
        <div className="p-3 rounded-lg border bg-white">
          <div className="flex items-center mb-2">
            <div className="font-medium">Trucks</div>
            <button className="ml-auto px-2 py-1 rounded border" onClick={addTruck}>+ Add</button>
          </div>
          <div className="space-y-2 max-h-64 overflow-auto pr-1">
            {trucks.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <input
                  className="border rounded px-2 py-1 flex-1"
                  value={t.name}
                  onChange={(e) => setTrucks((arr) => arr.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))}
                />
                <button className="px-2 py-1 rounded border" onClick={() => removeTruck(t.id)}>Del</button>
              </div>
            ))}
          </div>
        </div>

        {/* Clients (with labeled defaults) */}
        <div className="p-3 rounded-lg border bg-white">
          <div className="flex items-center mb-2">
            <div className="font-medium">Clients</div>
            <button className="ml-auto px-2 py-1 rounded border" onClick={addClient}>+ Add</button>
          </div>
          <div className="space-y-2 max-h-64 overflow-auto pr-1">
            {clients.map((c) => (
              <div key={c.id} className="grid grid-cols-5 gap-2 items-start">
                <div className="col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">Client name</label>
                  <input
                    className="border rounded px-2 py-1 w-full"
                    value={c.name}
                    onChange={(e) => updateClient(c.id, { name: e.target.value })}
                    placeholder="Client name"
                  />
                </div>

                <div className="">
                  <label className="block text-xs text-slate-500 mb-1">Default travel (min)</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-full"
                    value={c.defaultTravelMin ?? 30}
                    onChange={(e) => updateClient(c.id, { defaultTravelMin: parseInt(e.target.value || "0") })}
                    placeholder="Travel (min)"
                  />
                </div>

                <div className="">
                  <label className="block text-xs text-slate-500 mb-1">Default on-site (min)</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-full"
                    value={c.defaultOnsiteMin ?? 30}
                    onChange={(e) => updateClient(c.id, { defaultOnsiteMin: parseInt(e.target.value || "0") })}
                    placeholder="On-site (min)"
                  />
                </div>

                <div className="flex items-end">
                  <button className="px-2 py-1 rounded border w-full" onClick={() => removeClient(c.id)}>Del</button>
                </div>

                <div className="col-span-5">
                  <label className="block text-xs text-slate-500 mb-1">Notes</label>
                  <textarea
                    className="border rounded px-2 py-1 w-full"
                    value={c.notes || ""}
                    onChange={(e) => updateClient(c.id, { notes: e.target.value })}
                    placeholder="Notes"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Jobs */}
      <div className="mt-4 p-3 rounded-lg border bg-white">
        <div className="flex items-center mb-2">
          <div className="font-medium">Jobs</div>
          <div className="ml-auto flex gap-2">
            <button className="px-2 py-1 rounded border" onClick={() => addJob("Collection")}>+ Collection</button>
            <button className="px-2 py-1 rounded border" onClick={() => addJob("Delivery")}>+ Delivery</button>
          </div>
        </div>

        <div className="space-y-3 max-h-80 overflow-auto pr-1">
          {jobs.map((j) => (
            <div key={j.id} className="grid md:grid-cols-12 gap-2 items-start">
              <div className="md:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Type</label>
                <select className="border rounded px-2 py-1 w-full" value={j.type} onChange={(e) => updateJob(j.id, { type: e.target.value as JobType })}>
                  <option>Delivery</option>
                  <option>Collection</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Title</label>
                <input className="border rounded px-2 py-1 w-full" value={j.title} onChange={(e) => updateJob(j.id, { title: e.target.value })} placeholder="Title" />
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Client</label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={j.clientId || ""}
                  onChange={(e) => onJobClientChange(j.id, e.target.value)}
                >
                  <option value="">— Client —</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs text-slate-500 mb-1">Truck</label>
                <select className="border rounded px-2 py-1 w-full" value={j.truckId || ""} onChange={(e) => updateJob(j.id, { truckId: e.target.value || null })}>
                  <option value="">— Any truck —</option>
                  {trucks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  {j.type === "Delivery" ? "Load (min)" : "Off-site load (min)"}
                </label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 w-24"
                  value={j.loadMin}
                  onChange={(e) => updateJob(j.id, { loadMin: parseInt(e.target.value || "0") })}
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">Travel (min)</label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 w-24"
                  value={j.travelMin}
                  onChange={(e) => updateJob(j.id, { travelMin: parseInt(e.target.value || "0") })}
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  {j.type === "Delivery" ? "Offload (min)" : "On-site (min)"}
                </label>
                <input
                  type="number"
                  className="border rounded px-2 py-1 w-24"
                  value={j.onsiteMin}
                  onChange={(e) => updateJob(j.id, { onsiteMin: parseInt(e.target.value || "0") })}
                />
              </div>

              {j.type === "Collection" && (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Return (min)</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-28"
                    value={j.returnTravelMin}
                    onChange={(e) => updateJob(j.id, { returnTravelMin: parseInt(e.target.value || "0") })}
                  />
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-500 mb-1">Earliest (HH:MM)</label>
                <input
                  className="border rounded px-2 py-1 w-24"
                  value={j.earliest || ""}
                  onChange={(e) => updateJob(j.id, { earliest: e.target.value })}
                  placeholder="07:00"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-1">Latest (HH:MM)</label>
                <input
                  className="border rounded px-2 py-1 w-24"
                  value={j.latest || ""}
                  onChange={(e) => updateJob(j.id, { latest: e.target.value })}
                  placeholder="18:00"
                />
              </div>

              <div className="flex items-end gap-2">
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => saveJobToSchedule(j.id)}
                  title="Place this job on today's schedule"
                >
                  Save to schedule
                </button>
                <button className="px-2 py-1 rounded border" onClick={() => removeJob(j.id)}>Del</button>
              </div>

              <div className="md:col-span-12">
                <label className="block text-xs text-slate-500 mb-1">Notes</label>
                <textarea
                  className="border rounded px-2 py-1 w-full"
                  value={j.notes || ""}
                  onChange={(e) => updateJob(j.id, { notes: e.target.value })}
                  placeholder="Notes"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick place (uses CLIENT NAME) */}
      <div className="mt-4 p-3 rounded-lg border bg-white">
        <div className="font-medium mb-2">Quick place</div>
        <QuickPlace
          jobs={jobs}
          trucks={trucks}
          clients={clients}
          onPlace={(jobId, truckId) => {
            const j = jobById[jobId];
            if (!j) return;
            const dur = jobDuration(j);
            const existing = scheduled
              .filter((s) => s.day === activeDay && s.truckId === truckId && jobById[s.jobId])
              .sort((a, b) => a.startMin - b.startMin);

            const snap = (m: number) => Math.ceil(m / gap) * gap;
            let cur = toMin(settings.startTime);
            const end = toMin(settings.endTime);

            const fitsAt = (st: number) => {
              const en = st + dur;
              for (const r of existing) if (en > r.startMin && st < r.endMin) return false;
              return en <= end;
            };

            while (cur + dur <= end) {
              cur = snap(cur);
              if (fitsAt(cur)) {
                placeOnSchedule(jobId, truckId, activeDay, cur, cur + dur);
                break;
              }
              cur += gap;
            }
          }}
        />
      </div>

      {/* Schedule */}
      <div className="mt-4 p-3 rounded-lg border bg-white">
        <div className="font-medium mb-2">Schedule — {activeDay}</div>

        {/* Hour ruler with labels */}
        <div className="relative h-8 border rounded mb-2 overflow-hidden bg-white">
          {marks.map((mk) => (
            <div key={mk.m} className="absolute top-0 bottom-0" style={{ left: `${((mk.m - startMin) / (endMin - startMin)) * 100}%` }}>
              <div className="h-full w-px bg-slate-200" />
              <div className="absolute -translate-x-1/2 text-[10px] top-0">{mk.label}</div>
            </div>
          ))}
        </div>

        {/* Truck rows */}
        <div className="space-y-3">
          {trucks.map((t) => {
            const rows = scheduled
              .filter((s) =>
                s.day === activeDay &&
                s.truckId === t.id &&
                s.startMin != null &&
                s.endMin != null &&
                jobById[s.jobId] // only with existing jobs
              )
              .sort((a, b) => a.startMin - b.startMin);

            const unscheduled = scheduled
              .filter((s) =>
                s.day === activeDay && (!s.truckId || s.startMin == null || s.endMin == null)
              )
              .filter((s) => jobById[s.jobId]);

            return (
              <div key={t.id} className="border rounded">
                <div className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
                  <div className="font-medium">{t.name}</div>
                </div>

                {/* Timeline for this truck */}
                <div className="relative h-16 bg-white">
                  {marks.map((mk) => (
                    <div
                      key={mk.m + ":grid"}
                      className="absolute top-0 bottom-0"
                      style={{ left: `${((mk.m - startMin) / (endMin - startMin)) * 100}%` }}
                    >
                      <div className="h-full w-px bg-slate-100" />
                    </div>
                  ))}

                  {/* Scheduled jobs as segmented blocks */}
                  {rows.map((s) => {
                    const j = jobById[s.jobId];
                    if (!j) return null;
                    const total = Math.max(1, jobDuration(j));
                    const leftPct = ((s.startMin - startMin) / (endMin - startMin)) * 100;
                    const widthPct = ((s.endMin - s.startMin) / (endMin - startMin)) * 100;
                    const clientName = j.clientId ? (clientById[j.clientId]?.name || "Client") : "Client";
                    const segs = segmentsFor(j);

                    return (
                      <div
                        key={s.id}
                        className="absolute top-1 bottom-1 rounded border border-slate-300 bg-white/90 overflow-hidden"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 28 }}
                        title={`${j.type} • ${clientName} • ${toHHMM(s.startMin)}–${toHHMM(s.endMin)}`}
                      >
                        <div className="px-1 text-[11px] font-medium truncate">{j.type}: {clientName}</div>
                        <div className="h-[18px] w-full relative">
                          {(() => {
                            let acc = 0;
                            return segs.map((sg, i) => {
                              const w = (sg.minutes / total) * 100;
                              const l = (acc / total) * 100;
                              acc += sg.minutes;
                              if (w <= 0) return null;
                              return (
                                <div
                                  key={i}
                                  className={`absolute top-0 bottom-0 ${sg.color} text-[10px] text-white/95 flex items-center justify-center`}
                                  style={{ left: `${l}%`, width: `${w}%`, minWidth: 6 }}
                                  title={`${sg.label} • ${sg.minutes} min`}
                                >
                                  <span className="px-1 truncate">{sg.label}</span>
                                </div>
                              );
                            });
                          })()}
                        </div>
                        <div className="px-1 text-[10px] text-slate-700">{toHHMM(s.startMin)}–{toHHMM(s.endMin)}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Unscheduled chips */}
                {unscheduled.length > 0 && (
                  <div className="p-2 border-t bg-slate-50">
                    <div className="text-xs font-medium mb-1">Unscheduled for {activeDay}</div>
                    <div className="flex flex-wrap gap-2">
                      {unscheduled.map((s) => {
                        const j = jobById[s.jobId];
                        if (!j) return null;
                        const clientName = j.clientId ? (clientById[j.clientId]?.name || "Client") : "Client";
                        return (
                          <div key={s.id} className="px-2 py-1 rounded border bg-white text-xs">
                            {j.type}: {clientName}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** =======================================
 * QuickPlace component (shows CLIENT NAME)
 * ======================================= */
function QuickPlace({
  jobs, trucks, clients, onPlace,
}: {
  jobs: Job[]; trucks: Truck[]; clients: Client[]; onPlace: (jobId: ID, truckId: ID) => void;
}) {
  const [jobId, setJobId] = useState<ID>("");
  const [truckId, setTruckId] = useState<ID>("");

  const clientById = useMemo(() => Object.fromEntries(clients.map(c => [c.id, c])), [clients]);

  // Sort by display name for convenience
  const jobsWithNames = useMemo(() => {
    return jobs.map(j => {
      const name = (j.clientId && clientById[j.clientId]?.name) || j.title || "No client";
      return { ...j, __display: `${name} (${j.type})` };
    }).sort((a, b) => a.__display.localeCompare(b.__display));
  }, [jobs, clientById]);

  return (
    <div className="flex gap-2 items-center">
      <select className="border rounded px-2 py-1" value={jobId} onChange={(e) => setJobId(e.target.value)}>
        <option value="">— Job by client —</option>
        {jobsWithNames.map((j) => (
          <option key={j.id} value={j.id}>{j.__display}</option>
        ))}
      </select>
      <select className="border rounded px-2 py-1" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
        <option value="">— Truck —</option>
        {trucks.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <button
        className="px-3 py-1 rounded bg-slate-900 text-white disabled:opacity-50"
        disabled={!jobId || !truckId}
        onClick={() => onPlace(jobId, truckId)}
      >
        Place
      </button>
    </div>
  );
}
