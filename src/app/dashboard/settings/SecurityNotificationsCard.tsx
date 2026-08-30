"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Button, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";

/**
 * Politique MFA (2026-08-30, brief explicite du propriétaire du projet) : interface minimale des
 * notifications de sécurité in-app — compteur non lues, liste, marquage individuel/global. Voir
 * prisma/schema.prisma (modèle SecurityNotification) pour la distinction avec le journal d'audit
 * (jamais affiché ni supprimable ici — cette carte ne touche jamais AuditLog).
 */

interface SecurityNotification {
  id: string;
  type: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

interface ListResponse {
  notifications: SecurityNotification[];
  unreadCount: number;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SecurityNotificationsCard() {
  const [notifications, setNotifications] = useState<SecurityNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isMarkingAll, setIsMarkingAll] = useState(false);

  useEffect(() => {
    apiGet<ListResponse>("/api/security-notifications")
      .then((data) => {
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
      })
      .catch(() => {
        // Silencieux — cette carte ne doit jamais bloquer le reste de la page paramètres.
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function markRead(id: string) {
    try {
      await apiPatch(`/api/security-notifications/${id}/read`, {});
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    }
  }

  async function markAllRead() {
    setIsMarkingAll(true);
    try {
      await apiPost("/api/security-notifications/read-all", {});
      const now = new Date().toISOString();
      setNotifications((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? now })));
      setUnreadCount(0);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Une erreur est survenue.");
    } finally {
      setIsMarkingAll(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Notifications de sécurité</CardTitle>
          {unreadCount > 0 && <Badge variant="destructive">{unreadCount}</Badge>}
        </div>
        <CardDescription>
          Historique des événements de sécurité sur votre compte (changement d&apos;e-mail, de mot de
          passe, activation/désactivation de la MFA).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading && <p className="text-sm text-muted-foreground">Chargement…</p>}

        {!isLoading && notifications.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucune notification de sécurité.</p>
        )}

        {!isLoading && notifications.length > 0 && (
          <>
            {unreadCount > 0 && (
              <Button type="button" variant="outline" size="sm" disabled={isMarkingAll} onClick={markAllRead}>
                Tout marquer comme lu
              </Button>
            )}
            <ul className="flex flex-col gap-2">
              {notifications.map((notification) => (
                <li
                  key={notification.id}
                  className={`flex items-start justify-between gap-3 rounded-md border p-3 text-sm ${
                    notification.readAt ? "opacity-60" : "border-primary/40 bg-primary/5"
                  }`}
                >
                  <div className="flex flex-col gap-1">
                    <span>{notification.message}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(notification.createdAt)}</span>
                  </div>
                  {!notification.readAt && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => markRead(notification.id)}>
                      Marquer comme lu
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
