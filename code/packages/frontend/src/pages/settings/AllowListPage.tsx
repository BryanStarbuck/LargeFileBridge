// Allow-list editor (settings.mdx §4) — admin only; gated in the router + backend.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api/client.js";

export function AllowListPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["allowList"], queryFn: api.allowList });
  const [text, setText] = useState("");
  useEffect(() => { if (data) setText(data.join("\n")); }, [data]);

  const save = useMutation({
    mutationFn: () => api.setAllowList(text.split("\n").map((s) => s.trim()).filter(Boolean)),
    onSuccess: (d: string[]) => { qc.setQueryData(["allowList"], d); toast.success("Allow-list saved"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-xl">
      <Link to="/settings" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
        <ChevronLeft className="h-4 w-4" /> Settings
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">Allow-list</h1>
      <p className="mb-3 text-sm text-black/60">Only these Google emails may sign in (one per line). Admin only.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
        className="w-full rounded border border-[var(--lfb-border)] px-2 py-1.5 font-mono text-sm" />
      <button onClick={() => save.mutate()} className="mt-2 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white">
        Save
      </button>
    </div>
  );
}
