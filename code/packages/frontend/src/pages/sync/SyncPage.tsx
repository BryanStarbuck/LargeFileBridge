// The Sync page (scan.mdx §7, storage.mdx §13): both workers' installed/on-off + control.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WorkerKind, WorkerState } from "@lfb/shared";
import { api } from "../../api/client.js";
import { relativeTime } from "../../lib/format.js";

export function SyncPage() {
  const { data } = useQuery({ queryKey: ["syncPage"], queryFn: api.syncPage, refetchInterval: 10_000 });
  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Sync</h1>
      <p className="mb-4 text-sm text-black/60">
        Two scheduled background jobs on this computer ({data?.computerLabel}). IPFS node:{" "}
        <span className={data?.ipfs === "ok" ? "text-green-700" : "text-red-600"}>{data?.ipfs}</span>
      </p>
      {data && (
        <div className="space-y-4">
          <WorkerCard worker="scan" title="Scan (discovery)" subtitle="Every 4 hours — finds big files & repo changes (metadata only)." state={data.scan} />
          <WorkerCard worker="sync" title="Sync (transfer)" subtitle="Every 15 minutes — moves bytes over IPFS for synced repos." state={data.sync} />
        </div>
      )}
    </div>
  );
}

function WorkerCard({ worker, title, subtitle, state }: { worker: WorkerKind; title: string; subtitle: string; state: WorkerState }) {
  const qc = useQueryClient();
  const control = useMutation({
    mutationFn: (action: "install" | "uninstall" | "enable" | "disable") => api.controlWorker(worker, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["syncPage"] });
      toast.success(`${title} updated`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] p-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-sm text-black/60">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Badge on={state.installed} onLabel="Installed" offLabel="Not installed" />
          <Badge on={state.enabled} onLabel="On" offLabel="Off" />
        </div>
      </div>
      <div className="mt-2 text-xs text-black/50">
        Last run {relativeTime(state.lastRunAt)}{state.lastRunOk === false ? " (failed)" : ""}
      </div>
      <div className="mt-3 flex gap-2">
        {!state.installed ? (
          <Btn onClick={() => control.mutate("install")}>Install</Btn>
        ) : (
          <>
            {state.enabled ? (
              <Btn onClick={() => control.mutate("disable")}>Turn off</Btn>
            ) : (
              <Btn primary onClick={() => control.mutate("enable")}>Turn on</Btn>
            )}
            <Btn onClick={() => control.mutate("uninstall")}>Uninstall</Btn>
          </>
        )}
      </div>
    </div>
  );
}

function Badge({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${on ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>
      {on ? onLabel : offLabel}
    </span>
  );
}
function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm ${primary ? "bg-[var(--lfb-primary)] text-white" : "border border-[var(--lfb-border)] hover:bg-slate-100"}`}>
      {children}
    </button>
  );
}
