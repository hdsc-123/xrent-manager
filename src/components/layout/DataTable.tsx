"use client";

import { useState } from "react";
import {
  columnSizingFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";

/**
 * @tanstack/react-table v9 (breaking rewrite vs v8, see
 * node_modules/@tanstack/react-table/skills/migrate-v8-to-v9) : les row models
 * optionnels (tri, pagination) sont enregistrés comme "features" plutôt que passés
 * en options à useReactTable (qui n'existe plus, remplacé par useTable).
 */
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  // Sprint 14A : enregistré uniquement pour que `size` soit un champ valide de ColumnDef
  // (typé par feature en v9) — lu directement depuis columnDef.size (pas getSize()), aucun
  // redimensionnement interactif n'est câblé, l'état columnSizing par défaut reste inutilisé.
  columnSizingFeature,
});

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof features, TData>;

interface DataTableProps<TData extends RowData> {
  columns: DataTableColumn<TData>[];
  data: TData[];
  emptyMessage?: string;
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  emptyMessage = "Aucune donnée.",
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useTable({
    features,
    columns,
    data,
    state: { sorting },
    onSortingChange: setSorting,
    initialState: { pagination: { pageIndex: 0, pageSize: 10 } },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  // Largeur explicite optionnelle (Sprint 14A) : seules les colonnes qui
                  // déclarent `size` dans leur ColumnDef sont contraintes — n'affecte donc
                  // aucune table existante qui n'en définit pas (pas de largeur par défaut
                  // TanStack appliquée ici, volontairement, pour ne rien changer ailleurs).
                  const width = header.column.columnDef.size;

                  return (
                    <TableHead
                      key={header.id}
                      className="whitespace-normal break-words align-bottom"
                      style={width !== undefined ? { width, maxWidth: width } : undefined}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex items-center gap-1 font-medium hover:text-foreground"
                        >
                          {label}
                          {sorted === "asc" && <ArrowUp className="size-3.5" />}
                          {sorted === "desc" && <ArrowDown className="size-3.5" />}
                          {!sorted && <ArrowUpDown className="size-3.5 text-muted-foreground/50" />}
                        </button>
                      ) : (
                        label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => {
                    const width = cell.column.columnDef.size;
                    return (
                      <TableCell
                        key={cell.id}
                        className={width !== undefined ? "whitespace-normal break-words" : undefined}
                        style={width !== undefined ? { width, maxWidth: width } : undefined}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {table.state.pagination.pageIndex + 1} sur {table.getPageCount()}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-label="Page précédente"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label="Page suivante"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
