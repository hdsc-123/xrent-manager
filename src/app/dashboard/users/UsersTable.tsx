"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui";
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
    ],
    []
  );

  return <DataTable columns={columns} data={users} emptyMessage="Aucun utilisateur." />;
}
