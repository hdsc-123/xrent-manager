# Consignes de collaboration — développeur externe

Document destiné exclusivement au développeur externe rejoignant XRent Manager. Complète [DEV_HANDOFF_REPORT.md](./DEV_HANDOFF_REPORT.md) (contexte technique complet) et [CLAUDE.md](./CLAUDE.md) (règles impératives du projet, à lire en entier avant toute contribution) — ce document-ci n'est qu'un résumé opérationnel des règles à respecter au quotidien, pas un remplacement de ces deux documents.

## 1. Objectif du projet

XRent Manager est un SaaS de gestion de location de véhicules, multi-tenant (plusieurs organisations clientes isolées) et multi-agence (chaque tenant peut opérer plusieurs agences), avec un dashboard-admin. Voir [DEV_HANDOFF_REPORT.md](./DEV_HANDOFF_REPORT.md) section A pour le détail du périmètre métier et des rôles.

## 2. Technologies utilisées

Next.js (App Router) / React / TypeScript, Prisma + PostgreSQL, NextAuth (Auth.js v5), MFA TOTP (otplib), génération PDF (@react-pdf/renderer), tests HTTP via Vitest. Détail complet avec versions exactes : [DEV_HANDOFF_REPORT.md](./DEV_HANDOFF_REPORT.md) section B.

## 3. Commandes disponibles

| Commande | Effet |
|---|---|
| `npm run dev` | Démarre le serveur de développement (Next.js) |
| `npm run test` | Suite de tests Vitest — **à exécuter avant chaque Pull Request** |
| `npm run lint` | Lint ESLint |
| `npm run build` | Build de production |

Génération/migrations Prisma : `npx prisma generate`, `npx prisma migrate dev` (uniquement contre `xrent_test`, jamais `xrent_dev`).

## 4. Données et bases — règles absolues

- **Utilise exclusivement des données fictives/synthétiques.** Aucune donnée métier réelle n'existe sur ce projet à ce jour — voir CLAUDE.md règle 7.
- **`xrent_dev` est strictement interdite.** Ne t'y connecte jamais, ne l'utilise jamais pour développer ou tester, même en lecture. Utilise uniquement une base de test synthétique (`xrent_test` ou une base locale que tu crées toi-même à partir des migrations Prisma), configurée via tes propres variables d'environnement (`.env.local`/`.env.test`, jamais commitées).
- **Aucun secret de production n'existe ni ne doit être demandé.** Génère tes propres secrets locaux (`AUTH_SECRET`, `CRON_SECRET`, `MFA_ENCRYPTION_KEY`) avec `openssl rand -base64 32` — voir `.env.example` pour la liste des variables attendues (noms uniquement, aucune valeur réelle n'y figure).
- Ne recherche, n'utilise, ne réinitialise et ne réactive jamais un compte tiers qui apparaîtrait par autofill du navigateur sur `/login` — incident déjà documenté et définitivement hors périmètre.
- Ne lance jamais `scripts/reset-test-user-password.js`.

## 5. Workflow Git — obligatoire

- **Aucune modification directe sur `main`.** Travaille exclusivement sur une branche dédiée.
- **Pull Request obligatoire** pour toute modification, même minime — jamais de push direct sur `main`.
- Commits petits et cohérents, un objet clair par commit.
- **Teste chaque modification** (`npm run test`, `npm run lint`, `npx tsc --noEmit`) avant d'ouvrir une Pull Request — une PR dont la CI est rouge ne sera pas fusionnée.
- Toute migration Prisma doit être validée et testée contre `xrent_test` avant fusion — jamais appliquée directement sur une base partagée sans revue.

## 6. Signalement d'une anomalie

Ouvre une issue (ou décris-la dans ta Pull Request si elle est liée) avec : étapes de reproduction exactes, environnement utilisé, résultat attendu vs. résultat observé, preuve non sensible (capture, log — **sans jamais inclure de secret, mot de passe, token ou donnée personnelle**, même fictive si elle ressemble à une donnée réelle).

## 7. Procédure de retour arrière

Un tag de sauvegarde complet existe sur le commit de référence de cette collaboration : **`pre-collaboration-2026-09-18`**. En cas de besoin de revenir à cet état de référence :

```
git fetch --tags
git checkout pre-collaboration-2026-09-18
```

Ne jamais forcer un retour sur `main` (`git push --force`) sans autorisation explicite du propriétaire du projet.

## 8. En cas de doute

Toute question sur une règle métier, financière, de sécurité ou d'architecture non couverte ici : voir [DOMAINRULES.md](./DOMAINRULES.md), [SECURITY.md](./SECURITY.md), [ARCHITECTURE.md](./ARCHITECTURE.md). En cas d'ambiguïté persistante, ne tranche pas seul — demande au propriétaire du projet.
