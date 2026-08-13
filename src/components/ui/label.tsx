"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** `required` (Sprint 14A) : ajoute un astérisque rouge décoratif après le libellé, pour
 * signaler visuellement un champ obligatoire dans tous les formulaires du SaaS — l'attribut
 * HTML `required`/`aria-required` du champ lui-même reste la source de vérité pour
 * l'accessibilité, cet astérisque est purement visuel (`aria-hidden`). */
function Label({
  className,
  required,
  children,
  ...props
}: React.ComponentProps<"label"> & { required?: boolean }) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      {required && (
        <span aria-hidden="true" className="text-destructive">
          *
        </span>
      )}
    </label>
  )
}

export { Label }
