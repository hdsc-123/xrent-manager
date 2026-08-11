import { Skeleton } from "@/components/ui";

export default function UsersLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-8 w-40" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
