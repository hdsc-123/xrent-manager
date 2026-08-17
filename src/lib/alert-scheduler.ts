import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { maybeRunScheduledAlertChecks } from "@/lib/scheduled-tasks";

/**
 * Orchestrateur multi-tenant du scheduler horaire d'alertes (Sprint 34 étape 2,
 * DOMAINRULES.md section 49) — appelé par POST /api/tasks/scheduled-alerts (déclencheur de
 * service externe, cron) et exposé aussi pour un déclenchement manuel éventuel. Réutilise
 * `maybeRunScheduledAlertChecks` (Sprint 22/23, src/lib/scheduled-tasks.ts) tel quel pour
 * chaque tenant : c'est cette fonction, inchangée, qui porte la garde anti-doublon réelle
 * (`Tenant.lastAlertCheckAt`, `updateMany` conditionné atomique côté Postgres) — un appel
 * répété de ce scheduler dans la même fenêtre d'une heure (cron mal configuré, retry, deux
 * instances) ne peut donc jamais recréer les mêmes alertes pour un même tenant, sans aucun
 * verrou supplémentaire à ce niveau. Isolation tenant : chaque tenant est traité
 * indépendamment (son propre appel, sa propre entrée de journal), jamais de requête
 * mélangeant plusieurs tenants.
 *
 * Traitement par lots de `TENANT_BATCH_SIZE` plutôt que tout en parallèle, pour ne pas
 * multiplier les requêtes Postgres simultanées sous un grand nombre de tenants (même
 * précaution que documentée pour INC-3, INCIDENTS.md — blocage du serveur partagé sous
 * charge soutenue) ; `Promise.allSettled` par lot pour qu'un tenant en échec n'interrompe
 * jamais le traitement des autres (gestion des erreurs, brief Sprint 34 étape 2).
 */
const TENANT_BATCH_SIZE = 5;

export interface ScheduledAlertRunError {
  tenantId: string;
  message: string;
}

export interface ScheduledAlertRunSummary {
  trigger: "CRON" | "MANUAL";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tenantsTotal: number;
  /** Tenants pour lesquels le throttle horaire a laissé passer l'exécution complète. */
  tenantsRan: number;
  /** Tenants déjà vérifiés il y a moins d'une heure — comportement attendu, pas une erreur. */
  tenantsSkipped: number;
  alertsCreated: number;
  errors: ScheduledAlertRunError[];
}

export async function runScheduledAlertChecksForAllTenants(
  trigger: "CRON" | "MANUAL" = "CRON"
): Promise<ScheduledAlertRunSummary> {
  const startedAt = new Date();
  const tenants = await prisma.tenant.findMany({ select: { id: true } });

  let tenantsRan = 0;
  let tenantsSkipped = 0;
  let alertsCreated = 0;
  const errors: ScheduledAlertRunError[] = [];

  for (let i = 0; i < tenants.length; i += TENANT_BATCH_SIZE) {
    const batch = tenants.slice(i, i + TENANT_BATCH_SIZE);
    const outcomes = await Promise.allSettled(
      batch.map((tenant) => maybeRunScheduledAlertChecks(tenant.id))
    );

    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      const tenantId = batch[index].id;

      if (outcome.status === "rejected") {
        // maybeRunScheduledAlertChecks capture déjà ses propres erreurs après avoir acquis la
        // garde horaire (voir son propre try/catch) — n'atteint ce cas que si l'acquisition de
        // la garde elle-même (le premier `updateMany`) a levé une exception (ex. base
        // injoignable). Rien n'est journalisé en base pour ce tenant dans ce cas précis : l'état
        // réel de la base n'est pas garanti, seule la console (visible dans les journaux de
        // l'hébergeur, quel qu'il soit) reçoit le détail.
        errors.push({ tenantId, message: String(outcome.reason) });
        continue;
      }

      const result = outcome.value;
      if (!result.ran) {
        tenantsSkipped += 1;
        continue;
      }

      tenantsRan += 1;
      alertsCreated += result.alertsCreated;
      if (result.error) {
        errors.push({ tenantId, message: result.error });
      }

      // Journalisation par tenant (Sprint 34 étape 2) : réutilise le journal d'audit déjà
      // scopé tenant/agence-compatible et déjà affiché par /dashboard/audit (userId null déjà
      // rendu "Système" par page.tsx, aucun changement UI nécessaire). N'écrit qu'à l'exécution
      // réelle (pas pour les tenants throttlés) pour ne pas polluer le journal d'un tenant
      // inactif d'une entrée creuse toutes les heures. Attendue explicitement (pas fire-and-
      // forget) pour que l'entrée soit garantie visible dès la réponse HTTP de la route
      // appelante — logAction() n'échoue jamais l'appelant pour autant (erreur d'écriture déjà
      // capturée en interne, voir src/lib/audit.ts).
      await logAction({
        tenantId,
        userId: null,
        action: "alert_check.scheduled_run",
        resource: "Alert",
        metadata: { alertsCreated: result.alertsCreated, trigger, ...(result.error ? { error: result.error } : {}) },
      });
    }
  }

  const finishedAt = new Date();
  const summary: ScheduledAlertRunSummary = {
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    tenantsTotal: tenants.length,
    tenantsRan,
    tenantsSkipped,
    alertsCreated,
    errors,
  };

  // Journalisation "process" (Sprint 34 étape 2) : indépendante de la base de données,
  // toujours disponible quel que soit l'hébergeur retenu (point 6, HANDOFF.md, toujours à
  // décider) — capturée par les journaux applicatifs standard de l'environnement d'exécution.
  console.log("[scheduled-alerts]", JSON.stringify(summary));

  return summary;
}
