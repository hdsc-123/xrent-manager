"use client";

import { Checkbox } from "@/components/ui";

export interface PermissionDef {
  key: string;
  label: string;
  category: string;
}

interface PermissionCheckboxGridProps {
  permissions: PermissionDef[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}

export function PermissionCheckboxGrid({
  permissions,
  selected,
  onChange,
  disabled = false,
}: PermissionCheckboxGridProps) {
  const categories = Array.from(new Set(permissions.map((permission) => permission.category)));

  function toggle(key: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) {
      next.add(key);
    } else {
      next.delete(key);
    }
    onChange(next);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {categories.map((category) => (
        <div key={category} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <span className="text-xs font-medium text-muted-foreground">{category}</span>
          {permissions
            .filter((permission) => permission.category === category)
            .map((permission) => (
              <label key={permission.key} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selected.has(permission.key)}
                  onCheckedChange={(checked) => toggle(permission.key, checked === true)}
                  disabled={disabled}
                />
                {permission.label}
              </label>
            ))}
        </div>
      ))}
    </div>
  );
}
