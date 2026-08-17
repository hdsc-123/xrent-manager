import { forwardRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LucideProps } from "lucide-react";
import { Icon } from "@/components/ui";

/**
 * Unitaire, sans jsdom/@testing-library (paradigme HTTP existant, voir en-tête de
 * src/__tests__/ui.test.tsx) — react-dom/server suffit à vérifier le contrat du wrapper Icon
 * (src/components/ui/icon.tsx), qui neutralise les avertissements d'hydratation causés par les
 * extensions navigateur (Dark Reader...) réécrivant le style/stroke des <svg> avant l'hydratation.
 */

let receivedProps: LucideProps | undefined;
const ProbeIcon = forwardRef<SVGSVGElement, LucideProps>(function ProbeIcon(props, ref) {
  receivedProps = props;
  return <svg ref={ref} />;
});

describe("Icon (src/components/ui/icon.tsx)", () => {
  it("force suppressHydrationWarning sur l'icône rendue, sans altérer les autres props", () => {
    renderToStaticMarkup(<Icon icon={ProbeIcon} className="size-4" />);
    const props: LucideProps | undefined = receivedProps;
    expect(props?.suppressHydrationWarning).toBe(true);
    expect(props?.className).toBe("size-4");
  });

  it("rend un HTML SSR déterministe (identique à props égales), condition nécessaire à une hydratation sans écart côté application", () => {
    const first = renderToStaticMarkup(<Icon icon={ProbeIcon} className="size-4" />);
    const second = renderToStaticMarkup(<Icon icon={ProbeIcon} className="size-4" />);
    expect(first).toBe(second);
  });
});
