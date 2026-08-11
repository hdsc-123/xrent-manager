/**
 * Port fixe et dédié aux tests d'intégration HTTP (distinct du port de dev habituel 3000)
 * afin de ne jamais entrer en conflit avec un `npm run dev` local en cours.
 */
export const TEST_PORT = 3811;
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;
