"use client";

import { useState } from "react";
import {
  columnSizingFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Button,
  Icon,
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
/**
 * `align` (Sprint 14D) : alignement du contenu d'une colonne (en-tête + cellules),
 * harmonisé une seule fois ici plutôt que dans chaque page — voir ALIGN_CLASS ci-dessous.
 * Par défaut "left" (comportement historique, inchangé pour toute colonne qui ne déclare
 * pas `meta.align`), sauf la colonne `id: "actions"` qui est toujours alignée à droite
 * (convention déjà systématique dans toutes les tables du SaaS — le bouton d'action y est
 * lui-même toujours enveloppé dans un `flex justify-end` par la page appelante ; seul
 * l'en-tête correspondant ne l'était pas, incohérence corrigée ici pour toutes les tables
 * d'un coup).
 */
export interface DataTableColumnMeta {
  align?: "left" | "center" | "right";
}

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
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableColumn<TData extends RowData> = ColumnDef<typeof features, TData>;

function resolveAlign(columnId: string, declared: DataTableColumnMeta["align"] | undefined) {
  if (declared) return declared;
  return columnId === "actions" ? "right" : "left";
}

const ALIGN_CLASS: Record<NonNullable<DataTableColumnMeta["align"]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const ALIGN_JUSTIFY_CLASS: Record<NonNullable<DataTableColumnMeta["align"]>, string> = {
  left: "justify-start",
  center: "justify-center",
  right: "justify-end",
};

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
    // Sprint 14E : columnSizingFeature fusionne un `size: 150` par défaut dans le
    // columnDef résolu de CHAQUE colonne (voir constructColumn.js), y compris celles
    // qui n'en déclarent aucun — `header.column.columnDef.size` n'était donc jamais
    // réellement `undefined` comme le supposait le commentaire Sprint 14A ci-dessous.
    // Résultat concret : une colonne sans `size` explicite (ex. "Conducteur suppl.")
    // se retrouvait quand même contrainte à 150px, d'où le wrap anarchique des en-têtes
    // à travers tout le SaaS. En réinitialisant ce défaut à `undefined`, seule une
    // colonne qui déclare vraiment `size` dans son ColumnDef reçoit une largeur/un wrap.
    defaultColumn: { size: undefined },
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
                  const align = resolveAlign(header.column.id, header.column.columnDef.meta?.align);

                  return (
                    <TableHead
                      key={header.id}
                      // Sprint 14E : seules les colonnes à largeur explicite (`size`) passent sur
                      // plusieurs lignes (wrap maîtrisé, coupure aux espaces uniquement, jamais
                      // `break-words` qui coupait au milieu d'un mot) ; les autres restent sur une
                      // ligne. `align-middle` (au lieu de `align-bottom`) garantit que les en-têtes
                      // sur une ligne et celles sur deux lignes restent alignées sur la même barre,
                      // quelle que soit la hauteur réelle de la ligne d'en-tête.
                      className={cn(
                        "align-middle leading-tight",
                        width !== undefined ? "whitespace-normal" : "whitespace-nowrap",
                        ALIGN_CLASS[align]
                      )}
                      style={width !== undefined ? { width, maxWidth: width } : undefined}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "flex w-full items-center gap-1 font-medium hover:text-foreground",
                            ALIGN_JUSTIFY_CLASS[align]
                          )}
                        >
                          {label}
                          {sorted === "asc" && <Icon icon={ArrowUp} className="size-3.5" />}
                          {sorted === "desc" && <Icon icon={ArrowDown} className="size-3.5" />}
                          {!sorted && <Icon icon={ArrowUpDown} className="size-3.5 text-muted-foreground/50" />}
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
                    const align = resolveAlign(cell.column.id, cell.column.columnDef.meta?.align);
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(width !== undefined && "whitespace-normal", ALIGN_CLASS[align])}
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
              <Icon icon={ChevronLeft} className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-label="Page suivante"
            >
              <Icon icon={ChevronRight} className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
