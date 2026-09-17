# Runbook — Validation manuelle du câblage UI du step-up MFA

Procédure de vérification manuelle en navigateur du parcours de step-up MFA câblé le 2026-09-17
(brief explicite du propriétaire du projet). **Nécessaire car ce dépôt ne dispose d'aucun
outillage de test automatisé capable d'exercer une interaction client réelle** — la suite de
tests (Vitest, HTTP contre un vrai serveur `next dev`) vérifie exhaustivement le comportement
serveur (11 routes, refus/acceptation/expiration/mauvaise session, code `STEP_UP_REQUIRED`, voir
`src/__tests__/mfa-step-up-gating.test.ts`), mais ne peut jamais ouvrir une modale, y saisir un
code, ni vérifier qu'une action est effectivement rejouée après succès (voir `ui.test.tsx` :
« pas de jsdom/@testing-library ici »). Cette procédure comble précisément cet écart assumé.

## 1. Avant de commencer

- Environnement de développement ou de test uniquement (`xrent_dev`/`xrent_test` locales) —
  **jamais de compte réel, jamais `saadscott123@gmail.com`** (CLAUDE.md règle 11).
- Un compte de test ADMIN avec la MFA déjà activée (TOTP enrôlé) est nécessaire pour tout
  scénario « refus/acceptation » — voir la campagne QA existante (`TEST_XRENT`) ou un compte
  synthétique dédié (`docs/runbooks/campagne-validation-qa.md`).
- Vérifier `git status --short` avant de commencer.

## 2. Scénarios à valider (un par action gardée)

Pour chacune des **8 routes disposant d'une interface** (voir tableau ci-dessous), reproduire le
même schéma générique :

1. Se connecter avec un compte ADMIN ayant la MFA activée.
2. Déclencher l'action depuis l'interface normale (bouton/formulaire existant, inchangé).
3. **Attendu** : la modale « Vérification de sécurité requise » s'ouvre automatiquement — le
   reste de la page reste inchangé derrière elle.
4. Saisir le code TOTP courant de l'application d'authentification, cliquer **Confirmer**.
5. **Attendu** : la modale se ferme, l'action originale s'exécute réellement (toast de succès,
   données à jour) — sans que l'utilisateur ait besoin de recliquer sur le bouton d'origine.

| # | Route | Déclencheur UI | Page |
|---|---|---|---|
| 1 | `DELETE /api/audit/[id]` | Icône corbeille sur une ligne | `/dashboard/audit` |
| 2 | `POST /api/audit/bulk-delete` | Sélection multiple → suppression groupée | `/dashboard/audit` |
| 3 | `POST /api/audit/purge` | Bouton « Purger le journal », saisie du nom du tenant | `/dashboard/audit` |
| 4 | `PATCH /api/cash-register/[id]` | Modifier une écriture/dépense manuelle | `/dashboard/cash-register/entries` et `.../expenses` |
| 5 | `DELETE /api/cash-register/[id]` | Supprimer une écriture/dépense manuelle | idem |
| 6 | `POST /api/damage-invoices/[id]/cancel` | Bouton « Annuler », motif obligatoire | `/dashboard/damage-invoices/[id]` |
| 7 | `POST /api/data-reset` | Bouton « Réinitialiser », saisie du nom du tenant | `/dashboard/settings` |
| 8 | `PATCH /api/users/[id]` (changement de rôle) | Modifier le rôle d'un utilisateur | `/dashboard/users/[id]` |
| 9 | `PATCH /api/users/[id]/permissions` | Modifier le groupe/les permissions individuelles | `/dashboard/users/[id]/permissions` |

*(Numérotation à 9 lignes pour 8 routes : caisse compte 2 fichiers/2 actions sur la même route.)*

## 3. Scénarios transverses (à valider une fois, sur une route représentative — ex. reset de données)

- **Annulation** : ouvrir la modale, cliquer **Annuler** → elle se ferme, **aucune donnée n'est
  modifiée**, aucun toast de succès, l'action reste abandonnée (pas de nouvelle tentative
  automatique).
- **Fermeture sans annuler explicitement** (touche Échap, clic hors de la modale) → même résultat
  que « Annuler » — aucune relance.
- **Code invalide** : saisir un code à 6 chiffres incorrect → message d'erreur générique affiché
  **dans la modale** (jamais « code invalide » distinct de « code expiré », comportement serveur
  déjà garanti) ; la modale reste ouverte, un nouvel essai est possible sans refermer.
- **Double soumission** : cliquer plusieurs fois rapidement sur « Confirmer » → **un seul appel
  réseau** `POST /api/mfa/step-up/verify`, et **une seule relance** de l'action métier originale.
  Protégé par une garde synchrone dédiée (`src/lib/single-flight-guard.ts`, `useRef` dans
  `StepUpDialog.tsx`), vérifiée et activée en tout premier dans le gestionnaire de soumission —
  avant tout `setState` et avant tout `await`. **Ne pas confondre avec `isSubmitting`** (état
  React, mis à jour de façon asynchrone/batchée) : celui-ci ne sert qu'à l'affichage (bouton
  désactivé, libellé « Vérification... ») et, seul, ne suffisait pas à bloquer deux appels
  déclenchés quasi simultanément — c'est exactement l'écart trouvé et corrigé le 2026-09-17 (voir
  SECURITY.md section 53.1, TESTREPORT.md section 9). Pour reproduire fidèlement le cas le plus
  strict en navigateur (deux clics natifs dans le même tick JS, plus rapide qu'un double-clic
  humain réel), utiliser la console DevTools : sélectionner le bouton « Confirmer » puis appeler
  `element.click(); element.click();` en une seule expression — observer ensuite l'onglet Réseau
  pour confirmer un seul `POST /api/mfa/step-up/verify` et un seul appel de relance vers la route
  métier gardée.
- **Preuve déjà valide (step-up récent < 10 min)** : après un premier succès, déclencher une
  **autre** action gardée dans la foulée → **aucune modale ne réapparaît** (la preuve reste
  valide pour la session, comportement serveur inchangé).
- **Expiration** : attendre plus de 10 minutes après un step-up réussi, puis déclencher une
  action gardée → la modale réapparaît (nouvelle preuve exigée), comportement serveur déjà
  couvert automatiquement (`src/__tests__/mfa-step-up-gating.test.ts`, « refuse une preuve
  expirée ») — vérification manuelle optionnelle, à faire une seule fois si le temps le permet.
- **403 ordinaire, sans rapport avec le step-up** (ex. tenter une action réservée ADMIN avec un
  compte MEMBER) → **aucune modale ne doit apparaître**, le message d'erreur habituel s'affiche
  normalement (toast).

## 4. Ce qui ne doit jamais être observé

- Un code TOTP visible dans la console navigateur (DevTools) ou dans un journal quelconque.
- Une action exécutée sans que la modale ait été validée avec succès au préalable.
- Une action rejouée plus d'une fois après un seul succès de step-up (pas de boucle visible,
  pas de double toast de succès).
- La modale s'ouvrant pour un 403 qui n'a rien à voir avec la MFA (permission/tenant/agence).

## 5. Après la campagne

- Documenter les résultats dans un nouveau fichier `docs/test-reports/<date>-step-up-mfa-manual-qa.md`
  (même convention que la campagne QA existante — jamais directement dans TESTREPORT.md, y
  ajouter seulement une ligne d'index).
- Tout écart trouvé : consigner dans INCIDENTS.md selon le gabarit standard, corriger avant de
  considérer le câblage validé.
- Ne jamais conserver de code TOTP, mot de passe ou secret dans le rapport produit.
