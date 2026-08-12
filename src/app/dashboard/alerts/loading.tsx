import { Skeleton } from "@/components/ui";

export default function AlertsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
