import { forwardRef } from "react";
import type { LucideIcon as LucideIconType, LucideProps } from "lucide-react";

interface IconProps extends LucideProps {
  icon: LucideIconType;
}

/**
 * Rend une icône Lucide avec suppressHydrationWarning : les extensions navigateur (Dark Reader,
 * Grammarly...) réécrivent en DOM le style/stroke des <svg> avant l'hydratation React, ce qui
 * déclenche un avertissement d'hydratation sur cet élément précis — la prop ne se propage pas
 * aux descendants (un niveau seulement), donc chaque icône doit passer par ce point unique
 * plutôt que d'ajouter la prop au cas par cas dans chaque composant.
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: IconComponent, ...props },
  ref
) {
  return <IconComponent ref={ref} suppressHydrationWarning {...props} />;
});
