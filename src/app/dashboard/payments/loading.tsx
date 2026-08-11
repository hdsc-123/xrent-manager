import { Skeleton } from "@/components/ui";

export default function PaymentsLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
