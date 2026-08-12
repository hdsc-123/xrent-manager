import Link from "next/link";
import { Button } from "@/components/ui";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-8 bg-muted/30 p-4 text-center">
      <div className="flex flex-col gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">XRent Manager</h1>
        <p className="max-w-md text-muted-foreground">
          Gestion de location de véhicules multi-agence.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button render={<Link href="/login" />}>Se connecter</Button>
        <Button variant="outline" render={<Link href="/register" />}>
          S&apos;inscrire
        </Button>
      </div>
    </div>
  );
}
