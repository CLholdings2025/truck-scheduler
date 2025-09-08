function QuickPlace({
  jobs, trucks, clients, onPlace,
}: {
  jobs: Job[]; trucks: Truck[]; clients: Client[]; onPlace: (jobId: ID, truckId: ID) => void;
}) {
  const [jobId, setJobId] = useState<ID>("");
  const [truckId, setTruckId] = useState<ID>("");

  const clientById = useMemo(() => Object.fromEntries(clients.map(c => [c.id, c])), [clients]);

  return (
    <div className="flex gap-2 items-center">
      <select className="border rounded px-2 py-1" value={jobId} onChange={(e) => setJobId(e.target.value)}>
        <option value="">— Job by client —</option>
        {jobs.map((j) => {
          const clientName =
            (j.clientId && clientById[j.clientId]?.name) ||
            j.title ||                              // fallback to job title if client missing
            "No client";
          return (
            <option key={j.id} value={j.id}>
              {clientName} ({j.type})
            </option>
          );
        })}
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
