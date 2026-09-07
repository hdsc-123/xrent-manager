# Tracker des points de décision ouverts (points 1-48)

Document vivant — à mettre à jour au fur et à mesure que des points sont tranchés. Déplacé depuis HANDOFF.md section « 8. Points à valider avec le propriétaire du projet » lors de la restructuration documentaire du 2026-08-26 (contenu inchangé au moment du déplacement — voir `docs/decisions/2026-08-26-documentation-restructuring-plan.md`). Détail des règles/décisions elles-mêmes dans [DOMAINRULES.md](../../DOMAINRULES.md), [ARCHITECTURE.md](../../ARCHITECTURE.md) et [SECURITY.md](../../SECURITY.md).

---

## 8. Points à valider avec le propriétaire du projet

Les points suivants restent explicitement **À DÉCIDER**. Détail dans [DOMAINRULES.md](../../DOMAINRULES.md), [ARCHITECTURE.md](../../ARCHITECTURE.md) et [SECURITY.md](../../SECURITY.md) :

### Tableau de suivi (Sprint 11)

Classification de chaque point ci-dessous. Statut : **FAIT** (tranché et implémenté), **EN COURS** (progresse sprint après sprint, jamais figé en une fois), **REPORTÉ** (décision produit/infra hors périmètre des sprints de développement en cours, ne bloque pas la suite). Priorité : impact estimé si le point reste ouvert. Sprint cible : `—` si déjà fait, `11` si tranché ce sprint, `12+` si un futur sprint de développement peut raisonnablement l'adresser, `hors scope` si la décision précède un déploiement réel (hébergement, juridique) et ne dépend d'aucun sprint de développement.

| Point | Description courte | Statut | Priorité | Sprint cible |
|---|---|---|---|---|
| 1 | MFA (fournisseur d'auth tranché, MFA reste ouvert) | REPORTÉ | BASSE | hors scope MVP |
| 2 | Granularité des rôles au-delà d'ADMIN/MEMBER | REPORTÉ | MOYENNE | 12+ |
| 3 | Devise initiale et multi-devises | REPORTÉ | BASSE | hors scope MVP |
| 4 | Règles d'arrondi financier | REPORTÉ | MOYENNE | 12+ |
| 5 | Modalités des cautions | REPORTÉ | HAUTE | 12+ |
| 6 | Hébergeur et gestionnaire de secrets prod | **Options validées, choix final non arrêté** — Render ou Railway (2026-08-24), comparaison documentée restant à réaliser | HAUTE | hors scope (avant déploiement) |
| 7 | Stratégie de sauvegarde | **Non mises en place, tests futurs à prévoir** — spécification validée (2026-08-24) : quotidienne, rétention 30j, RPO 24h/RTO 4h provisoires | HAUTE | hors scope (avant déploiement) |
| 8 | Outil de test de charge | REPORTÉ | BASSE | hors scope MVP |
| 9 | Périmètre exact du MVP | EN COURS | MOYENNE | 11 (affiné ce sprint) |
| 10 | Juridiction cible et RGPD | REPORTÉ | HAUTE | hors scope (avant déploiement) |
| 11 | Emplacement des dossiers serveur | FAIT (de facto : `src/lib` + `src/app/api`) | BASSE | — |
| 12 | Formats et périmètre des exports/imports | REPORTÉ | BASSE | 12+ |
| 13 | Durée de conservation des journaux d'audit | REPORTÉ | MOYENNE | 12+ |
| 14 | Fuseau horaire par agence | REPORTÉ | BASSE | 12+ |
| 15 | Granularité des rôles tenant vs agence | REPORTÉ | MOYENNE | 12+ |
| 16 | Résolution tenant à la connexion / pas de superadmin | FAIT (Sprint 9) | — | — |
| 17 | Flux d'invitation | FAIT (Sprint 9) | — | — |
| 18 | Durée de session / politique mot de passe | FAIT (Sprint 9) | — | — |
| 19 | `PATCH`/`DELETE /api/users/[id]` | FAIT (Sprint 9) | — | — |
| 20 | Profil utilisateur (`GET`/`PATCH /api/users/me`) + rafraîchissement de session | FAIT (Sprint 10 + Sprint 11) | — | — |
| 21 | `MEMBER` peut créer/modifier/supprimer véhicules/locations de son agence | FAIT — confirmé par continuité (Sprint 11) | HAUTE | — |
| 22 | Devise(s) réellement supportée(s) en prod (`MAD` codé en dur) | REPORTÉ | BASSE | 12+ |
| 23 | Module `Client` : fusion de doublons, documents d'identité | REPORTÉ | MOYENNE | 12+ |
| 24 | Rapports financiers réservés `ADMIN` | FAIT — confirmé par continuité (Sprint 11) | HAUTE | — |
| 25 | Une `Location` peut-elle avoir plusieurs `Invoice` ? | TRANCHÉ (Sprint 13E tâche 3) — sous-phases 2a/2b/2c1/2c2-A/2c2-B/2c2-C/2c2-D toutes livrées et committées (RENTAL unique + SUPPLEMENT/EXTENSION + avoirs CREDIT_NOTE + remboursements + PDF/interface) ; question générale « plusieurs factures RENTAL par Location » au-delà de ce périmètre reste REPORTÉE (DOMAINRULES.md section 17) | HAUTE | — |
| 26 | Remise en pourcentage + arrondi financier | REPORTÉ | MOYENNE | 12+ |
| 27 | Contenu légal détaillé de facture | REPORTÉ | HAUTE | hors scope (juridique, avant déploiement) |
| 28 | Alertes in-app uniquement vs email | REPORTÉ (in-app confirmé pour l'instant) | BASSE | 12+ |
| 29 | `check-alerts` réservé `ADMIN`, scopé au tenant déclencheur | FAIT — confirmé par continuité (Sprint 11) | HAUTE | — |
| 30 | Prestataire SMTP transactionnel | REPORTÉ | BASSE | 12+ |
| 31 | Transition `Maintenance` `SCHEDULED → COMPLETED` directe | FAIT (Sprint 7, comportement stable) | — | — |
| 32 | Récurrence automatique de maintenance | REPORTÉ | MOYENNE | 12+ |
| 33 | Périmètre de l'audit (exhaustif) | FAIT (Sprint 10) | — | — |
| 34 | Garde « dernier ADMIN » en action tiers | FAIT (Sprint 10) | — | — |
| 35 | Rafraîchissement de la session JWT après édition de profil | FAIT (Sprint 11) | — | — |
| 36 | `POST /api/tenants` créait des tenants orphelins (écart fonctionnel) | FAIT — route et page retirées (Sprint 11) | — | — |
| 37 | Reset de données : mécanisme de garde de production (`NODE_ENV`) et verrou en mémoire de process | FAIT (Sprint 14D) — à confirmer si multi-instance | BASSE | si déploiement multi-instance décidé |
| 38 | Hébergement : Render ou Railway (choix technique final), région Maroc/UE proche | **Options validées, choix final non arrêté** (2026-08-24) — comparaison documentée restant à réaliser | HAUTE | avant déploiement |
| 39 | Budget infrastructure maximum | **Décision validée, non implémentée** (2026-08-24) : 60 €/mois | HAUTE | avant déploiement |
| 40 | Dimensionnement cible (5 agences → 10-15, ~200 véhicules, 16-18 utilisateurs) | TRANCHÉ (2026-08-24), aucun changement de schéma identifié comme nécessaire pour ce volume | MOYENNE | — |
| 41 | Rate limiting authentification — spécification | **Spécification validée, implémentation à confirmer ou à réaliser** (2026-08-24) : PostgreSQL d'abord, Redis différé — voir SECURITY.md section 33 | HAUTE | avant exposition publique |
| 42 | CRON de production — planificateur et route | TRANCHÉ (2026-08-24) : planificateur natif de la plateforme retenue, appelle `/api/tasks/scheduled-alerts` déjà existant — **aucune configuration réelle créée** | HAUTE | avant déploiement |
| 43 | Prolongations : nouveau contrat lié (numéro propre, parent/racine) + 12 règles métier complémentaires | **Schéma, création, affichage de la chaîne et soldes implémentés et vérifiés (Sprint technique 1 et 2) ; retrait complet d'`extendReturnDate` et protection de chaîne non contournable implémentés et vérifiés (Sprint technique 3, 2026-08-24)** — PDF dédié et retours spécifiques à une chaîne restent à planifier ; voir DOMAINRULES.md sections 60 et 65 | HAUTE | sprints suivants (PDF/retours) |
| 44 | Facturation au nom d'une société (entité facturée distincte du locataire) | **Fonctionnalité cadrée, non implémentée** (2026-08-24) — validation comptable marocaine requise avant émission réelle ; voir DOMAINRULES.md section 63 | HAUTE | à cadrer techniquement avant codage |
| 45 | Conservation des données métier (≥ 1 exercice comptable) | **Décision validée, non implémentée** (provisoire, 2026-08-24), distincte de la rétention de sauvegarde (30j) — validation comptable marocaine finale requise ; garde-fou technique de rétention sur la purge d'audit **à planifier** (absent du code) | HAUTE | avant exposition publique |
| 46 | Permissions de suppression définitive (facture/paiement/contrat/audit) — vocabulaire « Super Admin » | TRANCHÉ (2026-08-24) : correspond à l'`ADMIN` de tenant existant + permission explicite, aucun nouveau rôle créé ; voir DOMAINRULES.md section 62 | — | — |
| 47 | Soft 404/soft redirect sous `/dashboard/*` (`notFound()`/`redirect()` renvoyant `200` au lieu du code HTTP réel, streaming SSR) | **Corrigé et vérifié pour l'intégralité des routes concernées (2026-08-24)** — garde de route centralisé (`src/lib/route-guards.ts`, exécuté depuis `src/proxy.ts`) ; voir DOMAINRULES.md section 64 et SECURITY.md section 35 | — | — |
| 48 | Redirection ouverte (open redirect) via `callbackUrl` à la connexion (`LoginForm.tsx`, `router.push` non validé) | **Trouvé par audit de sécurité en lecture seule (2026-09-06), corrigé (2026-09-07)** — `sanitizeInternalRedirect` (`src/lib/safe-redirect.ts`) restreint `callbackUrl` à un chemin interne relatif avant tout usage ; voir SECURITY.md section 51 | — | — |

Détail narratif de chaque point :

1. ~~Fournisseur d'authentification et stratégie MFA.~~ Fournisseur tranché (NextAuth.js v5, Sprint 3) ; **MFA reste À DÉCIDER**.
2. Rôles et permissions détaillés au-delà de `ADMIN`/`MEMBER` (granularité par module/action).
3. Devise initiale et support multi-devises.
4. Règles d'arrondi financier.
5. ~~Prestataire de paiement.~~ Tranché (Sprint 6) : aucun, paiements enregistrés manuellement. Modalités des cautions restent **À DÉCIDER**.
6. ~~Hébergeur précis et gestionnaire de secrets en production.~~ **Cadrage validé par le propriétaire du projet (2026-08-24)** : hébergeur cible Render ou Railway (PaaS à conteneur long-running), choix final entre les deux à départager par une comparaison documentée (prix réel, région disponible, latence depuis le Maroc, qualité du PostgreSQL managé, sauvegardes, restauration, gestion du CRON, limites de l'offre, compatibilité budgétaire). Vercel explicitement écarté pour le moment (sauf décision explicite ultérieure) ; VPS administré manuellement écarté pour le lancement. Gestionnaire de secrets : store natif de la plateforme retenue. Voir points 38-46 ci-dessous pour le détail complet de ce cadrage et ARCHITECTURE.md sections 16-23.
7. Stratégie détaillée de sauvegarde.
8. Outil de test de charge.
9. Périmètre exact du MVP (quels modules métier sont inclus dans la première version livrable).
10. Juridiction cible et périmètre RGPD applicable.
11. Nom et emplacement exacts des dossiers serveur (structure de code métier, distincte de `src/lib` utilisé pour la couche d'accès aux données technique).
12. Formats et périmètre détaillés des exports/imports.
13. Droits d'accès aux journaux d'audit : **tranché (Sprint 9)** pour les actions instrumentées (réservé ADMIN, tenant-scopé). Durée de conservation reste **À DÉCIDER** (aucune purge automatique). Voir aussi point 33 (périmètre d'instrumentation).
14. Modélisation précise du fuseau horaire par agence (champ `timezone` non ajouté à `Agency` à ce stade).
15. Granularité des rôles (tenant vs par agence), à trancher avant d'enrichir `UserAgency`.
16. ~~Résolution du tenant à la connexion en cas d'email dupliqué entre tenants, et existence éventuelle d'un rôle "superadmin" plateforme.~~ **Tranché (Sprint 9)** : Option B (page de sélection explicite du tenant, mot de passe vérifié avant de révéler la liste) ; pas de rôle SUPERADMIN construit (décision explicite, reconduite).
17. ~~Flux d'invitation d'un utilisateur supplémentaire dans un tenant existant.~~ **Tranché et implémenté (Sprint 9)** : `Invitation`, `/dashboard/invitations`, page publique `/invitations/[id]`, pas d'email (lien partagé manuellement) — voir section 6.
18. ~~Durée d'expiration de session et politique de complexité de mot de passe.~~ **Tranché et implémenté (Sprint 9)** : `session.maxAge` = 30 jours (1 jour si « se souvenir de moi » décoché) ; `validatePassword` (8 caractères + majuscule + chiffre + spécial).
19. ~~Conception des routes `PATCH`/`DELETE /api/users/[id]`.~~ **Tranché et implémenté (Sprint 9)** : changement de rôle, réinitialisation de mot de passe, suppression, avec garde « dernier ADMIN » — voir section 6. Granularité des rôles au-delà de `ADMIN`/`MEMBER` reste **À DÉCIDER** (point 2).
20. ~~Route de mutation du **profil utilisateur courant, par l'utilisateur lui-même** (nom, email, changement de mot de passe avec vérification de l'ancien).~~ **Tranché et implémenté (Sprint 10)** : `GET`/`PATCH /api/users/me` — voir section 6. ~~Reste À DÉCIDER : invalidation/rafraîchissement des sessions JWT existantes après un changement de mot de passe ou d'email.~~ **Tranché et implémenté (Sprint 11)** : voir point 35.
21. ~~Confirmer (ou ajuster) la décision provisoire selon laquelle un `MEMBER` rattaché à une agence peut créer/modifier/supprimer les véhicules et locations de cette agence (pas seulement les consulter).~~ **Confirmé par continuité (Sprint 11)** : comportement stable et testé sans changement ni contestation depuis son introduction (Sprint 5), reconduit explicitement — voir section 6 et section 7. Un futur module métier réutilisant ce pattern devra néanmoins re-confirmer le point 2 (granularité générale des rôles) avant extension.
22. **Nouveau (Sprint 5, mis à jour)** : devise(s) réellement supportée(s) en production (le champ `currency` existe, mais `"MAD"` est actuellement codé en dur comme valeur par défaut à la création, changé depuis `"EUR"`) — précise le point 3 ci-dessus.
23. ~~Un module `Client` à part entière (page dédiée, recherche, historique de locations) est-il nécessaire ?~~ Tranché (Sprint 8) : page `/dashboard/clients*` dédiée construite (liste + recherche, création, détail/édition, historique des locations). **Reste À DÉCIDER** : fusion de doublons, documents d'identité/permis (données personnelles sensibles, voir [SECURITY.md](../../SECURITY.md) section 11) — hors périmètre du Sprint 8.
24. ~~Confirmer (ou ajuster) la décision provisoire selon laquelle les rapports financiers (`/api/reports/*`, `/dashboard/reports`) sont réservés au rôle `ADMIN`, y compris pour un `MEMBER` rattaché à toutes les agences pertinentes.~~ **Confirmé par continuité (Sprint 11)** : comportement stable et testé depuis le Sprint 6, reconduit explicitement — voir section 6 et section 7.
25. ~~Une `Location` peut-elle avoir plusieurs `Invoice` (facture partielle, avoir, facture rectificative), ou une seule facture par location est-elle la règle ?~~ **Tranché par le propriétaire du projet (Sprint 13E tâche 3)** : au plus une facture `RENTAL` active par `Location` ; `SUPPLEMENT`/`EXTENSION`/`CREDIT_NOTE` sont des types de facture additionnels distincts, jamais un doublon de la facture principale. Voir DOMAINRULES.md section 17 (règles 1-13). **Implémentation en cours, séquencée** : sous-phase 2a (migration schéma `xrent_test` uniquement, renommage `SENT/CANCELLED` → `ISSUED/VOID`, `getOrCreateMainInvoice`) **livrée et testée**, sous-phase 2b (`SUPPLEMENT`/`EXTENSION`, idempotence, `POST /api/invoices`, correction `syncDraftInvoiceTotal`) **livrée et testée** — voir section 1 ci-dessous. Restent à livrer : 2c1 (création des avoirs, `voidInvoice`), 2c2 (intégration des avoirs dans les calculs de solde) — non commencées, migration non appliquée sur `xrent_dev`.
26. **Nouveau (Sprint 6)** : règles de remise en pourcentage (aujourd'hui `discountAmount` est un montant fixe, pas un pourcentage) et règles d'arrondi financier au-delà du calcul de jours de location — précise le point 4 ci-dessus.
27. **Nouveau (Sprint 6)** : contenu détaillé de facture (mentions légales, conditions générales, TVA intracommunautaire) — dépend en partie de la juridiction cible (point 10) ; gestion des remboursements/paiements négatifs, non modélisée à ce stade.
28. **Nouveau (Sprint 7)** : les alertes resteront-elles in-app uniquement, ou une intégration email (avec choix d'un prestataire SMTP) est-elle nécessaire pour un futur sprint ? Décision explicite de démarrage de sprint : in-app uniquement pour l'instant, **à reconfirmer** si le besoin d'email devient prioritaire.
29. ~~Confirmer (ou ajuster) la décision provisoire selon laquelle `POST /api/tasks/check-alerts` est réservé `ADMIN` et scopé au tenant déclencheur (pas de scan multi-tenant global).~~ **Confirmé par continuité (Sprint 11)** : comportement stable et testé depuis le Sprint 7, reconduit explicitement — voir section 6 et section 7 ; si un vrai cron périodique multi-tenant est nécessaire, un mécanisme d'authentification de service dédié devra être conçu (aucun rôle « superadmin » transverse n'existe, point 16).
30. **Nouveau (Sprint 7)** : si les notifications par email sont un jour nécessaires, quel prestataire SMTP (et quelle politique de contenu/fréquence) ? Aucune dépendance ni configuration n'existe à ce stade (précise le point 28).
31. **Nouveau (Sprint 7)** : confirmer (ou ajuster) la décision provisoire selon laquelle `SCHEDULED → COMPLETED` est autorisé directement pour une `Maintenance` (sans passer par `IN_PROGRESS`) — voir section 6. À trancher si un workflow de maintenance plus fin (ex. suivi du temps passé « en cours ») s'avère nécessaire.
32. **Nouveau (Sprint 7)** : récurrence automatique de maintenance (planification du prochain entretien après complétion d'un précédent, ex. tous les X km ou tous les Y mois) — `createMaintenanceFromSchedule` existe comme brique réutilisable mais aucun moteur de récurrence ne l'appelle ; périmètre et règles de récurrence à définir.
33. ~~`AuditLog` est-il destiné à rester limité aux actions instrumentées Sprint 9, ou un audit exhaustif de tout le CRUD métier est-il nécessaire ?~~ **Tranché (Sprint 10)** : audit exhaustif — voir section 6.
34. ~~Confirmer (ou ajuster) la décision provisoire selon laquelle la garde « dernier ADMIN » s'applique aussi aux actions d'un tiers.~~ **Confirmé (Sprint 10)** : la garde est structurellement identique en self-action et en action d'un tiers (ne dépend que du nombre d'ADMIN restants) — voir section 6.
35. ~~Rafraîchissement de la session JWT (`name`/`email`) après édition de profil.~~ **Tranché et implémenté (Sprint 11)** : `SessionProvider` + `useSession().update()` côté client (`EditProfileForm.tsx`), trigger `"update"` du callback `jwt()` relisant `name`/`email` en base par `token.id` côté serveur (`src/lib/auth.ts`) — voir section 1 (Sprint 11) et section 6.
36. **Nouveau (Sprint 11)** : `POST /api/tenants` permettait à tout ADMIN authentifié de créer un `Tenant` orphelin (aucun `User` rattaché), invisible et inaccessible ensuite (`GET`/`PATCH`/`DELETE /api/tenants/[id]` scopés à `user.tenantId`) — écart fonctionnel découvert pendant l'audit de sécurité de ce sprint, **pas** une fuite inter-tenant. **Tranché et corrigé (Sprint 11)**, validé explicitement par le propriétaire du projet : route et page `/dashboard/tenants/new` retirées, la création de tenant reste exclusive à `POST /api/auth/register` — voir section 1 et section 6.
37. **Nouveau (Sprint 14D)** : le reset de données (`/api/data-reset`) complète la décision de sécurité Sprint 1 « reset impossible en production » (SECURITY.md section 17) avec un mécanisme concret (`process.env.NODE_ENV === "production"`) et ajoute un verrou anti-double-exécution en mémoire de process — **tranché et implémenté (Sprint 14D)**, décisions d'ingénierie non soumises à validation préalable (voir section 6). **Reste à confirmer explicitement** : (a) si un reset utilisable même en production est un jour souhaité (contredirait la décision Sprint 1, actuellement sans impact pratique puisqu'aucun environnement de production n'existe) ; (b) le verrou en mémoire de process cesserait d'être suffisant si un déploiement multi-instance était un jour décidé (aucun hébergeur n'est tranché à ce jour, point 6) — un mécanisme de verrou distribué (ex. verrou consultatif PostgreSQL, Redis) devrait alors être conçu.

48. **Nouveau (audit de sécurité en lecture seule, 2026-09-06)** : `callbackUrl` (paramètre de requête de `/login`, transmis tel quel à `router.push()` après connexion) n'était jamais validé — une valeur absolue externe (`https://site-pirate.tld`) déclenchait une navigation navigateur complète vers ce domaine juste après une connexion réussie (redirection ouverte, hameçonnage post-connexion ; aucune fuite de cookie de session, aucun contournement d'authentification/MFA). **Tranché et corrigé (2026-09-07)**, décision d'ingénierie non soumise à validation préalable (correction strictement applicative, aucun changement de schéma) : `sanitizeInternalRedirect` (`src/lib/safe-redirect.ts`) n'accepte plus qu'un chemin interne relatif, avec repli sur `/dashboard` — voir SECURITY.md section 51 pour le détail complet.

Framework de test : **tranché** (Vitest, voir section 2) — les outils e2e et de test de charge restent À DÉCIDER.
