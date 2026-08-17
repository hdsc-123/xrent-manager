"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Eye } from "lucide-react";
import { Badge, Button, Icon } from "@/components/ui";
import { DataTable, type DataTableColumn } from "@/components/layout/DataTable";

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export function UsersTable({ users }: { users: UserRow[] }) {
  const columns = useMemo<DataTableColumn<UserRow>[]>(
    () => [
      { accessorKey: "name", header: "Nom" },
      { accessorKey: "email", header: "Email" },
      {
        accessorKey: "role",
        header: "Rôle",
        cell: ({ getValue }) => (
          <Badge variant={getValue<string>() === "ADMIN" ? "default" : "secondary"}>
            {getValue<string>() === "ADMIN" ? "Administrateur" : "Membre"}
          </Badge>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Depuis",
        cell: ({ getValue }) => new Date(getValue<string>()).toLocaleDateString("fr-FR"),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Détails"
              render={<Link href={`/dashboard/users/${row.original.id}`} />}
            >
              <Icon icon={Eye} className="size-4" />
            </Button>
          </div>
        ),
      },
    ],
    []
  );

  return <DataTable columns={columns} data={users} emptyMessage="Aucun utilisateur." />;
}
