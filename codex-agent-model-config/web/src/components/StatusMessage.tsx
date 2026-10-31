export type Status = {
  kind: "idle" | "info" | "warning" | "error" | "success";
  message: string;
};

export function StatusMessage({ status }: { status: Status }) {
  if (status.kind === "idle") return null;
  return (
    <div className={`status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
      {status.message}
    </div>
  );
}
